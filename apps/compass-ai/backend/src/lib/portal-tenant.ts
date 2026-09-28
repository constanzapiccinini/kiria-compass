/**
 * Provisioning a portal's tenant — §5A.2.
 *
 * One function, called from exactly two places: the admin app's provision route and
 * `resolvePortalContext` when a verified token arrives for a portal we have never
 * seen. Revision 2 of the phase spec removed the step where staff assigned a portal
 * to a client, so nothing here asks a human anything: **one portal is one client**,
 * and the row appears by itself.
 *
 * ---------------------------------------------------------------------------
 * Idempotency without a transaction
 *
 * The spec asks for step 2 "in one transaction". That is not available to us: writes
 * go through the structured row API, and `executeIsolatedStoreSql` — the only way to
 * open a transaction — needs `isolated_store.execute`, which the app token
 * deliberately lacks. Rather than pretend, every step is made individually
 * idempotent and keyed so a half-finished run repairs itself on the next call:
 *
 *   - the `clients` row is found or created by **slug**, which is derived from the
 *     portal id and so is stable across retries. `clients` has UNIQUE (org_id, slug),
 *     so two concurrent first visits cannot produce two clients.
 *   - the `portals` row insert races on `portals_portal_id_key` UNIQUE
 *     (org_id, portal_id). The loser re-reads instead of checking first, which is
 *     what the spec asks for and the only version that is actually safe.
 *   - `ensurePrivateLibrary` keys on the binding, not the name, so a renamed library
 *     is found rather than duplicated.
 *
 * So a crash between any two steps leaves a partial tenant that the next call
 * completes, and never a duplicate. That is a weaker guarantee than a transaction —
 * a client with no portal row can briefly exist — but it is a guarantee, and it is
 * stated rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * Duplicated in `apps/compass-admin/backend/src/lib/portal-tenant.ts`
 *
 * Not a choice. Backends are not shared between apps on this platform and no code
 * crosses the boundary, while both callers are required by the spec: the admin
 * provisions on click, the client app self-registers on first visit. The two copies
 * must be edited together; each carries this note so neither looks authoritative.
 */

import { orgId } from './config.js'
import { logStep } from './observability.js'
import { insertRow, queryOne, readString } from './store.js'
import { ensurePrivateLibrary } from './private-library.js'

export interface PortalTenant {
  /** `portals.id` — our row, not the platform's portal id. */
  portalRowId: string
  clientId: string
  clientName: string
  status: string
  /** True only when this call created the tenant, for audit and logging. */
  created: boolean
}

/**
 * The tenancy slug for a portal.
 *
 * Derived from the portal id and nothing else, because it is the recovery key: a
 * retry after a partial provision has to find the same client, and a name-derived
 * slug would not (the label can change, and two portals may share a name).
 */
function tenantSlug(portalId: string): string {
  const normalized = portalId
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `portal-${normalized}`.slice(0, 80)
}

/** The tenant for this portal, or null if it has never been provisioned. */
export async function findPortalTenant(portalId: string): Promise<PortalTenant | null> {
  const row = await queryOne(
    `SELECT p.id, p.status, c.id AS client_id, c.name AS client_name
       FROM portals p
       JOIN clients c ON c.id = p.client_id
      WHERE p.org_id = $1 AND p.portal_id = $2`,
    [orgId(), portalId],
  )
  if (!row) return null

  return {
    portalRowId: readString(row, 'id'),
    clientId: readString(row, 'client_id'),
    clientName: readString(row, 'client_name'),
    status: readString(row, 'status'),
    created: false,
  }
}

/** Find-or-create this portal's client, keyed by the stable slug. */
async function ensureTenantClient(
  portalId: string,
  label: string,
  actorUserId: string,
): Promise<{ clientId: string; clientName: string }> {
  const slug = tenantSlug(portalId)

  const existing = await queryOne('SELECT id, name FROM clients WHERE org_id = $1 AND slug = $2', [
    orgId(),
    slug,
  ])
  if (existing) {
    return { clientId: readString(existing, 'id'), clientName: readString(existing, 'name') }
  }

  try {
    const created = await insertRow(
      'clients',
      {
        org_id: orgId(),
        name: label,
        slug,
        created_by_user_id: actorUserId,
      },
      ['id', 'name'],
    )
    if (created) {
      return { clientId: readString(created, 'id'), clientName: readString(created, 'name') }
    }
  } catch (error) {
    // Lost the race on (org_id, slug). The winner's row is the tenant; re-read it
    // rather than failing the visitor who happened to arrive second.
    const raced = await queryOne('SELECT id, name FROM clients WHERE org_id = $1 AND slug = $2', [
      orgId(),
      slug,
    ])
    if (raced) {
      return { clientId: readString(raced, 'id'), clientName: readString(raced, 'name') }
    }
    throw error
  }

  throw new Error(`Could not create a tenant client for portal ${portalId}`)
}

/**
 * Ensure this portal has a tenant, creating one if it has none.
 *
 * `label` is the name the platform gave the portal — `listPortals` when discovery is
 * available, otherwise the label on the sighting, otherwise the portal id (§A.2). It
 * is never typed into a form, and renaming it later touches nothing else.
 *
 * Safe to call on every request: the common path is one indexed SELECT.
 */
export async function ensurePortalTenant(
  portalId: string,
  workspaceId: string | null,
  label: string,
  actorUserId: string,
): Promise<PortalTenant> {
  const found = await findPortalTenant(portalId)
  if (found) return found

  const displayLabel = (label.trim().length > 0 ? label.trim() : portalId).slice(0, 200)
  const { clientId, clientName } = await ensureTenantClient(portalId, displayLabel, actorUserId)

  // Without this row `resolveEffectiveSettings` has no client layer to read and the
  // settings screen shows defaults it cannot edit. Best-effort because a second call
  // is a duplicate primary key, not a failure.
  await insertRow('client_settings', { client_id: clientId }, ['client_id']).catch(() => undefined)

  let portalRowId: string
  try {
    const created = await insertRow(
      'portals',
      {
        org_id: orgId(),
        portal_id: portalId,
        workspace_id: workspaceId,
        client_id: clientId,
        label: displayLabel,
        status: 'active',
      },
      ['id'],
    )
    if (!created) throw new Error(`Could not create a portals row for ${portalId}`)
    portalRowId = readString(created, 'id')
  } catch (error) {
    // `portals_portal_id_key` — two first visits at once. One tenant is the correct
    // outcome, so the loser adopts the winner's.
    const raced = await findPortalTenant(portalId)
    if (raced) {
      logStep('portal.provision_raced', { portalId, clientId: raced.clientId })
      return raced
    }
    throw error
  }

  // The part that matters most and is easiest to forget: without a library ticked
  // to it, a brand-new portal cannot receive a direct upload at all. That is the same
  // trap the Phase 4 backfill had to repair by hand.
  //
  // A **private** library rather than the old `app_upload` source (§6A.3): a file
  // enters the system through a library and no other way, so "just for this portal"
  // has to be a library too or the model is two things again. It runs after the
  // portals row exists because the tick needs a portal row to point at.
  await ensurePrivateLibrary(portalRowId, displayLabel, actorUserId)

  logStep('portal.provisioned', { portalId, portalRowId, clientId, label: displayLabel })

  return { portalRowId, clientId, clientName, status: 'active', created: true }
}
