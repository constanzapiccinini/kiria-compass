/**
 * Settings — §9 screen 5 and §5.3.
 *
 * Three layers, most specific wins: **portal override → client → org defaults**.
 * Every effective value is returned with the layer it came from, because the common
 * support question is not "what is this set to" but "why is it set to that", and a
 * bare value cannot answer it.
 *
 * Each overridable key is validated individually rather than spread from the JSONB
 * blob. A malformed override must not be able to widen a cap or change a type — and
 * a blob spread would let it.
 */

import { Hono } from 'hono'
import { orgId } from '../lib/config.js'
import { HttpError, isUuid } from '../lib/auth.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { recordAudit } from '../lib/observability.js'
import { insertRow, query, queryOne, readString, updateRows } from '../lib/store.js'

export const settingsRoutes = new Hono()

export type SettingsLayer = 'default' | 'org' | 'client' | 'portal'

/**
 * The built-in floor.
 *
 * Present so a store with no `app_settings` row still resolves to something usable —
 * a fresh org should not have to configure anything before the product works.
 */
const BUILT_IN_DEFAULTS = {
  maxAnswerTokens: 800,
  maxRetrievedTokens: 1500,
  maxOcrPagesPerUpload: 10000,
  monthlyTokenBudget: null as number | null,
  monthlyOcrPageBudget: null as number | null,
  ocrTablesEnabled: false,
  ocrFormsEnabled: false,
  ocrQueriesEnabled: false,
  batchEmbeddingEnabled: false,
  batchEmbeddingMinChunks: 400,
  retentionDays: null as number | null,
} as const

type SettingsKey = keyof typeof BUILT_IN_DEFAULTS

/**
 * Keys that used to exist and are now refused by name.
 *
 * An unknown key is already refused generically. This exists so the message says
 * *why* — "Precision is the only retrieval behaviour" is an answer; "unknown field
 * retrievalMode" reads like a typo and sends the reader looking for the right
 * spelling of something that is gone.
 *
 * The column stays until the 6B prune, so old rows are readable; nothing writes it.
 */
const REMOVED_KEYS: Record<string, string> = {
  retrievalMode:
    'retrievalMode was removed in Phase 7: Precision is the only retrieval behaviour',
}

/** Validators per key. A value that fails is refused, never coerced or dropped. */
const VALIDATORS: Record<SettingsKey, (value: unknown) => unknown | undefined> = {
  maxAnswerTokens: (value) => boundedInt(value, 100, 4000),
  maxRetrievedTokens: (value) => boundedInt(value, 200, 20000),
  maxOcrPagesPerUpload: (value) => boundedInt(value, 1, 100000),
  monthlyTokenBudget: (value) => nullableInt(value, 0, 1_000_000_000),
  monthlyOcrPageBudget: (value) => nullableInt(value, 0, 10_000_000),
  ocrTablesEnabled: (value) => (typeof value === 'boolean' ? value : undefined),
  ocrFormsEnabled: (value) => (typeof value === 'boolean' ? value : undefined),
  ocrQueriesEnabled: (value) => (typeof value === 'boolean' ? value : undefined),
  batchEmbeddingEnabled: (value) => (typeof value === 'boolean' ? value : undefined),
  batchEmbeddingMinChunks: (value) => boundedInt(value, 1, 100000),
  retentionDays: (value) => nullableInt(value, 1, 3650),
}

/**
 * Validate a whole settings patch, or refuse the whole request.
 *
 * **Refusing beats reporting.** These handlers used to validate each key, drop the
 * ones that failed, apply the rest, and answer `200 { ok: true, rejected: [...] }`.
 * Every caller in this codebase — and every `fetch` wrapper anyone would write —
 * checks the status and nothing else, so an operator who typed 99999 into a cap was
 * told the change was saved while the value never moved. That is the quiet kind of
 * wrong: the screen agrees with them and the limit they think they set is not in
 * force. It was found by a test moved here from the client app, whose own version of
 * this route had refused properly all along.
 *
 * Validating the entire patch first also makes the write atomic. A body mixing one
 * good field with one bad one used to apply the good one, so a rejected request could
 * still change configuration — which is the worst possible reading of "rejected".
 *
 * Unknown keys are refused for the same reason: a misspelled key is a setting the
 * caller believes they changed.
 */
