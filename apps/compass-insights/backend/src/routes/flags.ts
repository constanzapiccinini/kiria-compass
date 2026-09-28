/**
 * The compliance review queue — §5, §7 screen 5.
 *
 * The flagging itself runs in the Compass AI worker (`insight_flag`), where the model
 * client and the job queue already live. This module is the other half: the queue a
 * person opens, and the one write this app makes.
 *
 * ---------------------------------------------------------------------------
 * Why this is the only writing module in the app
 *
 * §5: `compass-insights` "reads and it manages queues". Everything in `metrics.ts` is
 * a read. A review decision is not — it is a person recording a judgement about a
 * possible adverse event, and it is the one thing here that has to be attributable
 * afterwards. Keeping it in its own file makes "what can this app change?" a question
 * with a one-file answer.
 *
 * ---------------------------------------------------------------------------
 * Verbatim question text is allowed here, and why that is not a §2 exception
 *
 * §2 draws the line at scope, not at sensitivity: "Client-scoped screens may show
 * questions in full to KIRIA staff. Org-scoped screens may show only labels,
 * summaries and counts."
 *
 * A flag is client-scoped by construction — `review_flags.client_id` is `NOT NULL` and
 * references exactly one account — so every row this returns carries its own client.
 * A reviewer cannot judge "is this an adverse event" from a label, and a queue that
 * showed summaries would be a queue that gets rubber-stamped. So the full question is
 * returned, along with the answer the client was given, because "we told them X" is
 * usually the more consequential half.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does not do
 *
 * §5: "Never notifies the client, never reports anywhere automatically, never blocks
 * the answer." There is no notify route, no export, no webhook. §7 puts it more
 * sharply for the decision itself: "Escalation is a human deciding, not a webhook."
 * Escalation here is a status a person sets with a note, and nothing downstream of it
 * fires. If escalation later needs to reach someone, that is a person reading this
 * screen and picking up the phone — which is the correct latency for a decision this
 * size, and the only one that leaves a name attached.
 */

import { Hono } from 'hono'
import { HttpError, isUuid } from '../lib/auth.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { orgId } from '../lib/config.js'
import { recordAudit } from '../lib/observability.js'
import {
  query,
  queryOne,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  updateRows,
} from '../lib/store.js'

export const flagsRoutes = new Hono()

/** Statuses a person may move a flag to. `new` is the model's, not theirs. */
const DECIDED = new Set(['reviewed', 'dismissed', 'escalated'])

/** Every status, for filtering. */
const ALL_STATUSES = ['new', 'reviewed', 'dismissed', 'escalated'] as const

type FlagStatus = (typeof ALL_STATUSES)[number]

const DEFAULT_LIMIT = 100

/**
 * The queue.
 *
 * Defaults to `new` because the default view of a review queue is the part not yet
 * reviewed; the decided rows stay reachable so a dismissal can be looked up later,
 * which is the entire point of recording who made it.
 *
 * `byStatus` is returned alongside so the screen can show "3 waiting" without a second
 * round trip, and so an empty list is distinguishable from an empty table — the
 * difference between "nothing to review" and "nothing has ever been screened".
 */
