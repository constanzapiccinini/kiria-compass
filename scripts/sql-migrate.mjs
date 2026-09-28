/**
 * Repo-owned SQL migration runner for the FuseBase PostgreSQL Database
 * ("compasses" isolated store).
 *
 * Why a script and not MCP: `applyIsolatedStoreSqlMigrations` carries the full SQL
 * text of every bundle version cumulatively, and MCP `tool_call` bodies are capped
 * around a few thousand characters. The sanctioned path for real apps is
 * IsolatedStoresApi from a script or CI, reading SQL from disk and building the
 * bundle with `buildSqlMigrationBundle(...)` so checksums match Gate canonicalization.
 *
 * Usage (from repo root):
 *   node scripts/sql-migrate.mjs status  --stage dev
 *   node scripts/sql-migrate.mjs dry-run --stage dev
 *   node scripts/sql-migrate.mjs apply   --stage dev
 *   node scripts/sql-migrate.mjs tables  --stage dev
 *   node scripts/sql-migrate.mjs rls     --stage dev
 *
 * Auth: GATE_MCP_TOKEN from .env (local/dev operator token, sent as Bearer).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createClient,
  IsolatedStoresApi,
  buildSqlMigrationBundle,
} from '@fusebase/fusebase-gate-sdk'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(ROOT, 'postgres', 'migrations')
const STORE_ALIAS = 'compasses'

/** Minimal .env reader — no dotenv dependency in this repo. */
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

function readFusebaseConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'fusebase.json'), 'utf8'))
}

/**
 * The store id declared in `fusebase.json`, if any. A hint, not the answer.
 *
 * Returns null rather than throwing: the app entry no longer declares
 * `isolatedStores` at all (see `resolveStoreByAlias` for why), and this runner must
 * work without it.
 */
function declaredStoreId(config) {
  for (const app of config.apps ?? []) {
    for (const store of app.isolatedStores?.sql ?? []) {
      if (store.alias === STORE_ALIAS && store.storeId) return store.storeId
    }
  }
  return null
}

/**
 * Resolve the store by asking Gate which one carries the alias.
 *
 * This used to read the id out of `fusebase.json` and then verify it. That was the
 * wrong way round, because the file is machine-managed and `fusebase deploy` rewrote
 * it on **six** separate occasions. The full diagnosis, finally:
 *
 * Deploy's provisioning step looks for the alias `<declared>-<environment>` — so
 * `compasses-prod` for the prod environment — and, not finding it, **creates a brand
 * new empty store** and rewrites `environments/prod.json` to point at it. It was never
 * re-selecting a stray store; it was manufacturing one each time. Deleting the stray
 * proved it: the next deploy immediately provisioned another.
 *
 * The real store is aliased plain `compasses` and Gate exposes no way to rename it, so
 * the mismatch cannot be resolved from that side. What it can be is made irrelevant:
 * the alias is the identity, Gate is the authority, and neither file gets a vote.
 *
 * Exact match, never a prefix — `compasses-prod` starts with `compasses`, which is
 * exactly how a prefix match would have selected the empty one.
 */
async function resolveStoreByAlias(api, orgId, declared) {
  const response = await api.listIsolatedStores({ path: { orgId } })
  const stores = response.stores ?? []
  const match = stores.find((store) => store.alias === STORE_ALIAS)

  if (!match) {
    throw new Error(
      `No store aliased "${STORE_ALIAS}" exists in org ${orgId}. Present: ` +
        (stores.map((s) => `${s.alias}=${s.globalId}`).join(', ') || 'none'),
    )
  }

  // Surfaced rather than silently corrected: a disagreement means something rewrote
  // the file again, and whoever is reading this output should know.
  if (declared && declared !== match.globalId) {
    console.warn(
      `! fusebase.json declares store ${declared} for alias "${STORE_ALIAS}", but Gate ` +
        `says it is ${match.globalId}. Using Gate's answer and ignoring the file.`,
    )
  }

  return match.globalId
}

/** Read every 0000_name.sql from postgres/migrations, ordered by numeric version. */
function readMigrationFiles() {
  const entries = []
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    const match = /^(\d+)_(.+)\.sql$/.exec(file)
    if (!match) continue
    entries.push({
      version: Number(match[1]),
      name: match[2],
      file,
      sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8'),
    })
  }
  if (entries.length === 0) throw new Error(`No migration files found in ${MIGRATIONS_DIR}`)
  return entries.sort((a, b) => a.version - b.version)
}

/**
 * Cross-check the manifest against the bundle the SDK actually produced, so a
 * stale manifest checksum is caught here instead of surfacing as journal drift.
 */