function validateSettingsPatch(body: Record<string, unknown>): Record<string, unknown> {
  const accepted: Record<string, unknown> = {}
  const rejected: string[] = []
  const unknown: string[] = []

  const removed: string[] = []

  for (const [key, value] of Object.entries(body)) {
    // Named before "unknown", so a key that used to work gets an explanation rather
    // than a spelling correction.
    if (key in REMOVED_KEYS) {
      removed.push(REMOVED_KEYS[key])
      continue
    }
    if (!(key in BUILT_IN_DEFAULTS)) {
      unknown.push(key)
      continue
    }
    const validated = VALIDATORS[key as SettingsKey](value)
    if (validated === undefined) rejected.push(`${key}=${JSON.stringify(value)}`)
    else accepted[key] = validated
  }

  if (unknown.length > 0 || rejected.length > 0 || removed.length > 0) {
    const parts: string[] = []
    // The field name is in the message on purpose: "invalid settings" leaves an
    // operator with a form of eleven values and no idea which one to fix.
    if (rejected.length > 0) parts.push(`out of range or wrong type: ${rejected.join(', ')}`)
    if (unknown.length > 0) parts.push(`not a setting: ${unknown.join(', ')}`)
    for (const message of removed) parts.push(message)
    throw new HttpError(400, `Nothing was saved — ${parts.join('; ')}`, 'INVALID_SETTINGS')
  }

  if (Object.keys(accepted).length === 0) {
    throw new HttpError(400, 'Nothing to change', 'BAD_REQUEST')
  }

  return accepted
}

function boundedInt(value: unknown, min: number, max: number): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.floor(numeric)
  return rounded >= min && rounded <= max ? rounded : undefined
}

function nullableInt(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null) return null
  return boundedInt(value, min, max)
}

/** Column name for a key, since the client layer is real columns, not a blob. */
const CLIENT_COLUMNS: Partial<Record<SettingsKey, string>> = {
  maxAnswerTokens: 'max_answer_tokens',
  maxRetrievedTokens: 'max_retrieved_tokens',
  maxOcrPagesPerUpload: 'max_ocr_pages_per_upload',
  monthlyTokenBudget: 'monthly_token_budget',
  monthlyOcrPageBudget: 'monthly_ocr_page_budget',
  ocrTablesEnabled: 'ocr_tables_enabled',
  ocrFormsEnabled: 'ocr_forms_enabled',
  ocrQueriesEnabled: 'ocr_queries_enabled',
  batchEmbeddingEnabled: 'batch_embedding_enabled',
  batchEmbeddingMinChunks: 'batch_embedding_min_chunks',
}

function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  // JSONB can arrive as a string depending on the driver path; parse rather than
  // silently treating a populated blob as empty.
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  return {}
}

interface EffectiveValue {
  value: unknown
  source: SettingsLayer
}

/**
 * Resolve the effective settings for a client, and optionally a portal.
 *
 * Layers are applied in order and each key records the last layer that supplied a
 * *valid* value, so provenance reflects what actually took effect rather than what
 * someone tried to set.
 */
settingsRoutes.get('/', async (c) => {
  await requireAdmin(c)

  const clientId = c.req.query('clientId')
  if (!clientId || !isUuid(clientId)) {
    throw new HttpError(400, 'clientId is required', 'BAD_REQUEST')
  }
  const portalRowId = c.req.query('portalRowId')
  if (portalRowId && !isUuid(portalRowId)) {
    throw new HttpError(400, 'portalRowId must be a UUID', 'BAD_REQUEST')
  }

  const effective = new Map<SettingsKey, EffectiveValue>()
  for (const [key, value] of Object.entries(BUILT_IN_DEFAULTS)) {
    effective.set(key as SettingsKey, { value, source: 'default' })
  }

  const apply = (raw: Record<string, unknown>, layer: SettingsLayer): void => {
    for (const key of Object.keys(BUILT_IN_DEFAULTS) as SettingsKey[]) {
      if (!(key in raw)) continue
      const validated = VALIDATORS[key](raw[key])
      if (validated === undefined) continue
      effective.set(key, { value: validated, source: layer })
    }
  }

  // Layer 1: org defaults.
  const appSettings = await queryOne(
    'SELECT defaults FROM app_settings WHERE org_id = $1',
    [orgId()],
  )
  if (appSettings) apply(readJsonObject(appSettings.defaults), 'org')

  // Layer 2: the client's own columns.
  const clientRow = await queryOne(
    `SELECT ${Object.values(CLIENT_COLUMNS).join(', ')} FROM client_settings WHERE client_id = $1`,
    [clientId],
  )
  if (clientRow) {
    const asCamel: Record<string, unknown> = {}
    for (const column of Object.values(CLIENT_COLUMNS)) {
      asCamel[camel(column)] = clientRow[column]
    }
    apply(asCamel, 'client')
  }

  // `retention_days` lives on the client row, not client_settings.
  const client = await queryOne('SELECT retention_days FROM clients WHERE id = $1', [clientId])
  if (client && client.retention_days !== null && client.retention_days !== undefined) {
    apply({ retentionDays: client.retention_days }, 'client')
  }

  // Layer 3: the portal override, most specific.
  if (portalRowId) {
    const portal = await queryOne(
      'SELECT settings_override FROM portals WHERE id = $1 AND client_id = $2',
      [portalRowId, clientId],
    )
    // Scoped by client as well as id: a portal id belonging to another client must
    // not be able to pull its override into this client's resolution.
    if (!portal) throw new HttpError(404, 'Portal not found for this client', 'NOT_FOUND')
    apply(readJsonObject(portal.settings_override), 'portal')
  }

  const settings: Record<string, unknown> = {}
  const sources: Record<string, SettingsLayer> = {}
  for (const [key, entry] of effective) {
    settings[key] = entry.value
    sources[key] = entry.source
  }

  return c.json({ settings, sources })
})

