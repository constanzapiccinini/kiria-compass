/**
 * Structured logging, audit trail, usage metering and RAG pipeline traces.
 *
 * Writes are best-effort: an observability failure must never fail the user's
 * request, but it is always logged to stdout so it shows up in remote-logs.
 */

import { PRICING } from './config.js'
import { insertRow, query, readNumber } from './store.js'

export type UsageKind = 'embedding' | 'chat_completion' | 'ocr' | 'rerank'
export type TraceStep = 'embed_query' | 'retrieve' | 'rerank' | 'generate' | 'ingest'

/** One structured line per pipeline step, greppable in remote-logs. */
export function logStep(step: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), step, ...detail }))
}

export interface AuditEntry {
  orgId: string
  clientId?: string | null
  actorUserId?: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown>
}

/** Append an immutable audit row. Never throws. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  logStep('audit', { action: entry.action, clientId: entry.clientId, actor: entry.actorUserId })
  try {
    await insertRow(
      'audit_logs',
      {
        org_id: entry.orgId,
        client_id: entry.clientId ?? null,
        actor_user_id: entry.actorUserId ?? null,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        ip: entry.ip ?? null,
        user_agent: entry.userAgent ?? null,
        // JSONB values go over the wire as JSON strings.
        metadata: JSON.stringify(entry.metadata ?? {}),
      },
      ['id'],
    )
  } catch (error) {
    console.error('[audit] failed to persist entry', entry.action, error)
  }
}

export interface UsageEntry {
  clientId: string
  userId?: string | null
  kind: UsageKind
  model?: string | null
  inputTokens?: number
  outputTokens?: number
  ocrPages?: number
  documentId?: string | null
  chatId?: string | null
  metadata?: Record<string, unknown>
}

/** Cost in USD from the price table, computed at write time. */
export function computeCost(entry: UsageEntry): number {
  if (entry.kind === 'ocr') {
    return (entry.ocrPages ?? 0) * PRICING.textract.perPage
  }
  const model = entry.model
  if (model === 'text-embedding-3-large' || model === 'gpt-4.1-mini') {
    const price = PRICING[model]
    return (
      ((entry.inputTokens ?? 0) / 1_000_000) * price.inputPerMillion +
      ((entry.outputTokens ?? 0) / 1_000_000) * price.outputPerMillion
    )
  }
  return 0
}

/** Record a metered usage event. Never throws. */
export async function recordUsage(entry: UsageEntry): Promise<void> {
  const costUsd = computeCost(entry)
  logStep('usage', {
    kind: entry.kind,
    model: entry.model,
    clientId: entry.clientId,
    inputTokens: entry.inputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    ocrPages: entry.ocrPages ?? 0,
    costUsd,
  })
  try {
    await insertRow(
      'usage_events',
      {
        client_id: entry.clientId,
        user_id: entry.userId ?? null,
        kind: entry.kind,
        model: entry.model ?? null,
        input_tokens: entry.inputTokens ?? 0,
        output_tokens: entry.outputTokens ?? 0,
        ocr_pages: entry.ocrPages ?? 0,
        cost_usd: costUsd,
        document_id: entry.documentId ?? null,
        chat_id: entry.chatId ?? null,
        metadata: JSON.stringify(entry.metadata ?? {}),
      },
      ['id'],
    )
  } catch (error) {
    console.error('[usage] failed to persist event', entry.kind, error)
  }
}

export interface TraceEntry {
  clientId: string
  chatId?: string | null
  messageId?: string | null
  step: TraceStep
  durationMs: number
  detail?: Record<string, unknown>
}

/** Record one RAG pipeline step. Never throws. */
export async function recordTrace(entry: TraceEntry): Promise<void> {
  logStep(`rag.${entry.step}`, {
    clientId: entry.clientId,
    chatId: entry.chatId,
    durationMs: entry.durationMs,
    ...entry.detail,
  })
  try {
    await insertRow(
      'rag_traces',
      {
        client_id: entry.clientId,
        chat_id: entry.chatId ?? null,
        message_id: entry.messageId ?? null,
        step: entry.step,
        duration_ms: Math.round(entry.durationMs),
        detail: JSON.stringify(entry.detail ?? {}),
      },
      ['id'],
    )
  } catch (error) {
    console.error('[trace] failed to persist step', entry.step, error)
  }
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  ocrPages: number
  costUsd: number
}

/** Month-to-date usage for a client, used to enforce budgets. */
export async function monthToDateUsage(clientId: string): Promise<UsageTotals> {
  const rows = await query(
    `SELECT COALESCE(SUM(input_tokens), 0)  AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(ocr_pages), 0)     AS ocr_pages,
            COALESCE(SUM(cost_usd), 0)      AS cost_usd
       FROM usage_events
      WHERE client_id = $1
        AND created_at >= date_trunc('month', now())`,
    [clientId],
  )
  const row = rows[0]
  if (!row) return { inputTokens: 0, outputTokens: 0, ocrPages: 0, costUsd: 0 }
  return {
    inputTokens: readNumber(row, 'input_tokens'),
    outputTokens: readNumber(row, 'output_tokens'),
    ocrPages: readNumber(row, 'ocr_pages'),
    costUsd: readNumber(row, 'cost_usd'),
  }
}

/** Wrap an async step so its duration is measured for the trace log. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const start = Date.now()
  const value = await fn()
  return { value, durationMs: Date.now() - start }
}
