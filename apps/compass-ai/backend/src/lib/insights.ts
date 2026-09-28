/**
 * Conversation intelligence — the two 8A jobs and the identity hash (Phase 8).
 *
 * ---------------------------------------------------------------------------
 * Why this lives in the client app's backend
 *
 * §5, and it is the load-bearing decision of the phase: this backend already owns the
 * pipeline, the queue, the cron and the OpenAI client. `compass-insights` will read
 * and manage queues and contain **no pipeline code at all** — which is what keeps a
 * third app from becoming a third copy of helpers that have already caused two
 * production incidents here.
 *
 * So the analysis runs where the machinery is, as new `ingest_jobs` kinds, and the
 * insights app never grows an embedding call.
 *
 * ---------------------------------------------------------------------------
 * Opt-out is checked in the query, not around it
 *
 * §2's `analytics_opt_out` is honoured by every job **inside the SQL that selects the
 * work**, never as an `if` around a loop. A filter that lives in the WHERE clause
 * cannot be forgotten by a later caller, and §8 asks to assert opt-out by counting
 * rows rather than by the absence of a screen — which only holds if the rows were
 * never created.
 *
 * ---------------------------------------------------------------------------
 * What 8A deliberately does not do
 *
 * No clustering, no flagging, no themes. §9 puts those in 8C and 8D and puts this
 * first for one reason: themes need history, and the sooner questions are embedded the
 * sooner 8C has something to say. Production holds fourteen messages today, so a
 * clustering job written now would have nothing to cluster and no way to be wrong
 * visibly.
 */

