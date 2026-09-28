/**
 * Populate the tenancy columns added by migration v8 (§4.3, step 2 of 3).
 *
 * Required between v8 and v9. v8 adds `org_id` (and `client_id` where it was
 * missing) as nullable; v9 makes them NOT NULL and switches RLS policies on. A
 * policy comparing against a column that is still NULL for every existing row
 * makes every read return nothing, so this has to run in between, and v9 must not
 * be applied until it has.
 *
 * DML belongs in a script rather than a migration: Gate rejects top-level INSERT /
 * UPDATE / DELETE inside a migration bundle, and rightly — a schema bundle that
 * also moves data cannot be replayed safely.
 *
 * **Uses `executeIsolatedStoreSql`, not the structured row API.** Every statement
 * here is a set-based UPDATE that derives one column from a join — `documents` from
 * `clients`, `document_pages` from `documents`, and so on. The structured API writes
 * literals, so expressing these through it would mean reading every row into the
 * script and writing it back one at a time: thousands of round trips where one
 * statement does. That needs `isolated_store.execute`, which the app's runtime token
 * deliberately does not hold — this runs on the operator token instead, which is the
 * right place for a one-off migration step.
 *
 * Idempotent by construction: every statement is `WHERE <column> IS NULL`, so a
 * second run touches nothing. Ordered parent-first, because the later statements
 * derive their values from columns the earlier ones filled in.
 *
 * Usage (from repo root):
 *   node scripts/backfill-tenancy-columns.mjs --stage dev
 *   node scripts/backfill-tenancy-columns.mjs --stage prod
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
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * The statements, parent-first.
 *
 * `org_id` comes from `clients.org_id` wherever a `client_id` exists, and from the
 * parent row otherwise. Nothing is defaulted to a literal org id: a hardcoded
 * `u27b70` would silently produce wrong rows the first time this schema is used by a
 * second organization, and the value is already in the database.
 */
const STATEMENTS = [
  // --- direct client children -------------------------------------------------
  {
    label: 'client_settings.org_id',
    sql: `UPDATE client_settings s SET org_id = c.org_id
            FROM clients c WHERE c.id = s.client_id AND s.org_id IS NULL`,
  },
  {
    label: 'client_group_members.org_id',
    sql: `UPDATE client_group_members m SET org_id = c.org_id
            FROM clients c WHERE c.id = m.client_id AND m.org_id IS NULL`,
  },
  {
    label: 'documents.org_id',
    sql: `UPDATE documents d SET org_id = c.org_id
            FROM clients c WHERE c.id = d.client_id AND d.org_id IS NULL`,
  },
  {
    label: 'document_folders.org_id',
    sql: `UPDATE document_folders f SET org_id = c.org_id
            FROM clients c WHERE c.id = f.client_id AND f.org_id IS NULL`,
  },
  {
    label: 'document_chunks.org_id',
    sql: `UPDATE document_chunks k SET org_id = c.org_id
            FROM clients c WHERE c.id = k.client_id AND k.org_id IS NULL`,
  },
  {
    label: 'chats.org_id',
    sql: `UPDATE chats t SET org_id = c.org_id
            FROM clients c WHERE c.id = t.client_id AND t.org_id IS NULL`,
  },
  {
    label: 'chat_messages.org_id',
    sql: `UPDATE chat_messages m SET org_id = c.org_id
            FROM clients c WHERE c.id = m.client_id AND m.org_id IS NULL`,
  },
  {
    label: 'ingest_jobs.org_id',
    sql: `UPDATE ingest_jobs j SET org_id = c.org_id
            FROM clients c WHERE c.id = j.client_id AND j.org_id IS NULL`,
  },
  {
    label: 'embedding_batches.org_id',
    sql: `UPDATE embedding_batches b SET org_id = c.org_id
            FROM clients c WHERE c.id = b.client_id AND b.org_id IS NULL`,
  },
  {
    label: 'usage_events.org_id',
    sql: `UPDATE usage_events u SET org_id = c.org_id
            FROM clients c WHERE c.id = u.client_id AND u.org_id IS NULL`,
  },
  {
    label: 'rag_traces.org_id',
    sql: `UPDATE rag_traces r SET org_id = c.org_id
            FROM clients c WHERE c.id = r.client_id AND r.org_id IS NULL`,
  },

  // --- tables that gained client_id: fill it from the parent first ------------
  {
    label: 'document_pages.client_id',
    sql: `UPDATE document_pages p SET client_id = d.client_id
            FROM documents d WHERE d.id = p.document_id AND p.client_id IS NULL`,
  },
  {
    label: 'document_paragraphs.client_id',
    sql: `UPDATE document_paragraphs g SET client_id = d.client_id
            FROM documents d WHERE d.id = g.document_id AND g.client_id IS NULL`,
  },
  {
    label: 'chat_documents.client_id',
    sql: `UPDATE chat_documents cd SET client_id = t.client_id
            FROM chats t WHERE t.id = cd.chat_id AND cd.client_id IS NULL`,
  },

  // --- then their org_id, which depends on the client_id just written --------
  {
    label: 'document_pages.org_id',
    sql: `UPDATE document_pages p SET org_id = c.org_id
            FROM clients c WHERE c.id = p.client_id AND p.org_id IS NULL`,
  },
  {
    label: 'document_paragraphs.org_id',
    sql: `UPDATE document_paragraphs g SET org_id = c.org_id
            FROM clients c WHERE c.id = g.client_id AND g.org_id IS NULL`,
  },
  {
    label: 'chat_documents.org_id',
    sql: `UPDATE chat_documents cd SET org_id = c.org_id
            FROM clients c WHERE c.id = cd.client_id AND cd.org_id IS NULL`,
  },

  // --- org-level metadata, keyed through their own parents -------------------
  {
    label: 'portal_source_bindings.org_id',
    sql: `UPDATE portal_source_bindings b SET org_id = p.org_id
            FROM portals p WHERE p.id = b.portal_row_id AND b.org_id IS NULL`,
  },
  {
    label: 'alert_deliveries.org_id',
    sql: `UPDATE alert_deliveries d SET org_id = a.org_id
            FROM system_alerts a WHERE a.id = d.alert_id AND d.org_id IS NULL`,
  },
]

