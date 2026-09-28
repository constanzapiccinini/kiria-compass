/** Chat sessions and the grounded question-answering endpoint. */

import { Hono } from 'hono'
import { raiseAlert } from '../lib/alerts.js'
import { EMBEDDING_MODEL, orgId } from '../lib/config.js'
import { HttpError, isUuid } from '../lib/auth.js'
import {
  assertNoTenantOverride,
  requireEmployee,
  resolvePortalContext,
  type PortalContext,
} from '../lib/portal.js'
import { hashUser } from '../lib/insights.js'
import { askQuestion, NO_INFORMATION_ANSWER, type Citation } from '../lib/rag.js'
import { getClientSettings, type RetrievalMode } from '../lib/settings.js'
import { monthToDateUsage, recordAudit, recordTrace, recordUsage } from '../lib/observability.js'
import { OpenAiError, type ChatMessage } from '../lib/openai.js'
import {
  deleteRows,
  insertRow,
  query,
  queryOne,
  readBoolean,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  updateRows,
} from '../lib/store.js'

export const chatRoutes = new Hono()

/**
 * Reject a caller-supplied tenant id before doing anything else.
 *
 * Tenancy comes from the verified portal context alone, so a request carrying one
 * of these is a probe rather than a mistake — refused, not silently ignored.
 */
function guardTenancy(
  c: Parameters<typeof assertNoTenantOverride>[0],
  body?: Record<string, unknown> | null,
): void {
  const probe = assertNoTenantOverride(c, body)
  if (probe) {
    throw new HttpError(400, `Request carried a tenant identifier "${probe}"`, 'TENANCY_PROBE')
  }
}

/**
 * Whether a failure was the model taking too long.
 *
 * `postJson` aborts on its own timeout and rethrows the `AbortError` once retries are
 * spent, so that name is the signal. A 504 from the provider counts as the same
 * event to the person diagnosing it.
 */
function isTimeout(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true
  }
  return error instanceof OpenAiError && (error.status === 504 || error.status === 408)
}

/** Raise LLM_TIMEOUT_REPEATED only once timeouts are a pattern, not an incident. */
const TIMEOUT_WINDOW_MINUTES = 30
const TIMEOUT_THRESHOLD = 3

/**
 * Record one answer timeout and alert if they are now repeating.
 *
 * The count is kept in `rag_traces` rather than in memory on purpose: the backend
 * runs on up to three replicas, and a per-process counter would need three times the
 * failures before any single replica noticed — turning a threshold of 3 into an
 * effective 9 at exactly the moment the product is failing.
 *
 * Best-effort throughout. The caller is already about to return an error, and losing
 * the alert is better than replacing a 504 with a 500 from the alerting code.
 */
async function noteAnswerTimeout(
  clientId: string,
  clientName: string,
  chatId: string,
  mode: RetrievalMode,
): Promise<void> {
  try {
    await recordTrace({
      clientId,
      chatId,
      step: 'answer_timeout',
      durationMs: 0,
      detail: { mode },
    })

    const row = await queryOne(
      `SELECT COUNT(*) AS recent
         FROM rag_traces
        WHERE client_id = $1
          AND step = 'answer_timeout'
          AND created_at > now() - make_interval(mins => $2::int)`,
      [clientId, TIMEOUT_WINDOW_MINUTES],
    )
    const recent = row ? Number(row.recent) : 0
    if (!Number.isFinite(recent) || recent < TIMEOUT_THRESHOLD) return

    await raiseAlert({
      code: 'LLM_TIMEOUT_REPEATED',
      clientId,
      cause:
        `${clientName} has had ${recent} answers time out in the last ${TIMEOUT_WINDOW_MINUTES} minutes ` +
        `(retrieval mode "${mode}"). Each one was retried before failing, so the model is either down or ` +
        `consistently too slow for the amount of context this client's questions retrieve.`,
      metadata: { recent, windowMinutes: TIMEOUT_WINDOW_MINUTES, mode },
    })
  } catch (error) {
    console.error('[chat] failed to record answer timeout', error)
  }
}

/** How many earlier turns are replayed to the model. Keeps input cost bounded. */
const HISTORY_TURNS = 6

function requestMeta(headers: Headers): { ip: string | null; userAgent: string | null } {
  return {
    ip: headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: headers.get('user-agent'),
  }
}

