/**
 * FuseBase PostgreSQL Database access layer.
 *
 * Two paths are used deliberately:
 *   * `queryIsolatedStoreSql` (read-only, `isolated_store.read`) for reads, including
 *     the vector-similarity scan. Always parameterized — never string-interpolated.
 *   * Structured row operations (`isolated_store.data.write`) for every write, so the
 *     backend does not depend on the privileged `isolated_store.execute` escape hatch,
 *     which runtime app tokens normally do not receive.
 *
 * The store is resolved through Gate by stable alias. `storeId` is never hardcoded
 * here and never read from an app secret.
 */

import { createIsolatedStoresApi } from './gate.js'
import { currentClientId } from './request-scope.js'
import {
  STORE_ALIAS,
  appClientId,
  orgId,
  serviceGateAuth,
  stage,
  type Stage,
} from './config.js'

/** A value acceptable as a SQL bind parameter. */
export type SqlParam = string | number | boolean | null

/** One row as returned by Gate: column name -> scalar JSON value. */
export type SqlRow = Record<string, unknown>

export interface SqlFilter {
  column: string
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is_null' | 'is_not_null'
  value?: unknown
}

interface ResolvedStore {
  orgId: string
  storeId: string
  stage: Stage
}

let resolvedStore: ResolvedStore | null = null
let resolveInFlight: Promise<ResolvedStore> | null = null

interface StoreListEntry {
  globalId?: unknown
  alias?: unknown
}

/** Narrow one entry of the `listIsolatedStores` response without casting to `any`. */
function readStoreEntry(value: unknown): { globalId: string; alias: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as StoreListEntry
  if (typeof entry.globalId !== 'string' || typeof entry.alias !== 'string') return null
  return { globalId: entry.globalId, alias: entry.alias }
}

/**
 * Resolve the isolated store through Gate by alias, and verify the backend token can
 * actually reach it. Cached per process; the mapping is immutable for the app.
 */
export async function resolveStore(): Promise<ResolvedStore> {
  if (resolvedStore) return resolvedStore
  if (resolveInFlight) return resolveInFlight

  resolveInFlight = (async () => {
    const api = createIsolatedStoresApi(serviceGateAuth())
    const org = orgId()
    const clientId = appClientId()

    // `aliasLike` is a loosely-typed glob query param; filter by exact alias in code
    // instead so the match stays explicit.
    const response = await api.listIsolatedStores({
      path: { orgId: org },
      ...(clientId ? { query: { clientId } } : {}),
    })

    const stores = Array.isArray(response.stores) ? response.stores : []
    const match = stores.map(readStoreEntry).find((entry) => entry?.alias === STORE_ALIAS)

    if (!match) {
      throw new Error(
        `Isolated store with alias "${STORE_ALIAS}" is not reachable with this token in org ${org}. ` +
          'Run `fusebase app update <appId> --sync-gate-permissions` and redeploy.',
      )
    }

    const store: ResolvedStore = { orgId: org, storeId: match.globalId, stage: stage() }
    resolvedStore = store
    return store
  })()

  try {
    return await resolveInFlight
  } finally {
    resolveInFlight = null
  }
}

/**
 * The RLS context for the call about to be made, if any.
 *
 * Spread into every store request body, so a client-facing request carries its
 * resolved client and a background job carries nothing. Returning `{}` rather than an
 * explicit null keeps the field off the wire entirely when there is no scope — an
 * absent setting and a setting holding an empty string are different things to
 * `current_setting`, and a policy would treat them differently.
 *
 * See `request-scope.ts` for why this is implicit and why the key is custom.
 */
function rlsContextBody(): { rlsContext?: Record<string, string> } {
  const clientId = currentClientId()
  return clientId ? { rlsContext: { req_client_id: clientId } } : {}
}

/** Run a read-only parameterized SQL statement. One statement per call. */
export async function query(sql: string, params: SqlParam[] = []): Promise<SqlRow[]> {
  const store = await resolveStore()
  const api = createIsolatedStoresApi(serviceGateAuth())
  const response = await api.queryIsolatedStoreSql({
    path: { orgId: store.orgId, storeId: store.storeId, stage: store.stage },
    body: { sql, params, ...rlsContextBody() },
  })
  return Array.isArray(response.result.rows) ? (response.result.rows as SqlRow[]) : []
}

/** Run a read-only statement expecting at most one row. */
export async function queryOne(sql: string, params: SqlParam[] = []): Promise<SqlRow | null> {
  const rows = await query(sql, params)
  return rows[0] ?? null
}

/**
 * Run several read-only statements as one batch.
 *
 * Two reasons over sequential `query` calls: every isolated-store call pays a
 * ~200-300ms infrastructure floor which a batch pays once, and all statements run in
 * a single transaction — so a snapshot assembled from several queries cannot show
 * rows from different moments mid-transition.
 *
 * Reads only: an all-read batch runs in a READ ONLY transaction and needs just
 * `isolated_store.read`. Adding a write would require `isolated_store.execute`.
 */
