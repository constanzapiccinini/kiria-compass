/**
 * Move every client-owned document and folder into a private library — §6.5.
 *
 * Phase 6 makes a library the only way a file enters the system. The documents
 * uploaded before that belong to a tenant (`client_id`) rather than to a library, so
 * they have to move or they become unreachable: after 6A the client app resolves
 * everything through `portal_visible_documents`, which finds a document by its source
 * binding or its library, and a tenant-owned document has neither.
 *
 * ---------------------------------------------------------------------------
 * The check that decides whether this worked
 *
 * **The per-portal visible count must not change.** Everything else here is
 * bookkeeping; that number is the product. It is measured before and after, printed
 * both times, and a difference **fails the run loudly** rather than being reported as
 * a warning at the end of a wall of output.
 *
 * Chunk counts are checked the same way: a document that loses its chunks is still
 * listed and no longer answerable, which is the quietest possible way to break this.
 *
 * ---------------------------------------------------------------------------
 * Seven tables, re-enumerated
 *
 * 0013 gave seven tables a `library_id` beside their `client_id`, with a CHECK that
 * exactly one is set. Every one of them has to move with the document, and the list
 * is read **from the migration file** rather than trusted from the phase spec — a
 * table left behind makes its rows unreadable to the very portal that owns them, and
 * the failure surfaces far away as "the chat cannot cite this document".
 *
 * `document_folders` moves too, on 0015's matching column.
 *
 * ---------------------------------------------------------------------------
 * Idempotent, and dry by default
 *
 *   node scripts/migrate-uploads-to-libraries.mjs --stage dev            (dry run)
 *   node scripts/migrate-uploads-to-libraries.mjs --stage dev --apply
 *   node scripts/migrate-uploads-to-libraries.mjs --stage prod --apply --yes
 *
 * Re-running after a completed migration finds nothing to move and says so.
 */

import { readFileSync, readdirSync } from 'node:fs'
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

/**
 * The tables carrying a `library_id`, read out of the migrations themselves.
 *
 * Not a hand-written list. The spec's own list was wrong once already (it named four
 * tables where there are seven), and a list that can drift from the schema is exactly
 * the thing this migration cannot afford.
 */
