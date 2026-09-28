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
  IsolatedStoresApi,
  FilesApi,
  PortalFeatureContextApi,
  OrgUsersApi,
  EmailsApi,
  type Client,
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
 * Portal embed context. Verified with the CALLER'S app token, never the service
 * token: Gate returns the caller's userId only when that session is bound to the
 * verified portal, and a service token has no such binding.
 */
export function createPortalFeatureContextApi(auth: GateAuth): PortalFeatureContextApi {
  return new PortalFeatureContextApi(createGateClient(auth))
}

/**
 * Portal membership lookups (listPortalMembers lives on OrgUsersApi).
 * Service-token call — needs org.members.read.
 */
export function createOrgUsersApi(auth: GateAuth): OrgUsersApi {
  return new OrgUsersApi(createGateClient(auth))
}

/**
 * Alert email delivery (§10.3). Service-token call — needs `email.write` plus org
 * access.
 *
 * `sendOrgEmail` takes exactly ONE recipient per call and resolves it against org
 * membership: a digit-only string is a userId, a string containing `@` is an email,
 * and either way the person must already belong to the org. So a recipient list is a
 * loop, and an address that is not a member fails on its own rather than poisoning
 * the whole send.
 */
export function createEmailsApi(auth: GateAuth): EmailsApi {
  return new EmailsApi(createGateClient(auth))
}