/**
 * Retrieval mode, whatever the caller says (§7.5).
 *
 * A `retrievalMode` in the request body is **ignored** rather than refused, and the
 * asymmetry with `updateClientSettings` — which returns a 400 for the same key — is
 * deliberate. Settings is someone stating an intent to change something, and being
 * told "saved" when nothing was is a lie. This is a chat request, where the mode was
 * never the point: refusing the whole question because an old cached bundle still
 * sends the field would break asking a question over a value that no longer changes
 * anything.
 *
 * The column stays until 6B, so it is written with the only value there is.
 */
function parseMode(_value: unknown, _fallback: RetrievalMode): RetrievalMode {
  return 'precision'
}

/** List chats in a client. */
chatRoutes.get('/', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const clientId = context.clientId

  const rows = await query(
    `SELECT id, title, retrieval_mode, created_by_user_id, last_message_at, created_at
       FROM chats WHERE client_id = $1 ORDER BY COALESCE(last_message_at, created_at) DESC`,
    [clientId],
  )

  return c.json({
    chats: rows.map((row) => ({
      id: readString(row, 'id'),
      title: readString(row, 'title'),
      retrievalMode: readString(row, 'retrieval_mode'),
      createdByUserId: readString(row, 'created_by_user_id'),
      lastMessageAt: readOptionalString(row, 'last_message_at'),
      createdAt: readString(row, 'created_at'),
    })),
  })
})

/** Create a chat, optionally scoped to a starting set of documents. */
chatRoutes.post('/', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  guardTenancy(c, body as Record<string, unknown>)
  const payload = body as { title?: unknown; documentIds?: unknown; retrievalMode?: unknown }

  const context = await resolvePortalContext(c)
  const clientId = context.clientId

  const settings = await getClientSettings(clientId)
  const title =
    typeof payload.title === 'string' && payload.title.trim().length > 0
      ? payload.title.trim().slice(0, 200)
      : 'New chat'

  const created = await insertRow(
    'chats',
    {
      client_id: clientId,
      title,
      retrieval_mode: parseMode(payload.retrievalMode, settings.retrievalMode),
      created_by_user_id: context.userId,
    },
    ['id', 'title', 'retrieval_mode'],
  )
  if (!created) throw new HttpError(500, 'Failed to create chat')
  const chatId = readString(created, 'id')

  const documentIds = Array.isArray(payload.documentIds)
    ? payload.documentIds.filter((id): id is string => typeof id === 'string' && isUuid(id))
    : []
  if (documentIds.length > 0) {
    await setChatDocuments(chatId, context.portalId, context.clientId, documentIds)
  }

  return c.json({ id: chatId, title: readString(created, 'title'), retrievalMode: readString(created, 'retrieval_mode') }, 201)
})

/** Replace the chat's active document set, verifying every document is in scope. */
async function setChatDocuments(
  chatId: string,
  portalId: string,
  clientId: string,
  documentIds: string[],
): Promise<string[]> {
  const unique = [...new Set(documentIds)]
  if (unique.length === 0) {
    await deleteRows('chat_documents', [{ column: 'chat_id', operator: 'eq', value: chatId }])
    return []
  }

  // Validated against what the PORTAL can see, not the client (§6.5). Scoping a
  // chat by client would let a document that a removed binding has orphaned stay
  // answerable, and would miss group-source documents that the portal legitimately
  // sees but no single client owns.
  const rows = await query(
    `SELECT d.id
       FROM documents d
       JOIN public.portal_visible_documents v ON v.document_id = d.id
      WHERE v.portal_id = $1 AND d.id = ANY($2::uuid[])`,
    [portalId, `{${unique.join(',')}}`],
  )
  const valid = rows.map((row) => readString(row, 'id'))
  if (valid.length !== unique.length) {
    throw new HttpError(400, 'One or more documents are not available in this portal')
  }

  await deleteRows('chat_documents', [{ column: 'chat_id', operator: 'eq', value: chatId }])
  for (const documentId of valid) {
    await insertRow(
      'chat_documents',
      // client_id is denormalized here so the RLS policy can scope this join table
      // directly rather than through the chat, which under RLS would need the policy
      // to be able to see the chat row first.
      { chat_id: chatId, document_id: documentId, client_id: clientId, active: true },
      ['chat_id'],
    )
  }
  return valid
}

