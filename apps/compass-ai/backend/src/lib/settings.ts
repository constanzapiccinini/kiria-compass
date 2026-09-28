/** Per-client cost caps and retrieval configuration. */

import { HttpError } from './auth.js'
import { insertRow, queryOne, readBoolean, readNumber, readOptionalNumber, readString, updateRows } from './store.js'

/**
 * Precision is the only retrieval behaviour (§7.5).
 *
 * Kept as a one-member union rather than deleted outright, because
 * `client_settings.retrieval_mode` and `chats.retrieval_mode` are still columns —
 * they join the 6B prune list, deliberately not this release. So a stored
 * `'economy'` is still readable and is **narrowed to precision on read**, which is
 * what makes the code and the data agree without a migration.
 */
export type RetrievalMode = 'precision'

export interface ClientSettings {
  clientId: string
  retrievalMode: RetrievalMode
  maxAnswerTokens: number
  maxRetrievedTokens: number
  maxOcrPagesPerUpload: number
  monthlyTokenBudget: number | null
  monthlyOcrPageBudget: number | null
  ocrTablesEnabled: boolean
  ocrFormsEnabled: boolean
  ocrQueriesEnabled: boolean
  batchEmbeddingEnabled: boolean
  batchEmbeddingMinChunks: number
}

/**
 * Every stored value becomes `'precision'`.
 *
 * Not a validation — a narrowing. A row still reading `'economy'` is not an error to
 * reject, it is a row written before the mode was removed, and the answer for it is
 * the same as for every other row.
 */
function toRetrievalMode(_value: string): RetrievalMode {
  return 'precision'
}

/** Read settings, creating the default row if it is somehow missing. */
export async function getClientSettings(clientId: string): Promise<ClientSettings> {
  let row = await queryOne('SELECT * FROM client_settings WHERE client_id = $1', [clientId])

  if (!row) {
    await insertRow('client_settings', { client_id: clientId }, ['client_id'])
    row = await queryOne('SELECT * FROM client_settings WHERE client_id = $1', [clientId])
  }
  if (!row) throw new HttpError(500, 'Client settings could not be loaded')

  return {
    clientId: readString(row, 'client_id'),
    retrievalMode: toRetrievalMode(readString(row, 'retrieval_mode')),
    maxAnswerTokens: readNumber(row, 'max_answer_tokens'),
    maxRetrievedTokens: readNumber(row, 'max_retrieved_tokens'),
    maxOcrPagesPerUpload: readNumber(row, 'max_ocr_pages_per_upload'),
    monthlyTokenBudget: readOptionalNumber(row, 'monthly_token_budget'),
    monthlyOcrPageBudget: readOptionalNumber(row, 'monthly_ocr_page_budget'),
    ocrTablesEnabled: readBoolean(row, 'ocr_tables_enabled'),
    ocrFormsEnabled: readBoolean(row, 'ocr_forms_enabled'),
    ocrQueriesEnabled: readBoolean(row, 'ocr_queries_enabled'),
    batchEmbeddingEnabled: readBoolean(row, 'batch_embedding_enabled'),
    batchEmbeddingMinChunks: readNumber(row, 'batch_embedding_min_chunks'),
  }
}

/**
 * The caps a **library** document is ingested under (§5B).
 *
 * A library belongs to no portal, so there is no `client_settings` row to read and
 * no tenant to bill. These mirror the column defaults in `0001_init.sql`, which is
 * the same thing a freshly created client gets — so a library document is processed
 * exactly like a new tenant's first upload, never more permissively.
 *
 * The two monthly budgets are `null` deliberately, and that is not a loosening: they
 * default to `null` in the schema too, and a *per-client* monthly budget cannot be
 * charged to a document five portals share. `maxOcrPagesPerUpload` is kept, because
 * it caps a single runaway scan rather than apportioning cost.
 *
 * Written out here rather than read back from the database: one more query on every
 * library parse, to fetch values that have not changed since the schema was written,
 * is not worth it. The cost of that choice is drift if 0001's defaults are ever
 * edited, which is why they are named in this comment and asserted in
 * `tests/source-config.test.ts`.
 */
