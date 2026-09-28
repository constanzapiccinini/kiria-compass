/**
 * Gate SDK client factories.
 *
 * Factories return the FULL `*Api` classes and callers make direct method calls, so
 * `fusebase analyze gate` / `--sync-gate-permissions` can statically derive the
 * published permission grant. Do not narrow these with `Pick<>`, minimal interfaces,
 * or method destructuring — that hides operations from the analyzer and causes
 * permission drift in production.
 */

import {
  createClient,
  AccessApi,
  IsolatedStoresApi,
  FilesApi,
  OrgUsersApi,
  type Client,
  PortalsApi,
} from '@fusebase/fusebase-gate-sdk'
import { gateBaseUrl, type GateAuth } from './config.js'

/**
 * Build a Gate client for the given auth.
 *
 * The deploy-time service token must go in `x-app-feature-token`; sending it as
 * `Authorization: Bearer` is rejected with 401. The local dev MCP token is the
 * opposite — it is a Bearer token. Leave the SDK's 30000ms timeout default alone,
 * since one AbortController spans all internal retries.
 */
function createGateClient(auth: GateAuth): Client {
  if (auth.transport === 'feature') {
    return createClient({
      baseUrl: gateBaseUrl(),
      defaultHeaders: { 'x-app-feature-token': auth.token },
    })
  }
  return createClient({
    baseUrl: gateBaseUrl(),
    auth: { token: auth.token },
  })
}

export function createIsolatedStoresApi(auth: GateAuth): IsolatedStoresApi {
  return new IsolatedStoresApi(createGateClient(auth))
}

export function createFilesApi(auth: GateAuth): FilesApi {
  return new FilesApi(createGateClient(auth))
}

/**
 * Org access for the CALLING user — the admin app's whole authorization basis.
 *
 * Always built with the caller's own app token. A service token would answer for the
 * service rather than the person, which would authorize everyone.
 *
 * There is deliberately no portal-context factory here: this app has no portal, and
 * a portal token must never be a way into admin routes.
 */
export function createAccessApi(auth: GateAuth): AccessApi {
  return new AccessApi(createGateClient(auth))
}

/**
 * Portal membership lookups (listPortalMembers lives on OrgUsersApi).
 * Service-token call — needs org.members.read.
 */
export function createOrgUsersApi(auth: GateAuth): OrgUsersApi {
  return new OrgUsersApi(createGateClient(auth))
}

/**
 * Portal discovery (§5A). Service-token call — needs `portals.read`, org-scoped.
 *
 * The ids `listPortals` returns are the same identifier space as the `portalId` claim
 * in a portal context token — verified rather than assumed, because the platform uses
 * several id shapes and getting the join key wrong would make every portal read as
 * unbound. `getPortal` accepts a `listPortals` id (200) and rejects an id from our own
 * stale `portals` rows (404), which settles it.
 */
export function createPortalsApi(auth: GateAuth): PortalsApi {
  return new PortalsApi(createGateClient(auth))
}
