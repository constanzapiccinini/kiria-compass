/**
 * Tidy the library list ahead of the product demo.
 *
 *   node scripts/demo-tidy-libraries.mjs --stage prod [--apply]
 *
 * Dry by default. Prints what it would do and changes nothing until `--apply`.
 *
 * ---------------------------------------------------------------------------
 * What this does and deliberately does not do
 *
 * **Renames one library and archives four.** Archive rather than delete, for all of
 * them, because archiving is a column and deleting is a cascade: `document_sources`
 * has documents, chunks, paragraphs, pages and bindings hanging off it, and the app's
 * own delete path exists in `routes/libraries.ts` where it belongs. Nothing here is
 * urgent enough to justify reimplementing that in an operator script, and an archived
 * library is already out of the way — the Libraries screen sorts archived rows last
 * and the demo never sees them.
 *
 * **It does not touch the missing portal.** Removing that is the one destructive
 * action in the admin app and it is guarded by having to type the portal's name, on
 * purpose: "the one guard that reliably stops a mis-click on the wrong row is having
 * to reproduce the row's name". Doing it from a script bypasses exactly the control
 * that makes it safe, so it stays a human action. Its impact was measured first and is
 * zero — 0 chats, 0 messages, 0 documents — which is in the demo notes so whoever
 * clicks it can do so knowing that.
 *
 * ---------------------------------------------------------------------------
 * Every change writes an audit row
 *
 * Operator scripts are the easiest way for production state to change with no record
 * of who or why. These rows say `via: demo-tidy-libraries`, so a month from now the
 * rename is attributable to this script and this reason rather than looking like
 * somebody editing the database by hand.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, IsolatedStoresApi } from '@fusebase/fusebase-gate-sdk'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_ALIAS = 'compasses'

/**
 * The demo library, renamed.
 *
 * "New library test" is the name somebody types while checking that the create button
 * works. It is also, right now, the only library a client can see anything through —
 * so it is the first thing on screen in the Libraries demo.
 */
const RENAME = { from: 'New library test', to: 'Mayo Clinic — 2026' }

/**
 * Libraries that should not be on screen, and why each one is not needed.
 *
 * Reasons are carried into the audit row. "Archived during demo prep" is not a reason
 * anybody can act on later; "empty and bound to nothing" is.
 */
const ARCHIVE = [
  { name: 'nuevo', why: 'empty and bound to no portal' },
  { name: 'Client Portal Template — files', why: 'bound to no portal, so no client can see its documents' },
  { name: 'CLIENTE B — files', why: 'empty; its two portal bindings show nothing' },
]

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

async function main() {
  const argv = process.argv.slice(2)
  const stage = argv.includes('--stage') ? argv[argv.indexOf('--stage') + 1] : 'dev'
  const apply = argv.includes('--apply')

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
  const exec = async (sql, params = []) =>
    (await api.executeIsolatedStoreSql({ path: { orgId, storeId, stage }, body: { sql, params } }))
      .result?.rowCount ?? 0

  console.log(`store ${storeId} stage=${stage} ${apply ? '(APPLYING)' : '(dry run)'}\n`)

  const audit = async (action, targetId, metadata) => {
    if (!apply) return
    await exec(
      `INSERT INTO audit_logs (org_id, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, 'document_source', $4, $5::jsonb)`,
      [orgId, 'operator:demo-tidy-libraries', action, targetId, JSON.stringify(metadata)],
    )
  }

  // --- rename ---------------------------------------------------------------

  const target = await q('SELECT id, name FROM document_sources WHERE name = $1', [RENAME.from])
  if (target.length === 0) {
    console.log(`rename: "${RENAME.from}" not found (already renamed?)`)
  } else {
    const id = String(target[0].id)
    console.log(`rename: "${RENAME.from}" -> "${RENAME.to}"`)
    if (apply) {
      await exec('UPDATE document_sources SET name = $1 WHERE id = $2', [RENAME.to, id])
      await audit('library.renamed', id, { from: RENAME.from, to: RENAME.to, via: 'demo-tidy-libraries' })
    }
  }

  // --- archive --------------------------------------------------------------

  for (const entry of ARCHIVE) {
    const rows = await q(
      `SELECT s.id, s.archived_at,
              (SELECT count(*)::int FROM documents d WHERE d.library_id = s.id) AS docs
         FROM document_sources s WHERE s.name = $1`,
      [entry.name],
    )
    if (rows.length === 0) {
      console.log(`archive: "${entry.name}" not found`)
      continue
    }
    const id = String(rows[0].id)
    if (rows[0].archived_at) {
      console.log(`archive: "${entry.name}" already archived`)
      continue
    }

    // Re-checked here rather than trusted from the survey that produced this list:
    // a library that has gained documents since is one somebody is using, and
    // archiving it would hide their work.
    const docs = Number(rows[0].docs)
    if (entry.name === 'CLIENTE B — files' && docs > 0) {
      console.log(`archive: SKIPPED "${entry.name}" — it now holds ${docs} document(s)`)
      continue
    }

    console.log(`archive: "${entry.name}" (${docs} doc(s)) — ${entry.why}`)
    if (apply) {
      await exec('UPDATE document_sources SET archived_at = now() WHERE id = $1', [id])
      await audit('library.archived', id, { name: entry.name, why: entry.why, documents: docs, via: 'demo-tidy-libraries' })
    }
  }

  // --- what the demo will see ----------------------------------------------

  console.log('\nlibraries after this runs:')
  const after = await q(
    `SELECT s.name, s.archived_at IS NOT NULL AS archived,
            (SELECT count(*)::int FROM documents d WHERE d.library_id = s.id) AS docs
       FROM document_sources s
      WHERE s.archived_at IS NULL
      ORDER BY s.name`,
  )
  for (const row of after) console.log(`  ${row.name}  (${row.docs} doc(s))`)

  if (!apply) console.log('\nnothing was changed. re-run with --apply')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