interface ChatRecord {
  id: string
  clientId: string
  retrievalMode: RetrievalMode
  title: string
}

/**
 * Load a chat belonging to this portal's client, or 404.
 *
 * The `client_id` predicate is the tenancy check — without it a chat id from
 * another client would load here and every downstream handler would trust it.
 */
async function loadChat(context: PortalContext, chatId: string): Promise<ChatRecord> {
  if (!isUuid(chatId)) throw new HttpError(400, 'chatId must be a UUID', 'BAD_REQUEST')
  const row = await queryOne(
    'SELECT id, client_id, retrieval_mode, title FROM chats WHERE id = $1 AND client_id = $2',
    [chatId, context.clientId],
  )
  if (!row) {
    // Same reasoning as documents: audit only when the id exists under another
    // client, so a real cross-tenant attempt is not buried in mistyped ids. This is
    // the loader whose missing `client_id` predicate the 4A refactor caught, so a
    // trail here is worth more than most.
    const existing = await queryOne('SELECT client_id FROM chats WHERE id = $1', [
      chatId,
    ]).catch(() => null)

    if (existing) {
      await recordAudit({
        orgId: orgId(),
        clientId: context.clientId,
        actorUserId: context.userId,
        action: 'chat.cross_tenant_denied',
        targetType: 'chat',
        targetId: chatId,
        metadata: {
          portalId: context.portalId,
          actor: context.actor,
          ownedByClientId: readString(existing, 'client_id'),
        },
      })
    }

    throw new HttpError(404, 'Chat not found', 'NOT_FOUND')
  }
  return {
    id: readString(row, 'id'),
    clientId: readString(row, 'client_id'),
    retrievalMode: parseMode(readString(row, 'retrieval_mode'), 'precision'),
    title: readString(row, 'title'),
  }
}

/** Full transcript plus the active document set. */
chatRoutes.get('/:chatId', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const chat = await loadChat(context, c.req.param('chatId'))

  // The viewer's own rating rides along with the message (§3). Joined on the hash of
  // THIS caller, so one person never sees another's rating — the table holds one row
  // per person per message and there is no aggregate a client is entitled to.
  const userHash = await hashUser(context.clientId, context.userId)
  const messageRows = await query(
    `SELECT m.id, m.role, m.content, m.citations, m.grounded, m.model, m.input_tokens,
            m.output_tokens, m.latency_ms, m.truncated, m.created_by_user_id, m.created_at,
            f.rating
       FROM chat_messages m
       LEFT JOIN chat_message_feedback f
              ON f.message_id = m.id AND f.user_hash = $2
      WHERE m.chat_id = $1
      ORDER BY m.created_at ASC`,
    [chat.id, userHash],
  )
  const documentRows = await query(
    `SELECT d.id, d.name, d.status, cd.active
       FROM chat_documents cd
       JOIN documents d ON d.id = cd.document_id
      WHERE cd.chat_id = $1
      ORDER BY d.name ASC`,
    [chat.id],
  )

  return c.json({
    chat: { id: chat.id, title: chat.title, retrievalMode: chat.retrievalMode, clientId: chat.clientId },
    messages: messageRows.map((row) => ({
      id: readString(row, 'id'),
      role: readString(row, 'role'),
      content: readString(row, 'content'),
      citations: row.citations ?? [],
      grounded: row.grounded === null ? null : readBoolean(row, 'grounded'),
      model: readOptionalString(row, 'model'),
      inputTokens: readOptionalNumber(row, 'input_tokens'),
      outputTokens: readOptionalNumber(row, 'output_tokens'),
      latencyMs: readOptionalNumber(row, 'latency_ms'),
      truncated: readBoolean(row, 'truncated'),
      createdAt: readString(row, 'created_at'),
      /** This viewer's own rating: 1, -1, or null when they have not rated it. */
      rating: row.rating === null || row.rating === undefined ? null : readNumber(row, 'rating'),
    })),
    documents: documentRows.map((row) => ({
      id: readString(row, 'id'),
      name: readString(row, 'name'),
      status: readString(row, 'status'),
      active: readBoolean(row, 'active', true),
    })),
  })
})