function tablesWithLibraryId() {
  const dir = join(ROOT, 'postgres', 'migrations')
  const found = new Set()
  for (const file of readdirSync(dir).sort()) {
    if (!/^\d+_.+\.sql$/.test(file)) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    const pattern = /ALTER TABLE\s+public\.(\w+)\s+ADD COLUMN library_id/gi
    for (const match of sql.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
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
  if (stage === 'prod' && apply && !yes) {
    throw new Error('refusing to write to prod without --yes')
  }
  return { stage, apply, yes }
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

  // `documents` and `document_folders` are moved explicitly below so their counts can
  // be reported separately — they are the two a person checks. Excluding them here
  // avoids updating them twice; the second pass would find nothing, but a folder count
  // of 0 in the output would read as "no folders moved" and be wrong.
  const derived = tablesWithLibraryId().filter(
    (t) => t !== 'documents' && t !== 'document_folders',
  )

  console.log(`store ${storeId} alias=${STORE_ALIAS} stage=${stage}${apply ? '' : ' (dry run)'}`)
  console.log(`derived tables carrying library_id: ${derived.join(', ')}\n`)

  // --- before -------------------------------------------------------------
  const visibleBefore = await q(
    `SELECT p.portal_id, p.label, count(DISTINCT v.document_id) AS visible
       FROM portals p
       LEFT JOIN portal_visible_documents v ON v.portal_id = p.portal_id
      GROUP BY p.portal_id, p.label
      ORDER BY p.label`,
  )
  const chunksBefore = await q(
    `SELECT count(*)::int AS n FROM document_chunks WHERE embedding IS NOT NULL`,
  )

  console.log('== per-portal visible documents, before ==')
  for (const row of visibleBefore) console.log(`  ${row.label}: ${row.visible}`)
  console.log(`  (embedded chunks in total: ${chunksBefore[0]?.n ?? 0})\n`)

  // --- what has to move ---------------------------------------------------
  const clients = await q(
    `SELECT c.id, c.name, c.created_by_user_id,
            (SELECT count(*) FROM documents d
              WHERE d.client_id = c.id AND d.deleted_at IS NULL) AS docs,
            (SELECT count(*) FROM document_folders f WHERE f.client_id = c.id) AS folders
       FROM clients c
      ORDER BY c.name`,
  )
  const pending = clients.filter((c) => Number(c.docs) > 0 || Number(c.folders) > 0)

  /**
   * Repair pass: a library document must not also carry a `source_id`.
   *
   * Runs before the move and on every invocation, so a run that moved documents
   * before this rule existed is corrected by the next one. Idempotent by shape — it
   * matches only rows that are wrong.
   */
  const doubled = await q(
    `SELECT count(*)::int AS n FROM documents
      WHERE library_id IS NOT NULL AND source_id IS NOT NULL`,
  )
  if (Number(doubled[0]?.n ?? 0) > 0) {
    console.log(
      `== repair ==\n  ${doubled[0].n} library document(s) still carry a source_id, which ` +
        `makes them visible twice through the two arms of portal_visible_documents.`,
    )
    const cleared = await exec(
      'UPDATE documents SET source_id = NULL WHERE library_id IS NOT NULL AND source_id IS NOT NULL',
    )
    console.log(`  cleared ${apply ? cleared : doubled[0].n} row(s)${apply ? '' : ' (dry run)'}\n`)
  }

  // Not an early return: the repair pass above may itself have changed what portals
  // can see, and the whole point of this script is that that number is verified
  // rather than assumed. So an already-migrated store still falls through to the
  // check at the bottom.
  if (pending.length === 0) {
    console.log('nothing client-owned left to move — already migrated')
  } else {
    console.log('== clients with client-owned rows ==')
    for (const c of pending) {
      console.log(`  ${c.name}: ${c.docs} document(s), ${c.folders} folder(s)`)
    }
    console.log('')
  }

  for (const client of pending) {
    const clientId = String(client.id)
    const name = String(client.name)

    // The portals of this tenant. A private library is ticked to them, which is what
    // preserves visibility: the documents were reachable through an `app_upload`
    // source bound to these same portals.
    const portals = await q('SELECT id, label FROM portals WHERE client_id = $1', [clientId])

    // Find or create the private library. Keyed on the name so a re-run reuses it;
    // `<Client> — files` matches what `ensurePrivateLibrary` produces for new portals.
    const libraryName = `${name} — files`
    let library = (
      await q(
        `SELECT id FROM document_sources
          WHERE org_id = $1 AND kind = 'library' AND name = $2`,
        [orgId, libraryName],
      )
    )[0]

    /**
     * Private only when the tenant has at most one portal.
     *
     * `is_private` promises "this library goes to exactly one portal", and the
     * libraries API enforces it by refusing a second tick with 409. A tenant with two
     * portals — legal since Phase 5, and real here: `CLIENTE B` owns both
     * `client-a-portal` and `client-b-portal` — cannot have its files be private to
     * one of them without losing the other's visibility.
     *
     * So the flag follows the facts rather than the other way round. Marking such a
     * library private and ticking it twice anyway would create a row the API considers
     * impossible, which is worse than a shared library that is honestly shared.
     */
    const isPrivate = portals.length <= 1
    if (portals.length > 1) {
      console.log(
        `  ${name}: has ${portals.length} portals, so its library is shared rather ` +
          `than private — "private" means one portal and this tenant has more.`,
      )
    }

    if (!library) {
      await exec(
        `INSERT INTO document_sources
           (org_id, name, description, kind, owner_kind, is_private, created_by_user_id)
         VALUES ($1, $2, 'Files migrated from this portal''s own uploads.', 'library',
                 'library', $4, $3)`,
        [orgId, libraryName, String(client.created_by_user_id), isPrivate],
      )
      library = (
        await q(
          `SELECT id FROM document_sources
            WHERE org_id = $1 AND kind = 'library' AND name = $2`,
          [orgId, libraryName],
        )
      )[0]
      console.log(`  ${name}: created ${isPrivate ? 'private' : 'shared'} library "${libraryName}"${apply ? '' : ' (dry run)'}`)
    } else {
      console.log(`  ${name}: reusing library "${libraryName}"`)
    }

    // In a dry run there is no library id to write with, so stop after reporting.
    if (!apply) {
      for (const portal of portals) console.log(`    would tick → ${portal.label}`)
      console.log(`    would move ${client.docs} document(s) and ${client.folders} folder(s)`)
      continue
    }

    const libraryId = String(library.id)

    for (const portal of portals) {
      const already = await q(
        'SELECT 1 FROM portal_source_bindings WHERE portal_row_id = $1 AND source_id = $2',
        [String(portal.id), libraryId],
      )
      if (already.length === 0) {
        await exec(
          'INSERT INTO portal_source_bindings (org_id, portal_row_id, source_id) VALUES ($1, $2, $3)',
          [orgId, String(portal.id), libraryId],
        )
        console.log(`    ticked → ${portal.label}`)
      }
    }

    // Order matters: the derived rows move first, so a failure part-way leaves
    // documents still owned by the tenant and still visible, rather than documents
    // pointing at a library whose chunks are somewhere else.
    for (const table of derived) {
      const moved = await exec(
        `UPDATE ${table} SET library_id = $1, client_id = NULL WHERE client_id = $2`,
        [libraryId, clientId],
      )
      if (moved > 0) console.log(`    ${table}: ${moved} row(s)`)
    }

    /**
     * `source_id` is cleared with the move, and that is not cosmetic.
     *
     * `portal_visible_documents` is a UNION ALL of two arms: one joins
     * `d.source_id = b.source_id`, the other `d.library_id = b.source_id`. 0014
     * claimed the arms were disjoint because "a library document is not synced by a
     * source" — true for a document uploaded into a library, and **false for a
     * migrated one**, which keeps the `app_upload` source it came from and gains a
     * library. Both arms then match and the portal sees the document twice.
     *
     * Caught by this script's own before/after check on the first dev run: 1 visible
     * before, 2 after. `source_id` is the sync handle, a library has nothing to sync,
     * and `document-intake.ts` already writes NULL there for new library uploads — so
     * clearing it restores the disjointness the view depends on.
     */
    const docs = await exec(
      'UPDATE documents SET library_id = $1, client_id = NULL, source_id = NULL WHERE client_id = $2',
      [libraryId, clientId],
    )
    const folders = await exec(
      'UPDATE document_folders SET library_id = $1, client_id = NULL WHERE client_id = $2',
      [libraryId, clientId],
    )
    console.log(`    documents: ${docs}, folders: ${folders}`)
  }

  if (!apply) {
    console.log('\n(dry run — nothing was written; re-run with --apply)')
    return
  }

  // --- after --------------------------------------------------------------
  const visibleAfter = await q(
    `SELECT p.portal_id, p.label, count(DISTINCT v.document_id) AS visible
       FROM portals p
       LEFT JOIN portal_visible_documents v ON v.portal_id = p.portal_id
      GROUP BY p.portal_id, p.label
      ORDER BY p.label`,
  )
  const chunksAfter = await q(
    `SELECT count(*)::int AS n FROM document_chunks WHERE embedding IS NOT NULL`,
  )

  console.log('\n== per-portal visible documents, after ==')
  for (const row of visibleAfter) console.log(`  ${row.label}: ${row.visible}`)
  console.log(`  (embedded chunks in total: ${chunksAfter[0]?.n ?? 0})`)

  const before = new Map(visibleBefore.map((r) => [String(r.portal_id), Number(r.visible)]))
  const after = new Map(visibleAfter.map((r) => [String(r.portal_id), Number(r.visible)]))
  const problems = []

  for (const [portalId, count] of before) {
    const now = after.get(portalId)
    if (now !== count) {
      const label = visibleBefore.find((r) => String(r.portal_id) === portalId)?.label ?? portalId
      problems.push(`${label}: ${count} visible before, ${now ?? 0} after`)
    }
  }
  if (Number(chunksBefore[0]?.n ?? 0) !== Number(chunksAfter[0]?.n ?? 0)) {
    problems.push(
      `embedded chunks ${chunksBefore[0]?.n} before, ${chunksAfter[0]?.n} after`,
    )
  }

  if (problems.length > 0) {
    console.error('\nFAILED — the migration changed what portals can see:')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(
      '\nNothing is rolled back automatically. Investigate before running anything else:\n' +
        '  node scripts/Coni-diagnose-library-visibility.mjs --stage ' + stage,
    )
    process.exitCode = 1
    return
  }

  console.log('\nPASS — every portal sees exactly what it saw before')

  // Reported rather than acted on. `Client Portal Template — uploads` has documents
  // and zero ticks, so those files are invisible today; migrating them must not
  // quietly make them visible, and deciding who should receive them is a person's
  // call (§6.5.5).
  const untickedLibraries = await q(
    `SELECT s.name,
            (SELECT count(*) FROM documents d
              WHERE d.library_id = s.id AND d.deleted_at IS NULL) AS docs
       FROM document_sources s
      WHERE s.org_id = $1 AND s.kind = 'library'
        AND NOT EXISTS (SELECT 1 FROM portal_source_bindings b WHERE b.source_id = s.id)`,
    [orgId],
  )
  const withDocs = untickedLibraries.filter((row) => Number(row.docs) > 0)
  if (withDocs.length > 0) {
    console.log('\nLibraries holding documents that NO portal receives:')
    for (const row of withDocs) console.log(`  ${row.name}: ${row.docs} document(s)`)
    console.log(
      '  These were invisible before the migration and still are. Tick them in\n' +
        '  Admin → Libraries only if someone should actually see them.',
    )
  }
}

main().catch((error) => {
  console.error(error?.message ?? error)
  process.exitCode = 1
})