/** Tables that must have no NULL left before v9 can add NOT NULL. */
const VERIFY = [
  ['client_settings', 'org_id'],
  ['client_group_members', 'org_id'],
  ['documents', 'org_id'],
  ['document_folders', 'org_id'],
  ['document_chunks', 'org_id'],
  ['document_pages', 'org_id'],
  ['document_pages', 'client_id'],
  ['document_paragraphs', 'org_id'],
  ['document_paragraphs', 'client_id'],
  ['chats', 'org_id'],
  ['chat_messages', 'org_id'],
  ['chat_documents', 'org_id'],
  ['chat_documents', 'client_id'],
  ['ingest_jobs', 'org_id'],
  ['embedding_batches', 'org_id'],
  ['usage_events', 'org_id'],
  ['rag_traces', 'org_id'],
  ['portal_source_bindings', 'org_id'],
  ['alert_deliveries', 'org_id'],
]

function parseArgs(argv) {
  let stage = 'dev'
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--stage') stage = argv[i + 1]
  }
  if (stage !== 'dev' && stage !== 'prod') throw new Error(`--stage must be dev or prod, got "${stage}"`)
  return { stage }
}

/**
 * Resolve the store by alias through Gate, not from `fusebase.json`.
 *
 * `fusebase deploy` has repeatedly rewritten that file to point at a second, empty
 * store on this org. A backfill that ran there would report success and leave the
 * real database untouched — the one failure mode a data step must not have.
 */
async function resolveStore(api, orgId) {
  const response = await api.listIsolatedStores({ path: { orgId } })
  const stores = response.stores ?? []
  const match = stores.find((store) => store.alias === STORE_ALIAS)
  if (!match) {
    throw new Error(
      `No store aliased "${STORE_ALIAS}" in org ${orgId}. Present: ` +
        (stores.map((s) => `${s.alias}=${s.globalId}`).join(', ') || 'none'),
    )
  }
  return match.globalId
}

async function main() {
  const { stage } = parseArgs(process.argv.slice(2))
  const env = { ...readEnvFile(), ...process.env }
  const token = (env.GATE_MCP_TOKEN ?? '').trim()
  if (!token) throw new Error('GATE_MCP_TOKEN is not set (.env or environment)')

  const config = JSON.parse(readFileSync(join(ROOT, 'fusebase.json'), 'utf8'))
  const orgId = config.orgId
  const host = (env.FUSEBASE_HOST ?? 'thefusebase.com').trim()

  const client = createClient({
    baseUrl: `https://app-api.${host}/v4/api/proxy/gate-service/v1`,
    auth: { token },
    timeout: 120000,
  })
  const api = new IsolatedStoresApi(client)
  const storeId = await resolveStore(api, orgId)
  const path = { orgId, storeId, stage }

  console.log(`store ${storeId} alias=${STORE_ALIAS} stage=${stage}`)

  for (const statement of STATEMENTS) {
    const response = await api.executeIsolatedStoreSql({
      path,
      body: { sql: statement.sql, params: [] },
    })
    const count = typeof response.rowCount === 'number' ? response.rowCount : 0
    console.log(`  ${statement.label}: ${count} row(s)`)
  }

  // Verify before v9 rather than trusting the counts above: a statement whose join
  // matched nothing reports 0 rows, which is indistinguishable from "already done".
  console.log('\nverifying no NULLs remain:')
  const problems = []
  for (const [table, column] of VERIFY) {
    const response = await api.queryIsolatedStoreSql({
      path,
      body: { sql: `SELECT count(*) AS n FROM ${table} WHERE ${column} IS NULL`, params: [] },
    })
    const n = Number(response.result?.rows?.[0]?.n ?? 0)
    if (n > 0) problems.push(`${table}.${column}: ${n} NULL row(s)`)
    console.log(`  ${table}.${column}: ${n === 0 ? 'clean' : `${n} NULL — BLOCKS v9`}`)
  }

  if (problems.length > 0) {
    throw new Error(
      `Backfill incomplete — do NOT apply v9:\n  - ${problems.join('\n  - ')}\n` +
        'A row whose tenancy column is NULL cannot satisfy any policy, so v9 would ' +
        'make it permanently invisible.',
    )
  }
  console.log('\nBackfill complete. v9 can be applied to this stage.')
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error)
  if (error && typeof error === 'object' && 'body' in error) {
    console.error('body:', JSON.stringify(error.body, null, 2))
  }
  process.exit(1)
})
