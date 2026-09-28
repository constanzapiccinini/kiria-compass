/**
 * Remove the library fixtures the e2e suite leaves behind.
 *
 * Why this cannot be done by the app: a library that has been embedded holds
 * `usage_events`, and `usage_events.library_id` is ON DELETE RESTRICT on purpose —
 * deleting the library would erase money that was really spent from the usage
 * screen's arithmetic. So the API refuses it, with a 409 that says to archive
 * instead, and that refusal is correct product behaviour rather than a bug to route
 * around.
 *
 * Test data is the one case where destroying that history is right, and doing it
 * needs a privilege the app deliberately does not have. Hence an operator script,
 * run by a person, that says exactly what it is deleting.
 *
 * **Only touches libraries whose name starts with `e2e-`.** A library someone created
 * by hand is never matched, and the prefix is the whole safety argument, so it is not
 * configurable.
 *
 * Widened from `e2e-library-` in 6B. That prefix matched only `libraries.spec.ts`,
 * and Phase 6 gave four more specs their own libraries — `e2e-upload-`,
 * `e2e-indexing-`, `e2e-reject-`, and the `e2e-<stamp>-lib` pair in
 * `folders.spec.ts`. Production had leftovers from all of them, which is the failure
 * mode a cleanup script exists to prevent. `e2e-` is still a prefix nobody names a
 * real library with, so the safety argument is unchanged in kind.
 *
 * Usage (from repo root):
 *   node scripts/cleanup-e2e-libraries.mjs --stage dev [--dry-run]
 *   node scripts/cleanup-e2e-libraries.mjs --stage prod --yes
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, IsolatedStoresApi } from '@fusebase/fusebase-gate-sdk'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_ALIAS = 'compasses'
/** The only names this script will ever match. */
const FIXTURE_PREFIX = 'e2e-'

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
  let dryRun = false
  let yes = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--stage') stage = argv[i + 1]
    if (argv[i] === '--dry-run') dryRun = true
    if (argv[i] === '--yes') yes = true
  }
  if (stage !== 'dev' && stage !== 'prod') {
    throw new Error(`--stage must be dev or prod (got "${stage}")`)
  }
  if (stage === 'prod' && !yes && !dryRun) {
    throw new Error('refusing to write to prod without --yes (or use --dry-run)')
  }
  return { stage, dryRun, yes }
}

async function main() {
  const { stage, dryRun } = parseArgs(process.argv.slice(2))

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

  const query = async (sql, params = []) =>
    (
      await api.queryIsolatedStoreSql({
        path: { orgId, storeId, stage },
        body: { sql, params },
      })
    ).result?.rows ?? []

  const execute = async (sql, params = []) => {
    if (dryRun) return 0
    const response = await api.executeIsolatedStoreSql({
      path: { orgId, storeId, stage },
      body: { sql, params },
    })
    return response.result?.rowCount ?? 0
  }

  console.log(`store ${storeId} alias=${STORE_ALIAS} stage=${stage}${dryRun ? ' (dry run)' : ''}`)

  const fixtures = await query(
    `SELECT id, name,
            (SELECT count(*) FROM documents d WHERE d.library_id = s.id)             AS documents,
            (SELECT count(*) FROM usage_events u WHERE u.library_id = s.id)          AS usage_events,
            (SELECT count(*) FROM portal_source_bindings b WHERE b.source_id = s.id) AS ticks
       FROM document_sources s
      WHERE s.org_id = $1 AND s.kind = 'library' AND s.name LIKE $2
      ORDER BY s.created_at`,
    [orgId, `${FIXTURE_PREFIX}%`],
  )

  if (fixtures.length === 0) {
    console.log('no e2e library fixtures found — nothing to do')
    return
  }

  for (const fixture of fixtures) {
    const id = String(fixture.id)
    console.log(
      `  ${fixture.name}: ${fixture.documents} document(s), ` +
        `${fixture.usage_events} usage event(s), ${fixture.ticks} tick(s)`,
    )

    // Children first, then the library — every reference is ON DELETE RESTRICT, so
    // the order is not a style choice: the last statement fails without the others.
    // Chunks, pages and paragraphs go via the documents they belong to.
    await execute('DELETE FROM portal_source_bindings WHERE source_id = $1', [id])
    await execute('DELETE FROM document_chunks WHERE library_id = $1', [id])
    await execute('DELETE FROM document_paragraphs WHERE library_id = $1', [id])
    await execute('DELETE FROM document_pages WHERE library_id = $1', [id])
    await execute('DELETE FROM ingest_jobs WHERE library_id = $1', [id])
    await execute('DELETE FROM embedding_batches WHERE library_id = $1', [id])
    await execute('DELETE FROM documents WHERE library_id = $1', [id])
    // The row the API is right to protect, and the only reason this script exists.
    await execute('DELETE FROM usage_events WHERE library_id = $1', [id])
    await execute('DELETE FROM document_sources WHERE id = $1 AND kind = $2', [id, 'library'])

    console.log(`  ${fixture.name}: removed${dryRun ? ' (dry run)' : ''}`)
  }

  console.log(
    `\n${fixtures.length} fixture librar${fixtures.length === 1 ? 'y' : 'ies'} ` +
      `${dryRun ? 'would be' : 'were'} removed`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
