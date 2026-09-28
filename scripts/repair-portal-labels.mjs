/**
 * Give every portal a readable label.
 *
 * Portals whose `label` is still the raw platform id are the ones nobody named: the
 * rows inserted by hand before §5A existed, and any portal that self-registered on a
 * visitor's first visit, because nothing in the verified portal context token carries
 * a name and calling Gate on that request path would put a network hop in front of
 * every first page load.
 *
 * The admin list already prefers the platform's domain over a raw id when it renders
 * (see `portalLabel` in the admin's `routes/portals.ts`), but the *stored* label is
 * what the portal picker in the shell and every audit row read. So this writes it
 * once, and after that every surface agrees.
 *
 * Where the label comes from: `listPortals` returns no `name` for this org — only
 * `domain` — so the first label of the domain is used. `client-b-portal.p.nimbusweb.me`
 * becomes `client-b-portal`, which is what staff call it.
 *
 * Only ever touches rows where `label = portal_id`. A label a person chose is never
 * overwritten, so this is safe to re-run after any deploy.
 *
 * Auth: GATE_MCP_TOKEN from .env, same as scripts/sql-migrate.mjs.
 *
 * Usage (from repo root):
 *   node scripts/repair-portal-labels.mjs --stage dev [--dry-run]
 *   node scripts/repair-portal-labels.mjs --stage prod --yes
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, IsolatedStoresApi, PortalsApi } from '@fusebase/fusebase-gate-sdk'

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

/** Resolve the store by alias through Gate — never from `fusebase.json`. */
async function resolveStoreByAlias(api, orgId) {
  const response = await api.listIsolatedStores({ path: { orgId } })
  const stores = response.stores ?? []
  const match = stores.find((store) => store.alias === STORE_ALIAS)
  if (!match) {
    throw new Error(
      `No store aliased "${STORE_ALIAS}" exists in org ${orgId}. Present: ` +
        (stores.map((s) => `${s.alias}=${s.globalId}`).join(', ') || 'none'),
    )
  }
  return match.globalId
}

/** The readable name for a portal, or null when the platform offers nothing better. */
function labelFor(portal) {
  const name = typeof portal.name === 'string' ? portal.name.trim() : ''
  if (name.length > 0) return name.slice(0, 200)

  const domain = typeof portal.domain === 'string' ? portal.domain.trim() : ''
  if (domain.length === 0) return null
  const first = domain.split('.')[0]
  return (first && first.length > 0 ? first : domain).slice(0, 200)
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
  return { stage, dryRun, yes }
}

async function main() {
  const { stage, dryRun, yes } = parseArgs(process.argv.slice(2))
  if (stage === 'prod' && !yes && !dryRun) {
    throw new Error('refusing to write to prod without --yes (or use --dry-run)')
  }

  const env = { ...readEnvFile(), ...process.env }
  const token = (env.GATE_MCP_TOKEN ?? '').trim()
  if (!token) throw new Error('GATE_MCP_TOKEN is not set (.env or environment)')

  const orgId = JSON.parse(readFileSync(join(ROOT, 'fusebase.json'), 'utf8')).orgId
  const host = (env.FUSEBASE_HOST ?? 'thefusebase.com').trim()

  const client = createClient({
    baseUrl: `https://app-api.${host}/v4/api/proxy/gate-service/v1`,
    defaultHeaders: { authorization: `Bearer ${token}` },
  })
  const stores = new IsolatedStoresApi(client)
  const portalsApi = new PortalsApi(client)
  const storeId = await resolveStoreByAlias(stores, orgId)

  console.log(`store ${storeId} alias=${STORE_ALIAS} stage=${stage}${dryRun ? ' (dry run)' : ''}`)

  const platform = await portalsApi.listPortals({ path: { orgId } })
  const byId = new Map()
  for (const portal of platform.portals ?? []) {
    if (typeof portal.id === 'string') byId.set(portal.id, portal)
  }

  const unnamed = (
    await stores.queryIsolatedStoreSql({
      path: { orgId, storeId, stage },
      body: {
        sql: 'SELECT id, portal_id FROM portals WHERE label = portal_id ORDER BY portal_id',
        params: [],
      },
    })
  ).result?.rows ?? []

  if (unnamed.length === 0) {
    console.log('every portal already has a label of its own — nothing to do')
    return
  }

  let repaired = 0
  for (const row of unnamed) {
    const portalId = String(row.portal_id)
    const platformPortal = byId.get(portalId)

    if (!platformPortal) {
      // Deleted in FuseBase. The row and its documents stay — that is §A.6 — but
      // there is no name to take, so the id remains and the screen says why.
      console.log(`  ${portalId}: not listed by the platform, leaving the id`)
      continue
    }

    const label = labelFor(platformPortal)
    if (!label || label === portalId) {
      console.log(`  ${portalId}: the platform offers no name either`)
      continue
    }

    if (!dryRun) {
      await stores.executeIsolatedStoreSql({
        path: { orgId, storeId, stage },
        body: {
          sql: 'UPDATE portals SET label = $1 WHERE id = $2 AND label = portal_id',
          params: [label, String(row.id)],
        },
      })
    }
    repaired += 1
    console.log(`  ${portalId} -> "${label}"${dryRun ? ' (dry run)' : ''}`)
  }

  console.log(`\n${repaired} of ${unnamed.length} unnamed portal(s) ${dryRun ? 'would be' : 'were'} renamed`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
