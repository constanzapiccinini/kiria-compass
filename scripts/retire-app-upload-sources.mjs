/**
 * Retire the `app_upload` sources — §6A.1, the last step.
 *
 * ---------------------------------------------------------------------------
 * What these were, and why they are inert now
 *
 * Every portal used to get an `app_upload` source: a per-tenant row whose only job
 * was to be the thing `documents.source_id` pointed at, because
 * `portal_visible_documents` resolved visibility through a source binding and a
 * document with no source was visible in zero portals. §3 replaced it with a private
 * library — same one-portal reach, but an ordinary library rather than a second
 * mechanism — and §6.5 moved every document that used one, clearing `source_id` as it
 * went.
 *
 * So they hold nothing. That is the condition the phase sets for retiring them, and
 * it is checked here rather than assumed: a source that still owns a document must
 * not be retired, because the document reaches its portal through it.
 *
 * ---------------------------------------------------------------------------
 * Archived, not deleted
 *
 * `archived_at` is set and the row stays. Three reasons, in order of how much they
 * matter:
 *
 *   1. **Nothing is gained by deleting.** The rows are inert either way; deletion
 *      only removes the ability to answer "where did this document used to live"
 *      while reading an audit trail that still names these ids.
 *   2. **`documents.source_id` is still a live column** for a tenant-owned document,
 *      and 6B is the release that prunes what stopped being written — deliberately
 *      not this one. Deleting the rows now would be pruning by another name.
 *   3. **It is reversible.** If some path is still found to need one, clearing
 *      `archived_at` restores it; an ON DELETE RESTRICT foreign key discovered the
 *      hard way is not so easily undone.
 *
 * Their portal bindings are removed, though, and that is the part that is not merely
 * cosmetic: a binding to a source with no documents contributes an empty arm to both
 * visibility views on every read a viewer makes, and it appears in the admin's
 * "Sources" count as something an operator might go looking for.
 *
 * ---------------------------------------------------------------------------
 *   node scripts/retire-app-upload-sources.mjs --stage dev            (dry run)
 *   node scripts/retire-app-upload-sources.mjs --stage dev --apply
 *   node scripts/retire-app-upload-sources.mjs --stage prod --apply --yes
 *
 * Idempotent: a second run finds nothing left to retire and says so.
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

  // --- the safety check, before anything ----------------------------------
  //
  // Counted per source rather than in total, so the report can name the ones that
  // are not retirable instead of refusing the whole run over an aggregate.
  const sources = await q(
    `SELECT s.id, s.name, s.archived_at,
            (SELECT count(*) FROM documents d WHERE d.source_id = s.id) AS docs,
            (SELECT count(*) FROM portal_source_bindings b WHERE b.source_id = s.id) AS bindings
       FROM document_sources s
      WHERE s.kind = 'app_upload'
      ORDER BY s.name`,
  )

  if (sources.length === 0) {
    console.log('no app_upload sources exist — nothing to retire')
    return
  }

  const holding = sources.filter((row) => Number(row.docs) > 0)
  if (holding.length > 0) {
    console.log('REFUSED — these app_upload sources still own documents:\n')
    for (const row of holding) {
      console.log(`  ${row.name}: ${row.docs} document(s)`)
    }
    console.log(
      '\nA document reaches its portal through this source, so archiving it would be\n' +
        'invisible today and a support case later. Run\n' +
        '  node scripts/migrate-uploads-to-libraries.mjs --stage ' +
        stage +
        ' --apply\n' +
        'first — it moves them into libraries and clears source_id.',
    )
    process.exitCode = 1
    return
  }

  const pending = sources.filter((row) => row.archived_at === null || Number(row.bindings) > 0)
  console.log(`== ${sources.length} app_upload source(s), none holding documents ==`)
  for (const row of sources) {
    const state = row.archived_at === null ? 'live' : 'archived'
    console.log(`  ${row.name}: ${state}, ${row.bindings} binding(s)`)
  }
  console.log()

  if (pending.length === 0) {
    console.log('every app_upload source is already archived and unbound — nothing to do')
    return
  }

  // --- bindings first ------------------------------------------------------
  //
  // Before the archive rather than after, so an interrupted run leaves a source that
  // is live and unbound (harmless: it reaches nothing) rather than archived and still
  // bound (an empty arm in a view, from a row nothing will look at again).
  let unbound = 0
  for (const row of pending) {
    if (Number(row.bindings) === 0) continue
    unbound += await exec('DELETE FROM portal_source_bindings WHERE source_id = $1', [row.id])
    if (!apply) unbound += Number(row.bindings)
  }

  let archived = 0
  for (const row of pending) {
    if (row.archived_at !== null) continue
    archived += await exec(
      'UPDATE document_sources SET archived_at = now() WHERE id = $1 AND archived_at IS NULL',
      [row.id],
    )
    if (!apply) archived += 1
  }

  console.log(`removed ${unbound} binding(s), archived ${archived} source(s)`)

  // --- and prove the thing that matters is unchanged -----------------------
  //
  // These sources reached nothing, so no portal's visible count may move. Measured
  // rather than argued: it is the same check the §6.5 migration makes, and it is what
  // caught that migration's one real bug.
  const visible = await q(
    `SELECT p.label, count(DISTINCT v.document_id) AS visible
       FROM portals p
       LEFT JOIN portal_visible_documents v ON v.portal_id = p.portal_id
      GROUP BY p.label
      ORDER BY p.label`,
  )
  console.log('\n== per-portal visible documents, after ==')
  for (const row of visible) console.log(`  ${row.label}: ${row.visible}`)

  if (!apply) console.log('\n(dry run — nothing was written; re-run with --apply)')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