/** Write the org defaults layer. */
settingsRoutes.put('/defaults', async (c) => {
  const actor = await requireAdmin(c)
  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }

  const accepted = validateSettingsPatch(body as Record<string, unknown>)

  const existing = await queryOne('SELECT org_id FROM app_settings WHERE org_id = $1', [orgId()])
  if (existing) {
    await updateRows(
      'app_settings',
      { defaults: JSON.stringify(accepted), updated_by_user_id: actor.userId },
      [{ column: 'org_id', operator: 'eq', value: orgId() }],
    )
  } else {
    await insertRow(
      'app_settings',
      { org_id: orgId(), defaults: JSON.stringify(accepted), updated_by_user_id: actor.userId },
      ['org_id'],
    )
  }

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: 'settings.defaults_updated',
    targetType: 'org',
    targetId: orgId(),
    metadata: { keys: Object.keys(accepted) },
  })

  return c.json({ ok: true, applied: Object.keys(accepted) })
})

/** Write a portal's override layer. */
settingsRoutes.put('/portals/:portalRowId', async (c) => {
  const actor = await requireAdmin(c)
  const portalRowId = c.req.param('portalRowId')
  if (!isUuid(portalRowId)) throw new HttpError(400, 'portalRowId must be a UUID', 'BAD_REQUEST')

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }

  const accepted = validateSettingsPatch(body as Record<string, unknown>)

  const updated = await updateRows(
    'portals',
    { settings_override: JSON.stringify(accepted) },
    [{ column: 'id', operator: 'eq', value: portalRowId }],
  )
  if (updated === 0) throw new HttpError(404, 'Portal not found', 'NOT_FOUND')

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: 'settings.portal_override_updated',
    targetType: 'portal',
    targetId: portalRowId,
    metadata: { keys: Object.keys(accepted) },
  })

  return c.json({ ok: true, applied: Object.keys(accepted) })
})

/** Write the client layer. Columns, not a blob, so the database types them. */
settingsRoutes.put('/clients/:clientId', async (c) => {
  const actor = await requireAdmin(c)
  const clientId = c.req.param('clientId')
  if (!isUuid(clientId)) throw new HttpError(400, 'clientId must be a UUID', 'BAD_REQUEST')

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }

  // Validated in full before anything is written, so a body mixing a good field with
  // a bad one changes nothing at all rather than half-applying.
  const accepted = validateSettingsPatch(body as Record<string, unknown>)

  const values: Record<string, unknown> = {}
  let retentionDays: number | null | undefined

  for (const [key, validated] of Object.entries(accepted)) {
    // `retentionDays` lives on `clients`, not `client_settings` — the only key in
    // this layer that is not a `client_settings` column.
    if (key === 'retentionDays') {
      retentionDays = validated as number | null
      continue
    }
    const column = CLIENT_COLUMNS[key as SettingsKey]
    if (column) values[column] = validated
  }

  if (Object.keys(values).length > 0) {
    const existing = await queryOne('SELECT client_id FROM client_settings WHERE client_id = $1', [
      clientId,
    ])
    if (existing) {
      await updateRows('client_settings', values, [
        { column: 'client_id', operator: 'eq', value: clientId },
      ])
    } else {
      await insertRow('client_settings', { client_id: clientId, ...values }, ['client_id'])
    }
  }

  if (retentionDays !== undefined) {
    const updated = await updateRows('clients', { retention_days: retentionDays }, [
      { column: 'id', operator: 'eq', value: clientId },
    ])
    if (updated === 0) throw new HttpError(404, 'Client not found', 'NOT_FOUND')
  }

  await recordAudit({
    orgId: orgId(),
    clientId,
    actorUserId: actor.userId,
    action: 'settings.client_updated',
    targetType: 'client',
    targetId: clientId,
    metadata: { keys: Object.keys(accepted), retentionDays },
  })

  return c.json({ ok: true, applied: Object.keys(accepted) })
})

/** Portals of a client, for the override picker. */
settingsRoutes.get('/portals', async (c) => {
  await requireAdmin(c)
  const clientId = c.req.query('clientId')
  if (!clientId || !isUuid(clientId)) {
    throw new HttpError(400, 'clientId is required', 'BAD_REQUEST')
  }

  const rows = await query(
    'SELECT id, portal_id, label, settings_override FROM portals WHERE client_id = $1 ORDER BY label',
    [clientId],
  )

  return c.json({
    portals: rows.map((row) => ({
      id: readString(row, 'id'),
      portalId: readString(row, 'portal_id'),
      label: readString(row, 'label'),
      override: readJsonObject(row.settings_override),
    })),
  })
})