export const LIBRARY_INGEST_SETTINGS: ClientSettings = {
  clientId: '',
  retrievalMode: 'precision',
  maxAnswerTokens: 800,
  maxRetrievedTokens: 1500,
  maxOcrPagesPerUpload: 10000,
  monthlyTokenBudget: null,
  monthlyOcrPageBudget: null,
  ocrTablesEnabled: false,
  ocrFormsEnabled: false,
  ocrQueriesEnabled: false,
  // From 0002, not 0001, and both differ from what a reader might guess: batch
  // embedding is off by default and the threshold is 400 chunks.
  batchEmbeddingEnabled: false,
  batchEmbeddingMinChunks: 400,
}

/**
 * The settings to ingest one document under, whoever owns it.
 *
 * The single place the pipeline asks "what are my caps", so a library document
 * cannot accidentally take a code path that assumes a tenant — which is what
 * `getClientSettings(null)` would have had to become, and it would have thrown.
 */
export async function getIngestSettings(
  clientId: string | null,
): Promise<ClientSettings> {
  return clientId === null ? LIBRARY_INGEST_SETTINGS : getClientSettings(clientId)
}

export interface SettingsPatch {
  retrievalMode?: unknown
  maxAnswerTokens?: unknown
  maxRetrievedTokens?: unknown
  maxOcrPagesPerUpload?: unknown
  monthlyTokenBudget?: unknown
  monthlyOcrPageBudget?: unknown
  ocrTablesEnabled?: unknown
  ocrFormsEnabled?: unknown
  ocrQueriesEnabled?: unknown
  batchEmbeddingEnabled?: unknown
  batchEmbeddingMinChunks?: unknown
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new HttpError(400, `${field} must be an integer`)
  }
  if (parsed < min || parsed > max) {
    throw new HttpError(400, `${field} must be between ${min} and ${max}`)
  }
  return parsed
}

function nullableInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === null) return null
  return boundedInteger(value, field, min, max)
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean`)
  return value
}

/**
 * Validate and apply a settings patch. Bounds mirror the CHECK constraints so an
 * invalid value is a clear 400 rather than a database error.
 */
export async function updateClientSettings(
  clientId: string,
  patch: SettingsPatch,
): Promise<ClientSettings> {
  const values: Record<string, unknown> = {}

  // Refused, not ignored. Dropping an unknown key and reporting success is the
  // failure §5C found in the admin settings routes: a caller sets a value, is told it
  // was saved, and it never was. There is one retrieval behaviour now, so saying so
  // is the honest answer.
  if (patch.retrievalMode !== undefined) {
    throw new HttpError(
      400,
      'retrievalMode can no longer be set: Precision is the only retrieval behaviour',
    )
  }
  if (patch.maxAnswerTokens !== undefined) {
    values.max_answer_tokens = boundedInteger(patch.maxAnswerTokens, 'maxAnswerTokens', 64, 4096)
  }
  if (patch.maxRetrievedTokens !== undefined) {
    values.max_retrieved_tokens = boundedInteger(patch.maxRetrievedTokens, 'maxRetrievedTokens', 256, 32768)
  }
  if (patch.maxOcrPagesPerUpload !== undefined) {
    values.max_ocr_pages_per_upload = boundedInteger(patch.maxOcrPagesPerUpload, 'maxOcrPagesPerUpload', 1, 100000)
  }
  if (patch.monthlyTokenBudget !== undefined) {
    values.monthly_token_budget = nullableInteger(patch.monthlyTokenBudget, 'monthlyTokenBudget', 0, 1_000_000_000)
  }
  if (patch.monthlyOcrPageBudget !== undefined) {
    values.monthly_ocr_page_budget = nullableInteger(patch.monthlyOcrPageBudget, 'monthlyOcrPageBudget', 0, 10_000_000)
  }
  if (patch.ocrTablesEnabled !== undefined) {
    values.ocr_tables_enabled = booleanValue(patch.ocrTablesEnabled, 'ocrTablesEnabled')
  }
  if (patch.ocrFormsEnabled !== undefined) {
    values.ocr_forms_enabled = booleanValue(patch.ocrFormsEnabled, 'ocrFormsEnabled')
  }
  if (patch.ocrQueriesEnabled !== undefined) {
    values.ocr_queries_enabled = booleanValue(patch.ocrQueriesEnabled, 'ocrQueriesEnabled')
  }

  if (patch.batchEmbeddingEnabled !== undefined) {
    values.batch_embedding_enabled = booleanValue(patch.batchEmbeddingEnabled, 'batchEmbeddingEnabled')
  }
  if (patch.batchEmbeddingMinChunks !== undefined) {
    values.batch_embedding_min_chunks = boundedInteger(
      patch.batchEmbeddingMinChunks,
      'batchEmbeddingMinChunks',
      1,
      1000000,
    )
  }

  if (Object.keys(values).length === 0) throw new HttpError(400, 'No settings to update')

  await getClientSettings(clientId)
  await updateRows('client_settings', values, [
    { column: 'client_id', operator: 'eq', value: clientId },
  ])

  return getClientSettings(clientId)
}

// ---------------------------------------------------------------------------
// settings precedence
// ---------------------------------------------------------------------------

/** Which layer an effective value came from. Employees see this; clients never do. */
export type SettingsLayer = 'portal' | 'client' | 'default'

export interface EffectiveSettings extends ClientSettings {
  /** Per-key provenance, so the admin UI can show where a value was set. */
  source: Partial<Record<keyof ClientSettings, SettingsLayer>>
}

/** Keys a portal may override. Ids and provenance are deliberately not overridable. */
const OVERRIDABLE: Array<keyof ClientSettings> = [
  'maxAnswerTokens',
  'maxRetrievedTokens',
  'maxOcrPagesPerUpload',
  'monthlyTokenBudget',
  'monthlyOcrPageBudget',
  'ocrTablesEnabled',
  'ocrFormsEnabled',
  'ocrQueriesEnabled',
  'batchEmbeddingEnabled',
  'batchEmbeddingMinChunks',
]

/**
 * Resolve the settings in force for one portal.
 *
 * Precedence is portal override -> client settings -> hard-coded defaults. The
 * `app_settings.defaults` layer between the last two arrives with migration 0004 in
 * Phase 4B; the chain is written so inserting it changes one function, not callers.
 *
 * Resolved once per request and passed down — never re-read mid-request, so a value
 * cannot change between the budget check and the call it guards.
 */
export async function resolveEffectiveSettings(
  clientId: string,
  portalId: string,
): Promise<EffectiveSettings> {
  const base = await getClientSettings(clientId)
  const source: EffectiveSettings['source'] = {}
  for (const key of OVERRIDABLE) source[key] = 'client'

  const row = await queryOne(
    'SELECT settings_override FROM portals WHERE portal_id = $1',
    [portalId],
  )
  const raw = row?.settings_override
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...base, source }
  }

  const override = raw as Record<string, unknown>
  const resolved: ClientSettings = { ...base }

  for (const key of OVERRIDABLE) {
    if (!Object.prototype.hasOwnProperty.call(override, key)) continue
    const value = override[key]

    // Validate per key rather than trusting the JSONB blob: a bad override must not
    // be able to widen a cap or break a type.
    if (
      key === 'ocrTablesEnabled' ||
      key === 'ocrFormsEnabled' ||
      key === 'ocrQueriesEnabled' ||
      key === 'batchEmbeddingEnabled'
    ) {
      if (typeof value === 'boolean') {
        resolved[key] = value
        source[key] = 'portal'
      }
      continue
    }
    if (key === 'monthlyTokenBudget' || key === 'monthlyOcrPageBudget') {
      if (value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)) {
        resolved[key] = value as number | null
        source[key] = 'portal'
      }
      continue
    }
    // Everything left is a positive-integer cap.
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      switch (key) {
        case 'maxAnswerTokens':
        case 'maxRetrievedTokens':
        case 'maxOcrPagesPerUpload':
        case 'batchEmbeddingMinChunks':
          resolved[key] = value
          source[key] = 'portal'
          break
        default:
          break
      }
    }
  }

  return { ...resolved, source }
}
