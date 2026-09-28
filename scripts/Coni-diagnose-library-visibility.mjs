/**
 * Read-only diagnosis: why a library's documents are not showing in a portal.
 *
 * Runs SELECTs only — no INSERT, UPDATE or DELETE, so it is safe on prod.
 *
 *   node scripts/Coni-diagnose-library-visibility.mjs [--stage prod]
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, IsolatedStoresApi } from '@fusebase/fusebase-gate-sdk'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_ALIAS = 'compasses'

function readEnvFile() {
  const out = {}
  let raw
  try {
    raw = readFileSync(join(ROOT, '.env'), 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

function table(rows) {
  if (!rows || rows.length === 0) return '  (none)'
  return rows.map((r) => '  ' + JSON.stringify(r)).join('\n')
}

async function main() {
  let stage = 'prod'
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--stage') stage = argv[i + 1]

  const env = { ...readEnvFile(), ...process.env }
  const host = env.FUSEBASE_HOST
  const token = env.GATE_MCP_TOKEN
  const orgId = env.FBS_ORG_ID ?? 'u27b70'
  if (!host || !token) throw new Error('FUSEBASE_HOST and GATE_MCP_TOKEN are required')

  const api = new IsolatedStoresApi(
    createClient({
      baseUrl: `https://app-api.${host}/v4/api/proxy/gate-service/v1`,
      defaultHeaders: { authorization: `Bearer ${token}` },
    }),
  )
  const stores = await api.listIsolatedStores({ path: { orgId } })
  const store = (stores.stores ?? []).find((s) => s.alias === STORE_ALIAS)
  if (!store) throw new Error(`no store aliased ${STORE_ALIAS}`)
  const storeId = store.globalId

  const q = async (sql, params = []) => {
    const r = await api.queryIsolatedStoreSql({ path: { orgId, storeId, stage }, body: { sql, params } })
    return r.result?.rows ?? []
  }

  console.log(`store=${storeId} alias=${STORE_ALIAS} stage=${stage}\n`)

  console.log('== libraries ==')
  console.log(table(await q(`
    SELECT s.id, s.name, s.archived_at IS NOT NULL AS archived,
           (SELECT count(*) FROM documents d WHERE d.library_id = s.id AND d.deleted_at IS NULL) AS docs,
           (SELECT count(*) FROM documents d WHERE d.library_id = s.id AND d.deleted_at IS NULL AND d.status = 'indexed') AS indexed,
           (SELECT count(*) FROM portal_source_bindings b WHERE b.source_id = s.id) AS ticked_portals
      FROM document_sources s
     WHERE s.kind = 'library'
     ORDER BY s.created_at DESC`)))

  console.log('\n== library documents (newest 25) ==')
  console.log(table(await q(`
    SELECT d.id, d.name, d.status, d.status_detail, d.error_message,
           d.chunk_count, s.name AS library, d.created_at
      FROM documents d JOIN document_sources s ON s.id = d.library_id
     WHERE d.library_id IS NOT NULL AND d.deleted_at IS NULL
     ORDER BY d.created_at DESC LIMIT 25`)))

  console.log('\n== ticks (library -> portal) ==')
  console.log(table(await q(`
    SELECT s.name AS library, p.label AS portal, p.portal_id, p.status AS portal_status
      FROM portal_source_bindings b
      JOIN document_sources s ON s.id = b.source_id AND s.kind = 'library'
      JOIN portals p ON p.id = b.portal_row_id
     ORDER BY s.name, p.label`)))

  console.log('\n== portals ==')
  console.log(table(await q(`
    SELECT p.id, p.portal_id, p.label, p.status, p.last_seen_at,
           (SELECT count(*) FROM portal_visible_documents v WHERE v.portal_id = p.portal_id) AS visible_docs
      FROM portals p ORDER BY p.label`)))

  console.log('\n== pending ingest jobs touching libraries ==')
  console.log(table(await q(`
    SELECT j.id, j.kind, j.status, j.attempts, j.max_attempts, j.next_run_at,
           j.locked_by, left(coalesce(j.last_error,''), 200) AS last_error, j.document_id
      FROM ingest_jobs j
     WHERE j.library_id IS NOT NULL
       AND j.status <> 'done'
     ORDER BY j.created_at DESC LIMIT 25`)))

  console.log('\n== open alerts (newest 10) ==')
  console.log(table(await q(`
    SELECT code, severity, status, occurrences, left(cause, 160) AS cause, last_seen_at
      FROM system_alerts WHERE status <> 'resolved'
     ORDER BY last_seen_at DESC LIMIT 10`)))

  console.log('\n== portal_visible_documents definition ==')
  const def = await q(`SELECT pg_get_viewdef('public.portal_visible_documents'::regclass, true) AS def`)
  console.log(def[0]?.def ?? '(missing)')
}

main().catch((error) => {
  console.error(error?.message ?? error)
  process.exitCode = 1
})