function verifyManifest(bundle, to = null) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'manifest.json'), 'utf8'))
  } catch {
    console.warn('! manifest.json missing — skipping manifest verification')
    return
  }
  const byVersion = new Map((manifest.migrations ?? []).map((m) => [m.version, m]))
  const problems = []
  for (const migration of bundle.migrations) {
    const entry = byVersion.get(migration.version)
    if (!entry) {
      problems.push(`v${migration.version} (${migration.name}) is missing from manifest.json`)
      continue
    }
    if (entry.checksum !== migration.checksum) {
      problems.push(
        `v${migration.version} checksum mismatch: manifest ${entry.checksum} vs file ${migration.checksum}`,
      )
    }
  }
  for (const version of byVersion.keys()) {
    // A `--to` run deliberately ships a shorter bundle, so versions above the cut are
    // expected to be absent from it and are not drift. Everything at or below the cut
    // must still be present — that is the check worth keeping.
    if (to !== null && version > to) continue
    if (!bundle.migrations.some((m) => m.version === version)) {
      problems.push(`manifest lists v${version} but no matching .sql file exists`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`manifest.json is out of sync with postgres/migrations:\n  - ${problems.join('\n  - ')}`)
  }
  console.log('manifest.json verified against migration files')
}

function parseArgs(argv) {
  const command = argv[0] ?? 'status'
  let stage = 'dev'
  let sql = null
  let to = null
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--stage') {
      stage = argv[i + 1]
      i += 1
      continue
    }
    /**
     * Apply only up to this version, instead of the whole pending tail.
     *
     * Needed because a migration line can contain a step that must not be crossed
     * in one go: v8 adds nullable tenancy columns, a backfill script fills them, and
     * v9 makes them NOT NULL. Applying the tail in one call runs v9 against
     * unbackfilled rows and fails — which is exactly what happened on prod, and the
     * transaction rolled back cleanly, but the only way forward was to stop at v8.
     */
    if (argv[i] === '--to') {
      to = Number(argv[i + 1])
      if (!Number.isInteger(to) || to < 1) throw new Error('--to must be a migration version')
      i += 1
      continue
    }
    if (argv[i] === '--sql') {
      sql = argv[i + 1]
      i += 1
      continue
    }
  }
  if (stage !== 'dev' && stage !== 'prod') throw new Error(`--stage must be dev or prod, got "${stage}"`)
  return { command, stage, sql, to }
}

/**
 * Attach the app-owned RLS manifest, when there is one.
 *
 * This lives here rather than being left to `fusebase isolated-store sql bundle`
 * because that command resolves the store through the environment overlay and was
 * measured pointing at the **empty orphan store** (`…_prod_prod_e77bf744`) while
 * reporting a confident `currentVersion` and a full warning list. Manifest
 * validation read from the wrong database is worse than none: it answered "your
 * policies are missing" about a database the app never touches.
 *
 * `resolveStoreByAlias` has already run by the time this is called, so validation here
 * is against the database the app actually uses.
 */
function rlsManifestBody() {
  const file = join(MIGRATIONS_DIR, 'rls-manifest.json')
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    // Strip the documentation block: Gate's schema is `{ tables: … }` with no
    // wrapping object, and an unexpected key is a validation error rather than a
    // comment.
    return { rlsManifest: { tables: parsed.tables ?? {} } }
  } catch (error) {
    console.warn(`! rls-manifest.json is unreadable (${error.message}) — sending none`)
    return {}
  }
}

/** Gate's verdict on the manifest, summarised by code rather than dumped whole. */
function printRlsValidation(status) {
  const validation = status.rlsValidation
  if (!validation) {
    console.log('rls: no manifest sent, or validation not enabled for this store')
    return
  }

  const counts = {}
  for (const warning of validation.warnings ?? []) {
    counts[warning.code] = (counts[warning.code] ?? 0) + 1
  }

  console.log(
    `rls: mode=${validation.mode} tables=${validation.tableCount} warnings=${validation.warningCount}`,
  )
  for (const [code, count] of Object.entries(counts)) console.log(`  ${count}x ${code}`)
  for (const warning of validation.warnings ?? []) {
    console.log(`  - ${warning.tableName}: ${warning.code}`)
  }
}

function printStatus(status) {
  console.log(
    JSON.stringify(
      {
        databaseName: status.databaseName,
        currentVersion: status.currentVersion,
        bundleHeadVersion: status.bundleHeadVersion,
        appliedCount: status.appliedCount,
        pendingCount: status.pendingCount,
        isDrifted: status.isDrifted,
        canApply: status.canApply,
        structuredIssues: status.structuredIssues,
        pending: (status.pendingMigrations ?? []).map((m) => `v${m.version} ${m.name}`),
      },
      null,
      2,
    ),
  )
}

