/**
 * The data half of the 6B prune — §6B.
 *
 * ---------------------------------------------------------------------------
 * Why this is a script and not part of the migration
 *
 * Gate rejects top-level `INSERT` / `UPDATE` / `DELETE` inside a migration bundle:
 * bundles are schema-only, by contract. Every step below is DML, so it cannot live in
 * `0019` however much it belongs to the same change. It therefore has to run **first**
 * and be verified, because three of the schema changes in `0019` will **fail against
 * existing rows** without it:
 *
 *   1. `document_sources.kind` narrowed to `'library'` — six archived `app_upload`
 *      rows still exist. A CHECK is validated against the rows that are there.
 *   2. `document_sources.owner_kind` narrowed to `'library'` — the same six carry
 *      `owner_kind = 'client'`.
 *   3. `ingest_jobs.kind` with `'source_sync'` removed — eleven completed sync jobs
 *      are still in the queue table across the two stages.
 *
 * A failing apply rolls back cleanly, so getting this wrong costs a confusing error
 * rather than a broken database. It is still worth doing in the right order.
 *
 * ---------------------------------------------------------------------------
 * What it changes, and what each deletion actually destroys
 *
 * **The six `app_upload` sources.** Already archived and unbound by
 * `retire-app-upload-sources.mjs`, holding no documents, and — verified here rather
 * than assumed — referenced by nothing: not a document, a binding, an alert, a job, a
 * usage row or an embedding batch. They are the `source` concept itself, which is
 * what §6B removes. The script refuses to touch one that anything still points at.
 *
 * **The completed `source_sync` jobs.** `ingest_jobs` is a work queue, not the audit
 * trail — `audit_log` is a separate table and keeps its own record. A terminal job row
 * is spent. Only `succeeded` and `failed` rows are removed, and the run **aborts** if
 * any `source_sync` job is still `queued` or `running`: that would mean a worker is
 * about to look for a handler this release deleted.
 *
 * **`retrieval_mode = 'economy'` → `'precision'`.** Asked for by Phase 7 §5, which
 * removed the mode from the code but deliberately left the column for this prune. The
 * column stays; only the values are normalised, so no stored row contradicts the
 * code. Nothing reads it any more — `toRetrievalMode` narrows on read — so this is
 * tidiness rather than a fix, and it is the last moment it can be done cheaply.
 *
 * ---------------------------------------------------------------------------
 * The check that decides whether this worked
 *
 * **The per-portal visible count must not change.** The same measurement the §6.5
 * migration used, for the same reason: it is the only number that is the product, and
 * it is what caught that migration's one real bug. Printed before and after, and a
 * difference fails the run.
 *
 *   node scripts/prune-6b-preflight.mjs --stage dev            (dry run)
 *   node scripts/prune-6b-preflight.mjs --stage dev --apply
 *   node scripts/prune-6b-preflight.mjs --stage prod --apply --yes
 *
 * Idempotent: a second run finds nothing left and says so.
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

function parseArgs(argv) {
  let stage = 'dev'
  let apply = false
  let yes = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--stage') stage = argv[i + 1]
    if (argv[i] === '--apply') apply = true
    if (argv[i] === '--yes') yes = true
  }
  if (stage !== 'dev' && stage !== 'prod') throw new Error('--stage must be dev or prod')
  if (stage === 'prod' && apply && !yes) throw new Error('refusing to write to prod without --yes')
  return { stage, apply }
}

async function main() {
  const { stage, apply } = parseArgs(process.argv.slice(2))
  const env = { ...readEnvFile(), ...process.env }
  const token = (env.GATE_MCP_TOKEN ?? '').trim()
  if (!token) throw new Error('GATE_MCP_TOKEN is not set')

  const orgId = JSON.parse(readFileSync(join(ROOT, 'fusebase.json'), 'utf8')).orgId
  const host = (env.FUSEBASE_HOST ?? 'thefusebase.com').trim()

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

  const q = async (sql, params = []) =>
    (await api.queryIsolatedStoreSql({ path: { orgId, storeId, stage }, body: { sql, params } }))
      .result?.rows ?? []

  const exec = async (sql, params = []) => {
    if (!apply) return 0
    const r = await api.executeIsolatedStoreSql({
      path: { orgId, storeId, stage },
      body: { sql, params },
    })
    return r.result?.rowCount ?? 0
  }

  console.log(`store ${storeId} alias=${STORE_ALIAS} stage=${stage}${apply ? '' : ' (dry run)'}\n`)

  // --- before -------------------------------------------------------------
  const visibleBefore = await q(
    `SELECT p.portal_id, p.label, count(DISTINCT v.document_id) AS visible
       FROM portals p
       LEFT JOIN portal_visible_documents v ON v.portal_id = p.portal_id
      GROUP BY p.portal_id, p.label
      ORDER BY p.label`,
  )
  console.log('== per-portal visible documents, before ==')
  for (const row of visibleBefore) console.log(`  ${row.label}: ${row.visible}`)
  console.log()

  // --- 1. the non-library sources ----------------------------------------
  const orphanSources = await q(
    `SELECT s.id, s.name, s.kind, s.owner_kind, s.archived_at,
            (SELECT count(*) FROM documents d          WHERE d.source_id  = s.id) AS docs,
            (SELECT count(*) FROM documents d          WHERE d.library_id = s.id) AS lib_docs,
            (SELECT count(*) FROM portal_source_bindings b WHERE b.source_id  = s.id) AS bindings,
            (SELECT count(*) FROM system_alerts a      WHERE a.source_id  = s.id) AS alerts,
            (SELECT count(*) FROM ingest_jobs j        WHERE j.library_id = s.id) AS jobs,
            (SELECT count(*) FROM usage_events u       WHERE u.library_id = s.id) AS usage,
            (SELECT count(*) FROM embedding_batches e  WHERE e.library_id = s.id) AS batches
       FROM document_sources s
      WHERE s.kind <> 'library' OR s.owner_kind <> 'library'
      ORDER BY s.name`,
  )

  const referenceColumns = ['docs', 'lib_docs', 'bindings', 'alerts', 'jobs', 'usage', 'batches']
  const stillReferenced = orphanSources.filter((row) =>
    referenceColumns.some((column) => Number(row[column]) > 0),
  )

  if (stillReferenced.length > 0) {
    console.log('REFUSED — these non-library sources are still referenced:\n')
    for (const row of stillReferenced) {
      const detail = referenceColumns
        .filter((column) => Number(row[column]) > 0)
        .map((column) => `${column}=${row[column]}`)
        .join(', ')
      console.log(`  ${row.name} (${row.kind}/${row.owner_kind}): ${detail}`)
    }
    console.log(
      '\nDeleting one of these would take its rows with it or fail on a foreign key.\n' +
        'Run scripts/migrate-uploads-to-libraries.mjs and\n' +
        'scripts/retire-app-upload-sources.mjs first.',
    )
    process.exitCode = 1
    return
  }

  console.log(`== non-library sources: ${orphanSources.length} ==`)
  for (const row of orphanSources) {
    console.log(
      `  ${row.name} (${row.kind}/${row.owner_kind})` +
        `${row.archived_at === null ? ' — NOT archived' : ''}`,
    )
  }

  let sourcesDeleted = 0
  for (const row of orphanSources) {
    sourcesDeleted += await exec('DELETE FROM document_sources WHERE id = $1', [row.id])
    if (!apply) sourcesDeleted += 1
  }
  console.log(`  deleted ${sourcesDeleted}\n`)

  // --- 2. the completed source_sync jobs ---------------------------------
  const syncJobs = await q(
    `SELECT status, count(*)::int AS n FROM ingest_jobs
      WHERE kind = 'source_sync' GROUP BY status ORDER BY status`,
  )
  const live = syncJobs.filter(
    (row) => row.status === 'queued' || row.status === 'running',
  )

  if (live.length > 0) {
    console.log('REFUSED — source_sync jobs are still live:\n')
    for (const row of live) console.log(`  ${row.status}: ${row.n}`)
    console.log(
      '\nThe worker no longer has a handler for this kind (§6A.1 removed it), so a\n' +
        'queued one would fail with "Unknown job kind" on the next drain. Let the queue\n' +
        'settle, or cancel them deliberately, before pruning the check constraint.',
    )
    process.exitCode = 1
    return
  }

  console.log(`== source_sync jobs: ${syncJobs.length === 0 ? 'none' : ''} ==`)
  for (const row of syncJobs) console.log(`  ${row.status}: ${row.n}`)

  const jobsDeleted = await exec(
    `DELETE FROM ingest_jobs WHERE kind = 'source_sync' AND status IN ('succeeded', 'failed')`,
  )
  const expectedJobs = syncJobs
    .filter((row) => row.status === 'succeeded' || row.status === 'failed')
    .reduce((total, row) => total + Number(row.n), 0)
  console.log(`  deleted ${apply ? jobsDeleted : expectedJobs}\n`)

  // --- 3. retrieval_mode, normalised (Phase 7 §5) ------------------------
  const economy = await q(
    `SELECT (SELECT count(*)::int FROM client_settings WHERE retrieval_mode <> 'precision') AS settings,
            (SELECT count(*)::int FROM chats           WHERE retrieval_mode <> 'precision') AS chats`,
  )
  const economySettings = Number(economy[0]?.settings ?? 0)
  const economyChats = Number(economy[0]?.chats ?? 0)
  console.log(`== retrieval_mode <> 'precision': ${economySettings} settings, ${economyChats} chats ==`)

  if (economySettings > 0) {
    await exec(`UPDATE client_settings SET retrieval_mode = 'precision' WHERE retrieval_mode <> 'precision'`)
  }
  if (economyChats > 0) {
    await exec(`UPDATE chats SET retrieval_mode = 'precision' WHERE retrieval_mode <> 'precision'`)
  }
  console.log(`  normalised ${economySettings + economyChats}\n`)

  // --- after --------------------------------------------------------------
  const visibleAfter = await q(
    `SELECT p.portal_id, p.label, count(DISTINCT v.document_id) AS visible
       FROM portals p
       LEFT JOIN portal_visible_documents v ON v.portal_id = p.portal_id
      GROUP BY p.portal_id, p.label
      ORDER BY p.label`,
  )
  console.log('== per-portal visible documents, after ==')
  for (const row of visibleAfter) console.log(`  ${row.label}: ${row.visible}`)

  const before = new Map(visibleBefore.map((row) => [row.portal_id, String(row.visible)]))
  const differences = visibleAfter.filter(
    (row) => before.get(row.portal_id) !== String(row.visible),
  )
  console.log()
  if (differences.length > 0) {
    console.log('FAIL — a portal now sees a different number of documents:\n')
    for (const row of differences) {
      console.log(`  ${row.label}: ${before.get(row.portal_id) ?? '(new)'} -> ${row.visible}`)
    }
    process.exitCode = 1
    return
  }
  console.log('PASS — every portal sees exactly what it saw before')

  if (!apply) console.log('\n(dry run — nothing was written; re-run with --apply)')
  else console.log('\nNow apply 0019: node scripts/sql-migrate.mjs apply --stage ' + stage)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