flagsRoutes.get('/', async (c) => {
  await requireAdmin(c)

  const statusParam = c.req.query('status') ?? 'new'
  if (statusParam !== 'all' && !ALL_STATUSES.includes(statusParam as FlagStatus)) {
    throw new HttpError(
      400,
      `status must be 'all' or one of ${ALL_STATUSES.join(', ')}`,
      'BAD_REQUEST',
    )
  }

  const clientId = c.req.query('clientId')
  if (clientId !== undefined && !isUuid(clientId)) {
    throw new HttpError(400, 'clientId must be a UUID', 'BAD_REQUEST')
  }

  // Built as a pair of optional predicates rather than string-concatenated values.
  // Every filter below is a bound parameter; the only interpolation is the limit,
  // which is a constant.
  const filters: string[] = []
  const params: string[] = []
  if (statusParam !== 'all') {
    params.push(statusParam)
    filters.push(`f.status = $${params.length}`)
  }
  if (clientId !== undefined) {
    params.push(clientId)
    filters.push(`f.client_id = $${params.length}`)
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

  const rows = await query(
    `SELECT f.id,
            f.code,
            f.confidence,
            f.status,
            f.notes,
            f.model,
            f.prompt_version,
            f.created_at,
            f.reviewed_by_user_id,
            f.reviewed_at,
            f.client_id,
            cl.name           AS client_name,
            m.content         AS question,
            m.created_at      AS asked_at,
            m.chat_id,
            a.content         AS answer,
            a.grounded        AS answer_grounded
       FROM review_flags f
       JOIN clients cl       ON cl.id = f.client_id
       JOIN chat_messages m  ON m.id = f.message_id
       -- The reply the client actually received. LEFT, because a question flagged
       -- before its answer was written has no reply yet and must still be reviewable.
       LEFT JOIN LATERAL (
         SELECT content, grounded
           FROM chat_messages
          WHERE chat_id = m.chat_id
            AND role = 'assistant'
            AND created_at > m.created_at
          ORDER BY created_at ASC
          LIMIT 1
       ) a ON TRUE
       ${where}
      ORDER BY (f.status = 'new') DESC, f.created_at DESC
      LIMIT ${DEFAULT_LIMIT}`,
    params,
  )

  const counts = await query(
    `SELECT status, COUNT(*)::INT AS total FROM review_flags GROUP BY status`,
  )

  const byStatus: Record<string, number> = {}
  for (const status of ALL_STATUSES) byStatus[status] = 0
  for (const row of counts) byStatus[readString(row, 'status')] = readNumber(row, 'total')

  // How far the screen has got through the history, which a queue claiming to catch
  // adverse events should be able to state rather than imply. `flag_screened_at`
  // (0025) is what makes it answerable.
  const progress = await queryOne(
    `SELECT COUNT(*) FILTER (WHERE m.flag_screened_at IS NOT NULL)::INT AS screened,
            COUNT(*)::INT AS eligible
       FROM chat_messages m
       JOIN chats ch ON ch.id = m.chat_id
       JOIN clients c ON c.id = ch.client_id
      WHERE m.role = 'user'
        AND c.analytics_opt_out = FALSE`,
  )

  return c.json({
    status: statusParam,
    byStatus,
    screening: {
      screened: progress ? readNumber(progress, 'screened') : 0,
      eligible: progress ? readNumber(progress, 'eligible') : 0,
    },
    flags: rows.map((row) => ({
      flagId: readString(row, 'id'),
      code: readString(row, 'code'),
      confidence: readOptionalNumber(row, 'confidence'),
      status: readString(row, 'status'),
      notes: readOptionalString(row, 'notes'),
      // Which classifier said so. Two flags produced by different prompt versions are
      // not the same evidence, and a reviewer comparing them should be able to see it.
      model: readString(row, 'model'),
      promptVersion: readString(row, 'prompt_version'),
      createdAt: readString(row, 'created_at'),
      reviewedBy: readOptionalString(row, 'reviewed_by_user_id'),
      reviewedAt: readOptionalString(row, 'reviewed_at'),
      clientId: readString(row, 'client_id'),
      clientName: readString(row, 'client_name'),
      chatId: readString(row, 'chat_id'),
      question: readString(row, 'question'),
      askedAt: readString(row, 'asked_at'),
      answer: readOptionalString(row, 'answer'),
      answerGrounded: row.answer_grounded === null ? null : Boolean(row.answer_grounded),
    })),
  })
})

/**
 * Decide one flag.
 *
 * The reviewer and the timestamp are written here and are **not** taken from the
 * request: a client that could name the reviewer is a client that could name someone
 * else. `review_flags_decided_by_a_person` (0024) enforces the same thing at the
 * database, so a future handler that forgets is refused rather than accepted.
 *
 * A flag cannot be moved back to `new`. "Undecided again" is not a state a compliance
 * record should be able to reach — the honest way to change a decision is to make a
 * different one, which keeps the reviewer and the time attached to it.
 */
flagsRoutes.patch('/:flagId', async (c) => {
  const actor = await requireAdmin(c)

  const flagId = c.req.param('flagId')
  if (!isUuid(flagId)) throw new HttpError(400, 'flagId must be a UUID', 'BAD_REQUEST')

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'Expected a JSON body', 'BAD_REQUEST')
  }
  const payload = body as { status?: unknown; notes?: unknown }

  if (typeof payload.status !== 'string' || !DECIDED.has(payload.status)) {
    throw new HttpError(
      400,
      `status must be one of ${[...DECIDED].join(', ')} — a flag cannot be returned to 'new'`,
      'BAD_REQUEST',
    )
  }
  const status = payload.status

  if (payload.notes !== undefined && payload.notes !== null && typeof payload.notes !== 'string') {
    throw new HttpError(400, 'notes must be a string', 'BAD_REQUEST')
  }
  const notes =
    typeof payload.notes === 'string' && payload.notes.trim().length > 0
      ? payload.notes.trim().slice(0, 2000)
      : null

  // Escalation without a reason is the one decision that is useless later: "somebody
  // escalated this and we do not know what they saw" is worse than not having the row.
  if (status === 'escalated' && notes === null) {
    throw new HttpError(400, 'An escalation needs a note saying why', 'NOTE_REQUIRED')
  }

  const existing = await queryOne(
    `SELECT id, client_id, code, status FROM review_flags WHERE id = $1`,
    [flagId],
  )
  if (!existing) throw new HttpError(404, 'No such flag', 'NOT_FOUND')

  const updated = await updateRows(
    'review_flags',
    {
      status,
      notes,
      reviewed_by_user_id: actor.userId,
      reviewed_at: new Date().toISOString(),
    },
    [{ column: 'id', operator: 'eq', value: flagId }],
  )
  if (updated === 0) throw new HttpError(404, 'No such flag', 'NOT_FOUND')

  await recordAudit({
    orgId: orgId(),
    clientId: readString(existing, 'client_id'),
    actorUserId: actor.userId,
    action: 'review_flag.decided',
    targetType: 'review_flag',
    targetId: flagId,
    // The previous status is recorded because the row itself only ever shows the
    // latest one: a flag escalated and then dismissed reads as "dismissed", and the
    // sequence is the part that would matter.
    metadata: {
      from: readString(existing, 'status'),
      to: status,
      code: readString(existing, 'code'),
      hasNote: notes !== null,
    },
  })

  return c.json({ flagId, status, notes, reviewedBy: actor.userId })
})