export async function queryAll(
  statements: Array<{ sql: string; params?: SqlParam[] }>,
): Promise<SqlRow[][]> {
  if (statements.length === 0) return []
  if (statements.length > 25) {
    throw new Error(`queryAll supports at most 25 statements, got ${statements.length}`)
  }

  const store = await resolveStore()
  const api = createIsolatedStoresApi(serviceGateAuth())
  const response = await api.runIsolatedStoreSqlBatch({
    path: { orgId: store.orgId, storeId: store.storeId, stage: store.stage },
    body: {
      operations: statements.map((statement) => ({
        op: 'query' as const,
        sql: statement.sql,
        params: statement.params ?? [],
      })),
      // Set once for the whole batch: the operations run in one transaction, so the
      // context applies to all of them.
      ...rlsContextBody(),
    },
  })

  const results = Array.isArray(response.results) ? response.results : []
  return statements.map((_, index) => {
    const rows = results[index]?.result?.rows
    return Array.isArray(rows) ? (rows as SqlRow[]) : []
  })
}

/** Insert one row via the structured API. Returns the requested columns. */
export async function insertRow(
  tableName: string,
  values: Record<string, unknown>,
  returning: string[] = ['id'],
): Promise<SqlRow | null> {
  const store = await resolveStore()
  const api = createIsolatedStoresApi(serviceGateAuth())
  const response = await api.insertIsolatedStoreSqlRow({
    path: { orgId: store.orgId, storeId: store.storeId, stage: store.stage },
    body: { schemaName: 'public', tableName, values, returning, ...rlsContextBody() },
  })
  const rows = Array.isArray(response.rows) ? (response.rows as SqlRow[]) : []
  return rows[0] ?? null
}

/**
 * Insert many rows via the structured API. Postgres binds at most 65535 parameters
 * per statement, so callers are chunked by column count.
 */
export async function batchInsertRows(
  tableName: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0
  const store = await resolveStore()
  const api = createIsolatedStoresApi(serviceGateAuth())

  const columnCount = Math.max(1, Object.keys(rows[0]).length)
  const maxPerCall = Math.max(1, Math.floor(65535 / columnCount))
  let inserted = 0

  for (let i = 0; i < rows.length; i += maxPerCall) {
    const slice = rows.slice(i, i + maxPerCall)
    const response = await api.batchInsertIsolatedStoreSqlRows({
      path: { orgId: store.orgId, storeId: store.storeId, stage: store.stage },
      body: { schemaName: 'public', tableName, rows: slice, ...rlsContextBody() },
    })
    inserted += typeof response.rowCount === 'number' ? response.rowCount : slice.length
  }
  return inserted
}

/** Update rows matching filters. Returns the number of rows changed. */
export async function updateRows(
  tableName: string,
  values: Record<string, unknown>,
  filters: SqlFilter[],
): Promise<number> {
  if (filters.length === 0) {
    throw new Error(`updateRows on ${tableName} requires at least one filter`)
  }
  const store = await resolveStore()
  const api = createIsolatedStoresApi(serviceGateAuth())
  const response = await api.updateIsolatedStoreSqlRows({
    path: { orgId: store.orgId, storeId: store.storeId, stage: store.stage },
    body: { schemaName: 'public', tableName, values, filters, ...rlsContextBody() },
  })
  return typeof response.rowCount === 'number' ? response.rowCount : 0
}

/** Delete rows matching filters. Returns the number of rows removed. */
export async function deleteRows(tableName: string, filters: SqlFilter[]): Promise<number> {
  if (filters.length === 0) {
    throw new Error(`deleteRows on ${tableName} requires at least one filter`)
  }
  const store = await resolveStore()
  const api = createIsolatedStoresApi(serviceGateAuth())
  const response = await api.deleteIsolatedStoreSqlRows({
    path: { orgId: store.orgId, storeId: store.storeId, stage: store.stage },
    body: { schemaName: 'public', tableName, filters, ...rlsContextBody() },
  })
  return typeof response.rowCount === 'number' ? response.rowCount : 0
}

// ---------------------------------------------------------------------------
// row value readers — narrow Gate JSON at the boundary, no casts to `any`
// ---------------------------------------------------------------------------

export function readString(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  throw new Error(`Expected string in column "${column}", got ${typeof value}`)
}

export function readOptionalString(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

export function readNumber(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  // Postgres BIGINT / NUMERIC arrive as strings over JSON.
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error(`Expected number in column "${column}", got ${typeof value}`)
}

export function readOptionalNumber(row: SqlRow, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function readBoolean(row: SqlRow, column: string, fallback = false): boolean {
  const value = row[column]
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 't') return true
  if (value === 'false' || value === 'f') return false
  return fallback
}

export function readStringArray(row: SqlRow, column: string): string[] {
  const value = row[column]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  // Postgres TEXT[] may arrive as the literal `{a,b}` form.
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim()
    if (inner.length === 0) return []
    return inner.split(',').map((part) => part.replace(/^"|"$/g, ''))
  }
  return []
}

/** Format a JS number array as a Postgres array literal for a bind parameter. */
export function toPgFloatArrayLiteral(values: number[]): string {
  return `{${values.map((value) => (Number.isFinite(value) ? value.toString() : '0')).join(',')}}`
}

/** Format a JS string array as a Postgres array literal for a bind parameter. */
export function toPgTextArrayLiteral(values: string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return `{${escaped.join(',')}}`
}
