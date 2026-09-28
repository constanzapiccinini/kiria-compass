/**
 * Prove that a library is readable by the portals ticked for it and by no others.
 *
 * §5B.3 asks for this in both directions with the counts written down, the way 0009
 * and 0011 were proven. It creates a throwaway library in **dev**, gives it one
 * document and one chunk, ticks portal A, measures, ticks nothing else, measures
 * again from portal B, unticks A, measures a third time, and deletes everything it
 * made.
 *
 * ---------------------------------------------------------------------------
 * What this proves, and what it cannot
 *
 * Two separate mechanisms decide what a portal sees, and this script tests both:
 *
 *   1. **`portal_visible_documents`** — the join. Querying it with
 *      `WHERE portal_id = A` versus `= B` is a real test of the resolution added in
 *      0014, and it does not depend on RLS at all.
 *   2. **`scope_may_read_source(library_id)`** — the decision inside the policy.
 *      Called directly with `app.req_client_id` set to each tenant in turn.
 *
 * What it cannot do is watch Postgres *filter rows* by that policy, because this
 * script authenticates with the operator token, whose role holds BYPASSRLS —
 * `isolated_pg_migrator` owns the tables and outranks even FORCE ROW LEVEL
 * SECURITY. The role that does get filtered is `isolated_pg_runtime`, which only the
 * app backend uses, and reaching a *tenant-scoped* runtime read requires a
 * portal-launcher session that Gate exposes no way to mint (see
 * `tests/manual/portal-isolation.md`).
 *
 * That is not a gap in the proof so much as a division of it: the filtering
 * mechanism was measured in both directions when 0009 and 0011 shipped and is
 * unchanged here. What 0014 adds is one boolean term in the USING clause, and that
 * term is exactly what this script measures — with `rlsContext` set, which is the
 * same transaction-local setting the app sets, so the function sees precisely what
 * it would see under a real request.
 *
 * Usage (from repo root):
 *   node scripts/verify-library-rls.mjs [--stage dev] [--keep]
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
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return out
}

async function resolveStoreByAlias(api, orgId) {
  const response = await api.listIsolatedStores({ path: { orgId } })
  const match = (response.stores ?? []).find((store) => store.alias === STORE_ALIAS)
  if (!match) throw new Error(`No store aliased "${STORE_ALIAS}" in org ${orgId}`)
  return match.globalId
}

function parseArgs(argv) {
  let stage = 'dev'
  let keep = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--stage') stage = argv[i + 1]
    if (argv[i] === '--keep') keep = true
  }
  if (stage !== 'dev' && stage !== 'prod') throw new Error('--stage must be dev or prod')
  if (stage === 'prod') {
    throw new Error(
      'refusing to run on prod: this creates and deletes rows, and prod is not a test fixture',
    )
  }
  return { stage, keep }
}

const failures = []
function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual} (expected ${expected})`)
  if (!ok) failures.push(`${label}: got ${actual}, expected ${expected}`)
}

async function main() {
  const { stage, keep } = parseArgs(process.argv.slice(2))

  const env = { ...readEnvFile(), ...process.env }
  const token = (env.GATE_MCP_TOKEN ?? '').trim()
  if (!token) throw new Error('GATE_MCP_TOKEN is not set (.env or environment)')

  const orgId = JSON.parse(readFileSync(join(ROOT, 'fusebase.json'), 'utf8')).orgId
  const host = (env.FUSEBASE_HOST ?? 'thefusebase.com').trim()

  const api = new IsolatedStoresApi(
    createClient({
      baseUrl: `https://app-api.${host}/v4/api/proxy/gate-service/v1`,
      defaultHeaders: { authorization: `Bearer ${token}` },
    }),
  )
  const storeId = await resolveStoreByAlias(api, orgId)

  const query = async (sql, params = [], rlsContext = null) => {
    const response = await api.queryIsolatedStoreSql({
      path: { orgId, storeId, stage },
      body: { sql, params, ...(rlsContext ? { rlsContext } : {}) },
    })
    return response.result?.rows ?? []
  }
  const execute = async (sql, params = []) => {
    const response = await api.executeIsolatedStoreSql({
      path: { orgId, storeId, stage },
      body: { sql, params },
    })
    return response.result?.rowCount ?? 0
  }
  const one = async (sql, params = [], rlsContext = null) =>
    (await query(sql, params, rlsContext))[0] ?? null

  console.log(`store ${storeId} alias=${STORE_ALIAS} stage=${stage}\n`)

  // Two portals with DIFFERENT tenants. Same-tenant portals would make "B cannot see
  // it" pass for the wrong reason.
  const portals = await query(
    `SELECT p.id, p.portal_id, p.label, p.client_id
       FROM portals p
      WHERE p.status = 'active'
      ORDER BY p.label`,
  )
  const distinct = []
  for (const portal of portals) {
    if (!distinct.some((existing) => existing.client_id === portal.client_id)) {
      distinct.push(portal)
    }
  }
  if (distinct.length < 2) {
    throw new Error(
      `need two active portals with different tenants in ${stage}; found ${distinct.length}`,
    )
  }
  const [a, b] = distinct
  console.log(`portal A = ${a.label} (tenant ${a.client_id})`)
  console.log(`portal B = ${b.label} (tenant ${b.client_id})\n`)

  const stamp = Date.now().toString(36)
  const libraryName = `verify-library-${stamp}`
  const created = { libraryId: null, documentId: null }

  try {
    // ---------------------------------------------------------------------
    // a library, one document, one chunk — owned by the library, no tenant
    // ---------------------------------------------------------------------
    await execute(
      `INSERT INTO document_sources
         (org_id, name, description, kind, owner_kind, created_by_user_id)
       VALUES ($1, $2, 'created by verify-library-rls.mjs', 'library', 'library', 'verify-script')`,
      [orgId, libraryName],
    )
    created.libraryId = String(
      (await one('SELECT id FROM document_sources WHERE org_id = $1 AND name = $2', [
        orgId,
        libraryName,
      ]))?.id,
    )
    console.log(`library ${created.libraryId} (${libraryName})`)

    await execute(
      `INSERT INTO documents
         (org_id, library_id, name, status, byte_size, content_sha256, uploaded_by_user_id)
       VALUES ($1, $2, $3, 'indexed', 1024, $4, 'verify-script')`,
      [orgId, created.libraryId, `${libraryName}.pdf`, `hash-${stamp}`],
    )
    created.documentId = String(
      (await one('SELECT id FROM documents WHERE library_id = $1', [created.libraryId]))?.id,
    )
    console.log(`document ${created.documentId}`)

    // The XOR constraint is the point of 0013: this row has a library and no tenant,
    // and the database accepted it. A NOT NULL client_id would have refused it.
    await execute(
      `INSERT INTO document_chunks
         (org_id, library_id, document_id, chunk_index, page_number, page_start, page_end,
          text, content_sha256, token_count)
       VALUES ($1, $2, $3, 0, 1, 1, 1, 'library chunk for the isolation proof', $4, 8)`,
      [orgId, created.libraryId, created.documentId, `chunk-${stamp}`],
    )

    const scopeA = { req_client_id: String(a.client_id) }
    const scopeB = { req_client_id: String(b.client_id) }
    const countVisible = async (portalId) =>
      Number(
        (
          await one(
            'SELECT count(*)::int AS n FROM portal_visible_documents WHERE portal_id = $1 AND document_id = $2',
            [portalId, created.documentId],
          )
        )?.n ?? -1,
      )
    const mayRead = async (scope) =>
      (await one('SELECT public.scope_may_read_source($1) AS ok', [created.libraryId], scope))?.ok

    // ---------------------------------------------------------------------
    // 1. nobody is ticked yet
    // ---------------------------------------------------------------------
    console.log('\nbefore any tick — a library nobody was given')
    check('portal A sees the library document', await countVisible(a.portal_id), 0)
    check('portal B sees the library document', await countVisible(b.portal_id), 0)
    check('scope A may read the library', await mayRead(scopeA), false)
    check('scope B may read the library', await mayRead(scopeB), false)

    // ---------------------------------------------------------------------
    // 2. tick portal A only
    // ---------------------------------------------------------------------
    await execute(
      'INSERT INTO portal_source_bindings (org_id, portal_row_id, source_id) VALUES ($1, $2, $3)',
      [orgId, String(a.id), created.libraryId],
    )
    console.log('\nticked portal A only')
    check('portal A sees the library document', await countVisible(a.portal_id), 1)
    check('portal B sees the library document', await countVisible(b.portal_id), 0)
    check('scope A may read the library', await mayRead(scopeA), true)
    check('scope B may read the library', await mayRead(scopeB), false)

    // ---------------------------------------------------------------------
    // 3. tick B as well — and prove nothing was re-embedded
    // ---------------------------------------------------------------------
    const chunksBefore = Number(
      (await one('SELECT count(*)::int AS n FROM document_chunks WHERE library_id = $1', [
        created.libraryId,
      ]))?.n ?? -1,
    )
    await execute(
      'INSERT INTO portal_source_bindings (org_id, portal_row_id, source_id) VALUES ($1, $2, $3)',
      [orgId, String(b.id), created.libraryId],
    )
    console.log('\nticked portal B as well — one copy, two portals')
    check('portal A sees the library document', await countVisible(a.portal_id), 1)
    check('portal B sees the library document', await countVisible(b.portal_id), 1)
    check('scope B may read the library', await mayRead(scopeB), true)
    // The whole cost argument in one assertion: a second portal is a row, not an
    // embedding run.
    check(
      'chunks after giving it to a second portal',
      Number(
        (await one('SELECT count(*)::int AS n FROM document_chunks WHERE library_id = $1', [
          created.libraryId,
        ]))?.n ?? -1,
      ),
      chunksBefore,
    )

    // ---------------------------------------------------------------------
    // 4. untick A — it loses access, the documents survive
    // ---------------------------------------------------------------------
    await execute('DELETE FROM portal_source_bindings WHERE portal_row_id = $1 AND source_id = $2', [
      String(a.id),
      created.libraryId,
    ])
    console.log('\nunticked portal A')
    check('portal A sees the library document', await countVisible(a.portal_id), 0)
    check('portal B still sees it', await countVisible(b.portal_id), 1)
    check('scope A may read the library', await mayRead(scopeA), false)
    // Revoking access must not destroy anything — this is the difference between
    // untick and delete.
    check(
      'the document still exists after untick',
      Number(
        (await one('SELECT count(*)::int AS n FROM documents WHERE id = $1', [created.documentId]))
          ?.n ?? -1,
      ),
      1,
    )
    check(
      'the chunks still exist after untick',
      Number(
        (await one('SELECT count(*)::int AS n FROM document_chunks WHERE library_id = $1', [
          created.libraryId,
        ]))?.n ?? -1,
      ),
      chunksBefore,
    )

    // ---------------------------------------------------------------------
    // 5. deleting a library with documents must be refused
    // ---------------------------------------------------------------------
    console.log('\ndeleting a library that still holds documents')
    let refused = false
    try {
      await execute('DELETE FROM document_sources WHERE id = $1', [created.libraryId])
    } catch {
      refused = true
    }
    // ON DELETE RESTRICT, not CASCADE. A library that took its documents with it is
    // the worst failure this app can produce, so the database refuses instead.
    check('the database refused the delete', refused, true)
  } finally {
    if (keep) {
      console.log('\n--keep: leaving the fixture in place')
    } else {
      // Order matters: children first, then the binding, then the library itself,
      // which RESTRICT would otherwise refuse.
      if (created.libraryId) {
        await execute('DELETE FROM document_chunks WHERE library_id = $1', [created.libraryId])
      }
      if (created.documentId) {
        await execute('DELETE FROM documents WHERE id = $1', [created.documentId])
      }
      if (created.libraryId) {
        await execute('DELETE FROM portal_source_bindings WHERE source_id = $1', [
          created.libraryId,
        ])
        await execute('DELETE FROM document_sources WHERE id = $1', [created.libraryId])
      }
      console.log('\ncleaned up')
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('\nPASS — a library is visible to the portals ticked for it and to no others')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