import { createHmac, randomUUID } from 'node:crypto'
import { CHAT_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './config.js'
import { createChatCompletion, createEmbeddings } from './openai.js'
import {
  clusterByThreshold,
  MAX_CLUSTERS_PER_RUN,
  type ClusterItem,
} from './clustering.js'
import { logStep, recordUsage } from './observability.js'
import {
  deleteRows,
  insertRow,
  query,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  updateRows,
} from './store.js'

/** How many questions one `insight_embed` run will embed. */
const EMBED_BATCH_SIZE = 96
/** How many questions one run will take in total, so a backfill is paced. */
const EMBED_RUN_LIMIT = 480

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * The per-client salt, generated on first use.
 *
 * Read-then-write rather than an upsert because there is no natural conflict target
 * here, and the race is benign: two concurrent first uses can both generate, one wins
 * the UPDATE, and the loser re-reads. The filter `analytics_user_salt IS NULL` is what
 * makes that true — without it the second writer would overwrite a salt already used
 * for real hashes, silently splitting one person into two.
 */
async function clientSalt(clientId: string): Promise<string> {
  const existing = await queryOne(
    'SELECT analytics_user_salt FROM clients WHERE id = $1',
    [clientId],
  )
  if (!existing) throw new Error(`no client ${clientId}`)

  const current = readOptionalString(existing, 'analytics_user_salt')
  if (current !== null && current.length > 0) return current

  const salt = randomUUID()
  await updateRows('clients', { analytics_user_salt: salt }, [
    { column: 'id', operator: 'eq', value: clientId },
    { column: 'analytics_user_salt', operator: 'is_null', value: null },
  ])

  const settled = await queryOne(
    'SELECT analytics_user_salt FROM clients WHERE id = $1',
    [clientId],
  )
  const written = settled ? readOptionalString(settled, 'analytics_user_salt') : null
  return written !== null && written.length > 0 ? written : salt
}

/**
 * A user id as it is allowed to appear in an analysis row.
 *
 * HMAC-SHA256 keyed by the client's own salt, so the same person is stable **within**
 * one client and unlinkable **across** clients — which is the property that stops the
 * analysis tables becoming a cross-account identity graph.
 *
 * "Which person asked this" stays answerable in `audit_logs`, where it belongs and
 * where reading it leaves a trace. §2 is explicit that mixing the two is how a usage
 * dashboard becomes a surveillance tool, and the hash is the mechanism that keeps them
 * apart rather than a note asking people not to.
 */
export async function hashUser(clientId: string, userId: string): Promise<string> {
  const salt = await clientSalt(clientId)
  return createHmac('sha256', salt).update(userId).digest('hex')
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export type InsightRunKind = 'embed' | 'cluster' | 'flag' | 'rollup' | 'purge'

/**
 * Open a run row, then close it either way.
 *
 * Every analysis run is recorded, including the ones that fail — a failure with no row
 * is indistinguishable from a job that never ran, which is the same reasoning behind
 * `portal_reconcile_runs` in 0017. The `insight_runs_failure_has_error` CHECK means a
 * failed row cannot be written without a cause, so this cannot record a shrug.
 *
 * A failed run also raises `INSIGHT_RUN_FAILED` through the existing alert path (§5).
 * Imported dynamically for the same reason the worker does it: `alerts.ts` reaches back
 * into the pipeline, and a static import here would close a cycle.
 */
export async function withInsightRun<T extends Record<string, unknown>>(
  kind: InsightRunKind,
  run: () => Promise<T>,
): Promise<T | null> {
  const started = await insertRow('insight_runs', { kind, status: 'running' }, ['id'])
  const runId = started ? readString(started, 'id') : null

  try {
    const counts = await run()
    if (runId) {
      await updateRows(
        'insight_runs',
        { status: 'succeeded', counts: JSON.stringify(counts), finished_at: new Date().toISOString() },
        [{ column: 'id', operator: 'eq', value: runId }],
      )
    }
    logStep('insight.run_succeeded', { kind, runId, ...counts })

    // A recovered run closes its own alert. Without this the inbox keeps an
    // `INSIGHT_RUN_FAILED` for a run that has since worked — and an alert that stays
    // open after the problem is gone is how an inbox stops being read. Resolved from
    // state, the same shape as the portal alerts: the argument triple must match the
    // raise exactly, because `resolveAlerts` recomputes the dedupe key from it.
    try {
      const { resolveAlerts } = await import('./alerts.js')
      await resolveAlerts({ code: 'INSIGHT_RUN_FAILED', clientId: null, dedupeExtra: kind })
    } catch (resolveError) {
      logStep('insight.resolve_failed', {
        kind,
        error: resolveError instanceof Error ? resolveError.message : String(resolveError),
      })
    }

    return counts
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    if (runId) {
      await updateRows(
        'insight_runs',
        { status: 'failed', last_error: cause.slice(0, 2000), finished_at: new Date().toISOString() },
        [{ column: 'id', operator: 'eq', value: runId }],
      )
    }
    logStep('insight.run_failed', { kind, runId, error: cause })

    try {
      const { raiseAlert } = await import('./alerts.js')
      await raiseAlert({
        code: 'INSIGHT_RUN_FAILED',
        clientId: null,
        cause: `The ${kind} analysis run failed: ${cause.slice(0, 400)}`,
        remediationDetail: runId === null ? undefined : `Run id: ${runId}.`,
        // Per kind, so a failing embed run does not hide a failing purge run behind
        // one already-open alert.
        dedupeExtra: kind,
      })
    } catch (alertError) {
      // An alert that cannot be raised must not turn a reported failure into an
      // unreported one: the run row is already written and is the record that matters.
      logStep('insight.alert_failed', {
        kind,
        error: alertError instanceof Error ? alertError.message : String(alertError),
      })
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// insight_embed
// ---------------------------------------------------------------------------

/**
 * Embed user questions that have no embedding yet (§3).
 *
 * A question is roughly twenty tokens, so embedding every question ever asked costs
 * less than indexing one Compass PDF — which is why this is unconditional rather than
 * gated on a budget. It is still capped per run so a first backfill over a large
 * history is paced across the sweep rather than done in one call.
 *
 * The selection is the governance: `analytics_opt_out = FALSE` and `role = 'user'` are
 * in the WHERE clause, so an opted-out client's questions are never read, let alone
 * sent to OpenAI. **Assistant answers are deliberately not embedded** — the phase's
 * four questions are all about what was *asked*, and embedding the answers would
 * double the cost to cluster the material against itself.
 *
 * Cost is metered through `recordUsage` like every other model call, charged to the
 * client whose question it was, so the insights spend shows up in the same place as
 * the ingestion spend rather than as an unexplained line.
 */
export async function runInsightEmbed(): Promise<{ embedded: number; skipped: number }> {
  const pending = await query(
    `SELECT m.id, m.content, ch.client_id
       FROM chat_messages m
       JOIN chats ch ON ch.id = m.chat_id
       JOIN clients c ON c.id = ch.client_id
      WHERE m.role = 'user'
        AND c.analytics_opt_out = FALSE
        AND NOT EXISTS (SELECT 1 FROM question_embeddings q WHERE q.message_id = m.id)
      ORDER BY m.created_at ASC
      LIMIT ${EMBED_RUN_LIMIT}`,
  )

  if (pending.length === 0) return { embedded: 0, skipped: 0 }

  let embedded = 0
  let skipped = 0

  for (let offset = 0; offset < pending.length; offset += EMBED_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + EMBED_BATCH_SIZE)
    const texts = batch.map((row) => readString(row, 'content').slice(0, 4000))
    const result = await createEmbeddings(texts)

    for (let index = 0; index < batch.length; index += 1) {
      const vector = result.vectors[index]
      if (!vector) {
        // A missing vector is not an error to abort the run over: the row simply has
        // no embedding yet and the next run picks it up. Counted so a persistent gap
        // shows up in the run log instead of looking like there was no work.
        skipped += 1
        continue
      }
      await insertRow(
        'question_embeddings',
        {
          message_id: readString(batch[index], 'id'),
          client_id: readString(batch[index], 'client_id'),
          // The raw array, not `JSON.stringify`. The "pass JSON as a string" rule in
          // the isolated-SQL contract is about **JSONB** columns; this is
          // `DOUBLE PRECISION[]`, which the structured row API takes natively — as
          // `document_chunks.embedding` has done since 0001. Stringifying it produced
          // a 400 from Gate that surfaced as a failed run on the first production
          // sweep. (`insight_runs.counts` above IS jsonb, so it is stringified.)
          embedding: vector,
          model: EMBEDDING_MODEL,
          dims: EMBEDDING_DIMENSIONS,
        },
        ['message_id'],
      )
      embedded += 1
    }

    // Charged per client rather than once for the batch, because a batch spans
    // clients and an unattributable cost is one nobody can act on.
    const perClient = new Map<string, number>()
    for (const row of batch) {
      const clientId = readString(row, 'client_id')
      perClient.set(clientId, (perClient.get(clientId) ?? 0) + 1)
    }
    for (const [clientId, count] of perClient) {
      await recordUsage({
        kind: 'embedding',
        model: EMBEDDING_MODEL,
        clientId,
        inputTokens: Math.round((result.usage.inputTokens * count) / batch.length),
        outputTokens: 0,
        metadata: { via: 'insight_embed' },
      })
    }
  }

  return { embedded, skipped }
}

// ---------------------------------------------------------------------------
// insight_purge
// ---------------------------------------------------------------------------

/**
 * Delete conversations past their client's `retention_days` (§6).
 *
 * **This is the job that makes an existing promise true.** `retention_days` could be
 * set per client, was validated, was audited — and nothing had ever deleted a row.
 * §6's instruction is to make it real or stop offering it.
 *
 * Every client is `NULL` today, which means keep forever, so the first run deletes
 * nothing. That is deliberate: choosing a number is a policy decision and §10.2 leaves
 * it open. What changes here is that setting one now has an effect.
 *
 * ## What happens to derived rows, decided explicitly
 *
 * §6 asks for this in writing rather than as a discovery a year later:
 *
 *   - `question_embeddings`, `insight_theme_members` and `review_flags` **cascade** —
 *     they reference the message and are meaningless without it.
 *   - `insight_themes` **survive**, because they are aggregates. "We deleted your
 *     conversations and kept the themes" is defensible, and it is a documented
 *     decision taken on this line rather than an emergent property.
 *   - `sample_message_ids` is **scrubbed** of ids that no longer exist. It is a UUID[]
 *     with no foreign key, so nothing cascades it, and a client screen showing blanks
 *     where samples used to be looks like a bug rather than like retention working.
 *
 * Chats are deleted after their messages so an interrupted run leaves an empty chat
 * rather than a message with no chat — the first renders as an empty conversation, the
 * second is a row no query can reach.
 */
export async function runInsightPurge(): Promise<{
  clients: number
  chats: number
  messages: number
  themesScrubbed: number
}> {
  const clients = await query(
    `SELECT id, name, retention_days FROM clients
      WHERE retention_days IS NOT NULL
      ORDER BY name`,
  )

  let chatsDeleted = 0
  let messagesDeleted = 0
  let clientsTouched = 0

  for (const row of clients) {
    const clientId = readString(row, 'id')
    const days = readNumber(row, 'retention_days')

    // Selected first, so the count is of rows that existed rather than of rows the
    // delete claims to have touched — and so an interrupted run is auditable.
    const stale = await query(
      `SELECT ch.id
         FROM chats ch
        WHERE ch.client_id = $1
          AND ch.last_message_at IS NOT NULL
          AND ch.last_message_at < now() - ($2 || ' days')::INTERVAL`,
      [clientId, String(days)],
    )
    if (stale.length === 0) continue

    clientsTouched += 1
    for (const chat of stale) {
      const chatId = readString(chat, 'id')
      messagesDeleted += await deleteRows('chat_messages', [
        { column: 'chat_id', operator: 'eq', value: chatId },
      ])
      chatsDeleted += await deleteRows('chats', [
        { column: 'id', operator: 'eq', value: chatId },
      ])
    }

    logStep('insight.purged', { clientId, retentionDays: days, chats: stale.length })
  }

  // Scrubbed unconditionally, not only when something was deleted: a sample id can
  // also be orphaned by a document delete cascading its messages, and this is the one
  // job that looks.
  const themesScrubbed = messagesDeleted === 0 ? 0 : await scrubThemeSamples()

  return {
    clients: clientsTouched,
    chats: chatsDeleted,
    messages: messagesDeleted,
    themesScrubbed,
  }
}

/**
 * A Postgres `uuid[]` literal, built only from values that really are UUIDs.
 *
 * `SqlParam` is `string | number | boolean | null`, so an array cannot be passed as a
 * parameter and has to be rendered as `{a,b,c}`. That is string-building into SQL by
 * another name, so every element is checked against the UUID shape first and anything
 * else is dropped rather than escaped: these ids come from a `UUID[]` column, so a
 * non-UUID here means something is already wrong and quietly widening the query is the
 * worst response to it.
 */
function uuidArrayLiteral(ids: readonly string[]): string {
  const safe = ids.filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  )
  return `{${safe.join(',')}}`
}

/**
 * Remove sample message ids that no longer point at a message.
 *
 * Read-modify-write rather than one clever UPDATE, because the structured row API
 * takes values rather than expressions and this is a handful of rows on a nightly
 * job. If themes ever number in the thousands this becomes a single statement through
 * `executeIsolatedStoreSql` — measured, not assumed.
 */
async function scrubThemeSamples(): Promise<number> {
  const themes = await query(
    `SELECT t.id, t.sample_message_ids
       FROM insight_themes t
      WHERE t.sample_message_ids <> '{}'::UUID[]`,
  )

  let scrubbed = 0
  for (const theme of themes) {
    const raw = theme.sample_message_ids
    const ids = Array.isArray(raw) ? raw.map((value) => String(value)) : []
    if (ids.length === 0) continue

    const alive = await query(
      `SELECT id FROM chat_messages WHERE id = ANY($1::UUID[])`,
      [uuidArrayLiteral(ids)],
    )
    const aliveIds = new Set(alive.map((row) => readString(row, 'id')))
    const kept = ids.filter((id) => aliveIds.has(id))
    if (kept.length === ids.length) continue

    await updateRows(
      'insight_themes',
      { sample_message_ids: uuidArrayLiteral(kept) },
      [{ column: 'id', operator: 'eq', value: readString(theme, 'id') }],
    )
    scrubbed += 1
  }
  return scrubbed
}

// ---------------------------------------------------------------------------
// insight_cluster
// ---------------------------------------------------------------------------

/**
 * The label prompt's version, recorded on every theme row.
 *
 * Bump it whenever the prompt, the model or the threshold changes. §5 asks for it so
 * two months are comparable — and the honest use of it is the opposite of what it
 * sounds like: a theme row carrying `v1` and one carrying `v2` are **not** comparable,
 * and this is the field that says so instead of letting a chart imply they are.
 *
 * The threshold is in the string because it changes what a cluster *is*, as much as
 * the prompt changes what it is called.
 */
const CLUSTER_PROMPT_VERSION = 'cluster-v1-t0.40'

/** How many member questions the label prompt sees. Enough to name a theme. */
const LABEL_SAMPLE = 12
/** Sample ids kept on a client theme, so a screen can show the questions behind it. */
const SAMPLE_IDS = 5

/**
 * Ask for a label and a one-line summary for one cluster of questions.
 *
 * One completion per cluster, capped by `MAX_CLUSTERS_PER_RUN`. The prompt is
 * deliberately narrow: naming a group of questions is the whole task, and a model given
 * room to editorialise produces theme names that read like advice.
 *
 * A malformed response falls back to a label built from the questions themselves rather
 * than failing the run. A theme called by its first question is worse than a good label
 * and much better than no theme — and a clustering run that dies because one completion
 * came back without a colon is a run nobody trusts.
 */
async function labelCluster(
  questions: readonly string[],
): Promise<{ label: string; summary: string; usage: { inputTokens: number; outputTokens: number } }> {
  const sample = questions.slice(0, LABEL_SAMPLE)
  const result = await createChatCompletion(
    [
      {
        role: 'system',
        content:
          'You name groups of related questions asked by pharmaceutical clients of an ' +
          'advisory firm. Reply with exactly two lines:\n' +
          'LABEL: a noun phrase of at most six words naming what these questions are about\n' +
          'SUMMARY: one sentence, at most 30 words, saying what the group is asking for\n' +
          'Do not answer the questions. Do not suggest what to write. Name only what is ' +
          'there.',
      },
      { role: 'user', content: sample.map((question) => `- ${question}`).join('\n') },
    ],
    200,
  )

  const label = /LABEL:\s*(.+)/i.exec(result.text)?.[1]?.trim()
  const summary = /SUMMARY:\s*(.+)/i.exec(result.text)?.[1]?.trim()

  return {
    label: (label ?? sample[0] ?? 'Unlabelled').slice(0, 120),
    summary: (summary ?? `${sample.length} related question(s).`).slice(0, 500),
    usage: result.usage,
  }
}

/**
 * Cluster each client's questions for a period and label the groups — §5, §7 screen 3.
 *
 * ## Per client only
 *
 * §5 describes "nightly per client, monthly per org". Only the per-client half is here.
 * §2 permits it outright — client-scoped screens may show questions in full to KIRIA
 * staff — while a cross-client theme is gated on a question no code can answer: what
 * the MSAs say about use of client data, and a line in the portal telling clients their
 * conversations are reviewed.
 *
 * The org half is therefore **not written at all**, rather than written and switched
 * off. An unreachable branch waiting on a legal answer is the exact trap this codebase
 * has paid for three times. The schema is ready and proven; when the answer comes, the
 * work is a second pass over the same functions.
 *
 * ## Idempotent per period
 *
 * A run for a period replaces that period's themes for that client. Without it a second
 * run doubles every theme, and on a screen whose whole job is ranking by frequency that
 * reads as "asked twice as often" — the most misleading failure available here. 0023's
 * unique index is the backstop; the delete is the mechanism.
 *
 * ## Opt-out, and dimension safety
 *
 * `analytics_opt_out` is in the WHERE clause. Vectors are filtered on `dims` in SQL
 * too: mixing two vector spaces in one cosine comparison produces clusters that look
 * plausible and mean nothing, and `question_embeddings.dims` exists precisely so that
 * cannot happen silently after a model change.
 */
export async function runInsightCluster(): Promise<{
  clients: number
  themes: number
  questions: number
  skippedClients: number
}> {
  // The window: whole months, so a period is a thing a person can name. `period_start`
  // and `period_end` on the row are what make two runs comparable at all.
  const [period] = await query(
    `SELECT to_char(date_trunc('month', now()), 'YYYY-MM-DD') AS period_start,
            to_char((date_trunc('month', now()) + INTERVAL '1 month - 1 day'), 'YYYY-MM-DD')
              AS period_end`,
  )
  const periodStart = readString(period, 'period_start')
  const periodEnd = readString(period, 'period_end')

  const clients = await query(
    `SELECT c.id, c.name
       FROM clients c
      WHERE c.analytics_opt_out = FALSE
        AND EXISTS (
          SELECT 1
            FROM question_embeddings q
            JOIN chats ch ON ch.id = (SELECT m.chat_id FROM chat_messages m WHERE m.id = q.message_id)
           WHERE ch.client_id = c.id
        )
      ORDER BY c.name`,
  )

  let themesWritten = 0
  let questionsClustered = 0
  let clientsProcessed = 0
  let skippedClients = 0

  for (const client of clients) {
    const clientId = readString(client, 'id')

    const rows = await query(
      `SELECT q.message_id, q.embedding, q.dims, m.content
         FROM question_embeddings q
         JOIN chat_messages m ON m.id = q.message_id
         JOIN chats ch ON ch.id = m.chat_id
        WHERE ch.client_id = $1
          AND q.dims = $2
          AND m.created_at >= $3::DATE
          AND m.created_at < ($4::DATE + INTERVAL '1 day')
        ORDER BY q.message_id`,
      [clientId, EMBEDDING_DIMENSIONS, periodStart, periodEnd],
    )

    const items: ClusterItem[] = []
    const textById = new Map<string, string>()
    for (const row of rows) {
      const vector = row.embedding
      if (!Array.isArray(vector)) continue
      const numbers = vector.map((value) => Number(value))
      if (numbers.some((value) => !Number.isFinite(value))) continue
      const id = readString(row, 'message_id')
      items.push({ id, vector: numbers, clientId })
      textById.set(id, readString(row, 'content'))
    }

    if (items.length === 0) {
      skippedClients += 1
      continue
    }

    const clusters = clusterByThreshold(items).slice(0, MAX_CLUSTERS_PER_RUN)

    // Replace rather than append. Members cascade with the theme, so this clears both.
    await deleteRows('insight_themes', [
      { column: 'scope', operator: 'eq', value: 'client' },
      { column: 'client_id', operator: 'eq', value: clientId },
      { column: 'period_start', operator: 'eq', value: periodStart },
      { column: 'period_end', operator: 'eq', value: periodEnd },
    ])

    for (const cluster of clusters) {
      const questions = cluster.members
        .map((member) => textById.get(member.id))
        .filter((text): text is string => typeof text === 'string')

      const { label, summary, usage } = await labelCluster(questions)

      // How much of this theme went unanswered — the number that makes the Content
      // gaps screen a ranking rather than a list.
      const [gapRow] = await query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE a.grounded IS FALSE)::int AS unanswered
           FROM chat_messages q
           LEFT JOIN LATERAL (
             SELECT m.grounded
               FROM chat_messages m
              WHERE m.chat_id = q.chat_id
                AND m.role = 'assistant'
                AND m.created_at >= q.created_at
              ORDER BY m.created_at ASC
              LIMIT 1
           ) AS a ON TRUE
          WHERE q.id = ANY($1::UUID[])`,
        [uuidArrayLiteral(cluster.members.map((member) => member.id))],
      )
      const total = gapRow ? readNumber(gapRow, 'total') : cluster.members.length
      const unanswered = gapRow ? readNumber(gapRow, 'unanswered') : 0

      const theme = await insertRow(
        'insight_themes',
        {
          scope: 'client',
          client_id: clientId,
          period_start: periodStart,
          period_end: periodEnd,
          label,
          summary,
          question_count: cluster.members.length,
          client_count: cluster.clientCount,
          unanswered_share: total > 0 ? Number((unanswered / total).toFixed(4)) : null,
          // Sample ids are permitted on a CLIENT theme and forbidden on an org one —
          // 0020's CHECK enforces that, and this is the side where they are the point:
          // a theme a person cannot trace back to real questions is not actionable.
          sample_message_ids: uuidArrayLiteral(
            cluster.members.slice(0, SAMPLE_IDS).map((member) => member.id),
          ),
          model: CHAT_MODEL,
          prompt_version: CLUSTER_PROMPT_VERSION,
        },
        ['id'],
      )
      if (!theme) continue
      const themeId = readString(theme, 'id')
      themesWritten += 1

      for (const member of cluster.members) {
        await insertRow(
          'insight_theme_members',
          { theme_id: themeId, message_id: member.id, similarity: member.similarity },
          ['theme_id'],
        )
      }

      await recordUsage({
        kind: 'chat_completion',
        model: CHAT_MODEL,
        clientId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        metadata: { via: 'insight_cluster', themeId },
      })

      questionsClustered += cluster.members.length
    }

    clientsProcessed += 1
    logStep('insight.clustered', {
      clientId,
      clusters: clusters.length,
      questions: items.length,
      periodStart,
    })
  }

  return {
    clients: clientsProcessed,
    themes: themesWritten,
    questions: questionsClustered,
    skippedClients,
  }
}

// ---------------------------------------------------------------------------
// insight_flag
// ---------------------------------------------------------------------------

/** Bump when the prompt, the model or the code list changes. */
const FLAG_PROMPT_VERSION = 'flag-v1'

/** Questions per completion. One call per question would cost ~20x for no gain. */
const FLAG_BATCH_SIZE = 20
/** Questions per run, so a first pass over a long history is paced across sweeps. */
const FLAG_RUN_LIMIT = 200

/**
 * The codes, and what each one is looking for.
 *
 * §10.5 is explicit that these five are "a starting guess; the people who would action
 * them should choose them" — so the descriptions here are written to be argued with
 * rather than to look settled. They are also the prompt: changing this list changes
 * what the model is asked, which is why `FLAG_PROMPT_VERSION` sits beside it.
 */
const FLAG_CODES: ReadonlyArray<{ code: string; looksLike: string }> = [
  {
    code: 'adverse_event',
    looksLike:
      'any mention of a patient experiencing harm, a side effect, an unexpected ' +
      'reaction, a death, or a safety signal — however indirect, hypothetical or ' +
      'second-hand',
  },
  {
    code: 'off_label',
    looksLike:
      'asking about using a product for an indication, population or dose it is not ' +
      'approved for',
  },
  {
    code: 'complaint',
    looksLike:
      'dissatisfaction with a product, a batch, packaging, supply, or with KIRIA itself',
  },
  {
    code: 'privacy',
    looksLike:
      'personal data about an identifiable person — a patient, a named individual and ' +
      'their health, contact details — where it does not belong',
  },
  {
    code: 'other',
    looksLike:
      'anything else a compliance reviewer at a pharmaceutical advisory firm would want ' +
      'to have seen',
  },
]

/**
 * Classify a batch of questions against the review codes.
 *
 * **Tuned for recall, and the prompt says so in as many words.** §5: "a missed
 * adverse-event mention costs far more than a false positive a human dismisses in two
 * seconds." A model told to be careful will be precise, and precision is the wrong
 * target here — so it is told the opposite, explicitly, twice.
 *
 * Batched because one completion per question costs twenty times as much for no
 * benefit: the classification of one question does not depend on the others, and the
 * model has no trouble keeping twenty apart when they are numbered.
 *
 * A malformed reply yields **no flags for that batch** rather than a guess. That is the
 * one place recall gives way: inventing flags from an unparseable response would fill
 * the queue with noise and teach the reviewer to skim it, which costs more recall in
 * the end than the batch that was missed — and the batch is retried on the next run,
 * because nothing was written for it.
 */
async function classifyBatch(
  questions: ReadonlyArray<{ id: string; text: string }>,
): Promise<{
  flags: Array<{ id: string; code: string; confidence: number }>
  usage: { inputTokens: number; outputTokens: number }
}> {
  const codeList = FLAG_CODES.map((entry) => `- ${entry.code}: ${entry.looksLike}`).join('\n')
  const numbered = questions.map((question, index) => `${index + 1}. ${question.text}`).join('\n')

  const result = await createChatCompletion(
    [
      {
        role: 'system',
        content:
          'You screen questions asked by pharmaceutical clients so a human compliance ' +
          'reviewer can look at the ones that matter.\n\n' +
          'Categories:\n' +
          codeList +
          '\n\n' +
          '**Err heavily towards flagging.** A missed adverse-event mention is far worse ' +
          'than a false positive, which a reviewer dismisses in two seconds. If a ' +
          'question is even arguably in a category, flag it. Do not weigh whether it is ' +
          'serious enough — that is the reviewer\'s judgement, not yours.\n\n' +
          'Reply with one line per flagged question, nothing else:\n' +
          'NUMBER|CODE|CONFIDENCE\n' +
          'where CONFIDENCE is 0.0 to 1.0. A question may appear more than once with ' +
          'different codes. Reply with the single word NONE if nothing is flagged.',
      },
      { role: 'user', content: numbered },
    ],
    600,
  )

  return { flags: parseFlagReply(result.text, questions), usage: result.usage }
}

/**
 * Turn the model's reply into flags.
 *
 * Exported and pure so it can be tested against real reply text without a model call —
 * which is the only way to tell a genuine "nothing was flagged" from a parser that
 * never matches anything. The first production run screened seven questions and
 * flagged none, and that number is only meaningful if this function is known to be
 * capable of returning a non-empty list.
 *
 * Everything unrecognised is dropped rather than guessed at: an unknown code, a
 * question number that is not in the batch, a line of prose the model added despite
 * being told not to. The alternative — coercing a near-miss into a flag — fills a
 * compliance queue with rows nobody can trace to anything, and a queue like that stops
 * being read.
 */
export function parseFlagReply(
  text: string,
  questions: ReadonlyArray<{ id: string }>,
): Array<{ id: string; code: string; confidence: number }> {
  const flags: Array<{ id: string; code: string; confidence: number }> = []
  const valid = new Set(FLAG_CODES.map((entry) => entry.code))

  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s*\|\s*([a-z_]+)\s*\|\s*([0-9.]+)/i.exec(line)
    if (!match) continue
    const question = questions[Number(match[1]) - 1]
    const code = match[2].toLowerCase()
    if (!question || !valid.has(code)) continue
    const confidence = Number(match[3])
    flags.push({
      id: question.id,
      code,
      // A malformed number becomes 0.5 rather than dropping the flag. The confidence
      // is only ever a sort key for the reviewer (§5 rules out a threshold), so losing
      // it is not a reason to lose the flag it was attached to.
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    })
  }

  return flags
}

/**
 * Screen new questions for anything a compliance reviewer should see — §5, §7 screen 5.
 *
 * ## Three things this must never do, from §5
 *
 * > "Never notifies the client, never reports anywhere automatically, never blocks the
 * > answer."
 *
 * All three follow from it being a **job** rather than a step in the chat path: it runs
 * on the worker's sweep over questions that were already answered, so there is nothing
 * to block, nobody to notify, and no route out of the database. A flag raised here goes
 * into a queue a person opens. It does not raise a system alert either — an inbox that
 * fills with "somebody asked something" is an inbox that stops being read, and this
 * queue has its own screen.
 *
 * ## No confidence floor
 *
 * There is deliberately no "only write it if confidence > x". §5's whole instruction is
 * that a false positive is cheap and a miss is not, and a threshold is precisely how a
 * recall-tuned classifier quietly becomes a precision-tuned one. The confidence is
 * stored so the **reviewer** can sort by it; it is not used to decide anything.
 *
 * ## Opt-out
 *
 * In the WHERE clause, like every other job here. An opted-out client's questions are
 * never read, so they are never sent to the model and never flagged.
 */
export async function runInsightFlag(): Promise<{
  screened: number
  flagged: number
  byCode: Record<string, number>
}> {
  // Never screened before — `flag_screened_at IS NULL`, not "has no flag row".
  //
  // A clean question produces no `review_flags` row, so filtering on the absence of one
  // re-screens every clean question on every run: the same answer, bought again nightly,
  // forever. 0025 added the column for exactly this, and it is why there is no time
  // window here either — the whole history is screened once and then only new questions
  // are, which is what a queue claiming to catch adverse events has to be able to say.
  const pending = await query(
    `SELECT m.id, m.content, ch.client_id
       FROM chat_messages m
       JOIN chats ch ON ch.id = m.chat_id
       JOIN clients c ON c.id = ch.client_id
      WHERE m.role = 'user'
        AND c.analytics_opt_out = FALSE
        AND m.flag_screened_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT ${FLAG_RUN_LIMIT}`,
  )

  if (pending.length === 0) return { screened: 0, flagged: 0, byCode: {} }

  let flagged = 0
  const byCode: Record<string, number> = {}

  for (let offset = 0; offset < pending.length; offset += FLAG_BATCH_SIZE) {
    const slice = pending.slice(offset, offset + FLAG_BATCH_SIZE)
    const questions = slice.map((row) => ({
      id: readString(row, 'id'),
      text: readString(row, 'content').slice(0, 1000),
    }))
    const clientByMessage = new Map(
      slice.map((row) => [readString(row, 'id'), readString(row, 'client_id')]),
    )

    const { flags, usage } = await classifyBatch(questions)

    for (const flag of flags) {
      const clientId = clientByMessage.get(flag.id)
      if (!clientId) continue
      try {
        await insertRow(
          'review_flags',
          {
            message_id: flag.id,
            client_id: clientId,
            code: flag.code,
            confidence: flag.confidence,
            model: CHAT_MODEL,
            prompt_version: FLAG_PROMPT_VERSION,
          },
          ['id'],
        )
        flagged += 1
        byCode[flag.code] = (byCode[flag.code] ?? 0) + 1
      } catch {
        // `review_flags_once` refuses a second flag of the same code on the same
        // message. Re-running a screen must not fail on a row that is already there,
        // and it must not overwrite one a person has since reviewed.
      }
    }

    // Marked screened only after its flags are written. The order matters: a crash
    // between the two leaves the batch unscreened and it is done again — a duplicate
    // flag is refused by `review_flags_once`, so a redo is free. The other order would
    // mark a question screened whose flags were never saved, and lose it silently.
    for (const question of questions) {
      await updateRows('chat_messages', { flag_screened_at: new Date().toISOString() }, [
        { column: 'id', operator: 'eq', value: question.id },
      ])
    }

    // Charged to no single client: a batch spans accounts and the screening is KIRIA's
    // own compliance activity rather than work done for one of them.
    await recordUsage({
      kind: 'chat_completion',
      model: CHAT_MODEL,
      clientId: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metadata: { via: 'insight_flag', questions: slice.length },
    })
  }

  logStep('insight.flagged', { screened: pending.length, flagged })
  return { screened: pending.length, flagged, byCode }
}