async function main() {
  const { command, stage, sql, to } = parseArgs(process.argv.slice(2))
  const env = { ...readEnvFile(), ...process.env }
  const token = (env.GATE_MCP_TOKEN ?? '').trim()
  if (!token) throw new Error('GATE_MCP_TOKEN is not set (.env or environment)')

  const config = readFusebaseConfig()
  const orgId = config.orgId
  const declared = declaredStoreId(config)
  const host = (env.FUSEBASE_HOST ?? 'thefusebase.com').trim()

  const client = createClient({
    baseUrl: `https://app-api.${host}/v4/api/proxy/gate-service/v1`,
    auth: { token },
    timeout: 120000,
  })
  const api = new IsolatedStoresApi(client)

  const allFiles = readMigrationFiles()
  // `--to` truncates the bundle rather than filtering what gets applied: Gate applies
  // the pending tail of whatever bundle it is given, so a shorter bundle is the only
  // way to stop at a version. The prefix still has to match the journal, which it does
  // because migrations are only ever appended.
  const files = to === null ? allFiles : allFiles.filter((file) => file.version <= to)
  if (files.length === 0) throw new Error(`--to ${to} selected no migrations`)

  const bundle = await buildSqlMigrationBundle({
    bundleVersion: '1',
    migrations: files.map(({ version, name, sql }) => ({ version, name, sql })),
  })

  // Gate is the authority on which store carries the alias. Resolved before anything
  // is read or written, so a rewritten fusebase.json cannot point this at the wrong
  // database — and it no longer needs the file to name one at all.
  const storeId = await resolveStoreByAlias(api, orgId, declared)

  console.log(`store ${storeId} alias=${STORE_ALIAS} stage=${stage} command=${command}`)
  console.log(
    `bundle: ${bundle.migrations.map((m) => `v${m.version} ${m.name} ${m.checksum.slice(0, 12)}…`).join(', ')}`,
  )

  if (command === 'status' || command === 'dry-run' || command === 'apply') {
    verifyManifest(bundle, to)
  }

  const path = { orgId, storeId, stage }

  switch (command) {
    case 'status': {
      const res = await api.getIsolatedStoreSqlMigrationStatus({
        path,
        body: { bundle, ...rlsManifestBody() },
      })
      printStatus(res)
      printRlsValidation(res)
      break
    }
    case 'dry-run': {
      const res = await api.applyIsolatedStoreSqlMigrations({
        path,
        body: { bundle, dryRun: true },
      })
      console.log(JSON.stringify(res, null, 2))
      break
    }
    case 'apply': {
      const before = await api.getIsolatedStoreSqlMigrationStatus({ path, body: { bundle } })
      printStatus(before)
      if (before.isDrifted) throw new Error('Journal is drifted — resolve drift before applying')
      if (!before.canApply) throw new Error('Gate reports canApply=false — refusing to apply')
      if (before.pendingCount === 0) {
        console.log('Nothing to apply.')
        break
      }
      const res = await api.applyIsolatedStoreSqlMigrations({
        path,
        body: {
          bundle,
          expectedLastAppliedVersion: before.currentVersion ?? null,
        },
      })
      console.log(JSON.stringify(res, null, 2))
      break
    }
    case 'tables': {
      const res = await api.listIsolatedStoreSqlTables({ path })
      console.log(JSON.stringify(res, null, 2))
      break
    }
    case 'rls': {
      const res = await api.getIsolatedStoreSqlRlsStatus({ path })
      console.log(JSON.stringify(res, null, 2))
      break
    }
    /**
     * Read-only ad-hoc query, for verifying an apply or inspecting state during an
     * incident.
     *
     * Lives here rather than in a throwaway script because this is the one place that
     * already proves it is talking to the right database — `resolveStoreByAlias` has run
     * by now, so a rewritten `fusebase.json` cannot point a hand-written query at the
     * empty store and return a confidently wrong answer.
     *
     * `queryIsolatedStoreSql` runs in a READ ONLY transaction, so this cannot mutate
     * anything even by mistake. Writes stay on migrations and the app's structured
     * row API.
     */
    case 'query': {
      if (!sql) throw new Error('query needs --sql "<statement>"')
      const res = await api.queryIsolatedStoreSql({ path, body: { sql, params: [] } })
      console.log(JSON.stringify(res.result?.rows ?? res, null, 2))
      break
    }
    default:
      throw new Error(
        `Unknown command "${command}". Use status | dry-run | apply | tables | rls | query`,
      )
  }
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error)
  if (error && typeof error === 'object' && 'body' in error) {
    console.error('body:', JSON.stringify(error.body, null, 2))
  }
  process.exit(1)
})