/** Replace the chat's document scope. */
chatRoutes.put('/:chatId/documents', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const chat = await loadChat(context, c.req.param('chatId'))

  const body: unknown = await c.req.json().catch(() => null)
  const ids =
    typeof body === 'object' && body !== null && Array.isArray((body as { documentIds?: unknown }).documentIds)
      ? ((body as { documentIds: unknown[] }).documentIds.filter(
          (id): id is string => typeof id === 'string' && isUuid(id),
        ))
      : []

  const applied = await setChatDocuments(chat.id, context.portalId, chat.clientId, ids)
  return c.json({ documentIds: applied })
})

chatRoutes.delete('/:chatId', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  requireEmployee(context)
  const chat = await loadChat(context, c.req.param('chatId'))

  await deleteRows('chats', [{ column: 'id', operator: 'eq', value: chat.id }])
  await recordAudit({
    orgId: orgId(),
    clientId: chat.clientId,
    actorUserId: context.userId,
    action: 'chat.delete',
    targetType: 'chat',
    targetId: chat.id,
    ...requestMeta(c.req.raw.headers),
  })
  return c.json({ deleted: true })
})

/**
 * Ask a question. This is the RAG entry point.
 *
 * Ordering matters: the budget check runs before any paid API call, the user turn is
 * persisted before generation so a failure mid-answer does not lose the question, and
 * citations are resolved against the retrieved passages before the answer is stored.
 */
/**
 * Rate one answer — thumbs up or down, with an optional comment (§3 of Phase 8).
 *
 * The cheapest high-value signal there is: without it, "was this answer good" is
 * guesswork over latency and token counts. It belongs to chat rather than to
 * configuration, so it does not break §5C's view-and-chat rule for this app — a reader
 * reacting to an answer is reading, not configuring.
 *
 * ## Why it is an upsert and not an insert
 *
 * §8 asks that a second submit **updates rather than duplicating**, and the unique
 * constraint `(message_id, user_hash)` is what makes that a guarantee. Changing one's
 * mind about an answer is the normal case, not an error to refuse — a 409 here would
 * mean the first tap on the wrong thumb is permanent.
 *
 * ## Only an assistant message can be rated
 *
 * Checked rather than assumed: a rating on one's own question means nothing, and the
 * table's foreign key would happily accept it. The check is on the row, not on the
 * request, so a caller cannot pass a question id and get a row nobody can interpret.
 *
 * The stored identity is a per-client salted HMAC, never the user id — see
 * `lib/insights.ts`. "Which person rated this" is deliberately unanswerable from these
 * rows; the audit log answers it if an operational question ever needs it to.
 */
chatRoutes.put('/:chatId/messages/:messageId/feedback', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const chat = await loadChat(context, c.req.param('chatId'))

  const messageId = c.req.param('messageId')
  if (!isUuid(messageId)) throw new HttpError(400, 'messageId must be a UUID', 'BAD_REQUEST')

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  const raw = body as { rating?: unknown; comment?: unknown }

  // 1 or -1, and nothing else. §4's CHECK says the same, but a 400 that names the
  // field beats a constraint violation surfacing as a 500 — which is exactly the
  // lesson Phase 6 learned the hard way with folder names.
  if (raw.rating !== 1 && raw.rating !== -1) {
    throw new HttpError(400, 'rating must be 1 or -1', 'BAD_REQUEST')
  }
  const comment =
    typeof raw.comment === 'string' && raw.comment.trim().length > 0
      ? raw.comment.trim().slice(0, 2000)
      : null

  // Scoped to this chat, so a message id from another conversation — or another
  // tenant — is a 404 like any other foreign id rather than a 403 that confirms it
  // exists.
  const message = await queryOne(
    `SELECT id, role FROM chat_messages WHERE id = $1 AND chat_id = $2`,
    [messageId, chat.id],
  )
  if (!message) throw new HttpError(404, 'Message not found', 'NOT_FOUND')
  if (readString(message, 'role') !== 'assistant') {
    throw new HttpError(400, 'Only an answer can be rated', 'NOT_AN_ANSWER')
  }

  const userHash = await hashUser(context.clientId, context.userId)

  const existing = await queryOne(
    'SELECT id FROM chat_message_feedback WHERE message_id = $1 AND user_hash = $2',
    [messageId, userHash],
  )

  if (existing) {
    await updateRows(
      'chat_message_feedback',
      { rating: raw.rating, comment, updated_at: new Date().toISOString() },
      [{ column: 'id', operator: 'eq', value: readString(existing, 'id') }],
    )
  } else {
    await insertRow(
      'chat_message_feedback',
      {
        message_id: messageId,
        client_id: context.clientId,
        rating: raw.rating,
        comment,
        user_hash: userHash,
      },
      ['id'],
    )
  }

  return c.json({ rating: raw.rating, comment })
})

chatRoutes.post('/:chatId/messages', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const chat = await loadChat(context, c.req.param('chatId'))

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'A JSON body is required')
  const payload = body as { question?: unknown; documentIds?: unknown; retrievalMode?: unknown }

  const question = typeof payload.question === 'string' ? payload.question.trim() : ''
  if (question.length === 0) throw new HttpError(400, 'A question is required')
  if (question.length > 4000) throw new HttpError(400, 'Question is too long (max 4000 characters)')

  const settings = await getClientSettings(chat.clientId)
  const mode = parseMode(payload.retrievalMode, chat.retrievalMode)

  // Enforce the monthly token budget before spending anything.
  if (settings.monthlyTokenBudget !== null) {
    const usage = await monthToDateUsage(chat.clientId)
    if (usage.inputTokens + usage.outputTokens >= settings.monthlyTokenBudget) {
      // A client just had a question refused, which they will notice and ask about.
      // Not awaited: the refusal is immediate and must not wait on an alert write.
      void raiseAlert({
        code: 'TOKEN_BUDGET_REACHED',
        clientId: chat.clientId,
        cause:
          `${context.clientName} has used ${(usage.inputTokens + usage.outputTokens).toLocaleString()} of its ` +
          `${settings.monthlyTokenBudget.toLocaleString()} monthly token budget, so questions are now being ` +
          `refused. The refusal happens before any paid call, so nothing is being spent past the cap.`,
        metadata: {
          used: usage.inputTokens + usage.outputTokens,
          budget: settings.monthlyTokenBudget,
          portalId: context.portalId,
        },
      })
      throw new HttpError(
        429,
        `The client monthly token budget (${settings.monthlyTokenBudget.toLocaleString()}) has been reached. ` +
          'An admin can raise it in client settings.',
      )
    }
  }

  // Resolve the active document scope: the request may override the stored set.
  let documentIds: string[]
  if (Array.isArray(payload.documentIds)) {
    const requested = payload.documentIds.filter((id): id is string => typeof id === 'string' && isUuid(id))
    documentIds = await setChatDocuments(chat.id, context.portalId, chat.clientId, requested)
  } else {
    const rows = await query(
      `SELECT document_id FROM chat_documents WHERE chat_id = $1 AND active = TRUE`,
      [chat.id],
    )
    documentIds = rows.map((row) => readString(row, 'document_id'))
  }

  // With no explicit scope, search everything the PORTAL can see. Resolved through
  // the visibility view rather than by client, so a document orphaned by a removed
  // binding drops out of the default scope on the next question rather than staying
  // answerable until someone notices.
  if (documentIds.length === 0) {
    const rows = await query(
      `SELECT v.document_id AS id
         FROM public.portal_visible_documents v
        WHERE v.portal_id = $1`,
      [context.portalId],
    )
    documentIds = rows.map((row) => readString(row, 'id'))
  }

  const requestStart = Date.now()

  await insertRow(
    'chat_messages',
    {
      chat_id: chat.id,
      client_id: chat.clientId,
      role: 'user',
      content: question,
      created_by_user_id: context.userId,
    },
    ['id'],
  )

  if (documentIds.length === 0) {
    const stored = await insertRow(
      'chat_messages',
      {
        chat_id: chat.id,
        client_id: chat.clientId,
        role: 'assistant',
        content: NO_INFORMATION_ANSWER,
        citations: JSON.stringify([]),
        grounded: false,
        latency_ms: Date.now() - requestStart,
      },
      ['id'],
    )
    return c.json({
      message: {
        id: stored ? readString(stored, 'id') : null,
        role: 'assistant',
        content: NO_INFORMATION_ANSWER,
        citations: [] as Citation[],
        grounded: false,
        truncated: false,
      },
      retrieval: { mode, candidateCount: 0, usedCount: 0, contextTokens: 0, topScore: 0 },
      notice: 'No indexed documents are in scope for this chat yet.',
    })
  }

  // Replay recent turns so follow-up questions ("and the second one?") resolve.
  const historyRows = await query(
    `SELECT role, content FROM chat_messages
      WHERE chat_id = $1 AND role IN ('user', 'assistant')
      ORDER BY created_at DESC
      LIMIT $2`,
    [chat.id, HISTORY_TURNS * 2 + 1],
  )
  const history: ChatMessage[] = historyRows
    .slice(1) // drop the question we just stored
    .reverse()
    .map((row) => {
      const role = readString(row, 'role')
      return { role: role === 'assistant' ? 'assistant' : 'user', content: readString(row, 'content') }
    })

  let outcome: Awaited<ReturnType<typeof askQuestion>>
  try {
    outcome = await askQuestion({
      portalId: context.portalId,
      documentIds,
      question,
      history,
      settings,
      mode,
    })
  } catch (error) {
    // A timeout is the one model failure that is worth alerting on only in
    // aggregate: one is weather, several in a row is an outage or a client whose
    // context is too large for the mode it is on. `noteAnswerTimeout` owns that
    // threshold, and it must not swallow the error — the asker still gets a 5xx.
    if (isTimeout(error)) {
      await noteAnswerTimeout(chat.clientId, context.clientName, chat.id, mode)
    }
    throw error
  }
  const { result } = outcome
  const latencyMs = Date.now() - requestStart

  const stored = await insertRow(
    'chat_messages',
    {
      chat_id: chat.id,
      client_id: chat.clientId,
      role: 'assistant',
      content: result.answer,
      citations: JSON.stringify(result.citations),
      retrieved_chunk_ids: result.retrievedChunkIds,
      grounded: result.grounded,
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      latency_ms: latencyMs,
      truncated: result.truncated,
    },
    ['id'],
  )
  const messageId = stored ? readString(stored, 'id') : null

  await updateRows(
    'chats',
    { last_message_at: new Date().toISOString(), retrieval_mode: mode },
    [{ column: 'id', operator: 'eq', value: chat.id }],
  )

  // Name the chat after its first question.
  if (chat.title === 'New chat') {
    await updateRows('chats', { title: question.slice(0, 120) }, [
      { column: 'id', operator: 'eq', value: chat.id },
    ])
  }

  await recordUsage({
    clientId: chat.clientId,
    userId: context.userId,
    kind: 'embedding',
    model: EMBEDDING_MODEL,
    inputTokens: outcome.embeddingInputTokens,
    chatId: chat.id,
    metadata: { purpose: 'query' },
  })
  if (result.inputTokens > 0 || result.outputTokens > 0) {
    await recordUsage({
      clientId: chat.clientId,
      userId: context.userId,
      kind: 'chat_completion',
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      chatId: chat.id,
      metadata: { mode, usedChunks: result.retrieval.usedCount },
    })
  }

  await recordTrace({
    clientId: chat.clientId,
    chatId: chat.id,
    messageId,
    step: 'embed_query',
    durationMs: outcome.timings.embedQueryMs,
  })
  await recordTrace({
    clientId: chat.clientId,
    chatId: chat.id,
    messageId,
    step: 'retrieve',
    durationMs: outcome.timings.retrieveMs,
    detail: {
      documentsInScope: documentIds.length,
      candidateCount: result.retrieval.candidateCount,
      usedCount: result.retrieval.usedCount,
      contextTokens: result.retrieval.contextTokens,
      topScore: result.retrieval.topScore,
    },
  })
  await recordTrace({
    clientId: chat.clientId,
    chatId: chat.id,
    messageId,
    step: 'generate',
    durationMs: outcome.timings.generateMs,
    detail: {
      grounded: result.grounded,
      truncated: result.truncated,
      citations: result.citations.length,
      totalLatencyMs: latencyMs,
    },
  })

  return c.json({
    message: {
      id: messageId,
      role: 'assistant',
      content: result.answer,
      citations: result.citations,
      grounded: result.grounded,
      truncated: result.truncated,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs,
    },
    retrieval: result.retrieval,
    notice: result.truncated
      ? `The answer was cut off at the client limit of ${settings.maxAnswerTokens} tokens. An admin can raise it in client settings.`
      : undefined,
  })
})
