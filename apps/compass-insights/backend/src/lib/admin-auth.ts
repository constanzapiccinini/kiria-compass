/**
 * Admin authorization — the boundary for the whole admin app.
 *
 * This app is the inverse of the client app, and the difference matters:
 *
 * - The **client app** derives its tenant from a verified portal context and refuses
 *   any caller-supplied tenant id. One portal is one client, always.
 * - The **admin app** has no portal. An employee picks a client explicitly, so admin
 *   routes *do* take a `clientId` — and that is correct here, because authorization
 *   asks "is this caller KIRIA staff", not "does this caller own that client". §3.2
 *   and §9 both say an employee reaches any client.
 *
 * That inversion is why this file exists rather than reusing the client app's
 * `portal.ts`: reusing it would either fake a portal context or weaken its rule that
 * a caller may never name a tenant.
 *
 * Identity comes from the caller's own app session, checked against Gate on every
 * request. Nothing role-shaped is stored, exactly as in the client app, so a
 * revoked employee loses access without a deploy.
 */

import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { orgId } from './config.js'
import { createAccessApi } from './gate.js'
import { HttpError } from './auth.js'
import { logStep } from './observability.js'

/**
 * Org roles that make someone KIRIA staff.
 *
 * `client` is deliberately absent. A portal client who somehow reached this app's
 * origin must be refused, not merely shown less.
 */
const EMPLOYEE_ORG_ROLES = new Set(['member', 'manager', 'owner'])

export interface AdminActor {
  userId: string
  email: string | null
  orgRole: string
}

/**
 * Verify results are cached for 60s per token.
 *
 * The same reasoning as the client app: short enough that revoking someone takes
 * effect within a minute, long enough that a screen making eight parallel calls does
 * not make eight Gate round trips.
 */
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { actor: AdminActor; expiresAt: number }>()

/** The caller's own app session token. Header first, same-origin cookie second. */
function readAppToken(c: Context): string | null {
  return c.req.header('x-app-feature-token') ?? getCookie(c, 'fbsfeaturetoken') ?? null
}

/**
 * Resolve the calling employee, or throw.
 *
 * Fails closed at every step. A caller who is authenticated but not a member, whose
 * membership is disabled or expired, or whose role is `client`, is refused — there is
 * no partial admin.
 */
export async function requireAdmin(c: Context): Promise<AdminActor> {
  const token = readAppToken(c)
  if (!token) {
    throw new HttpError(401, 'No app session on the request', 'NOT_AUTHENTICATED')
  }

  const cached = cache.get(token)
  if (cached && cached.expiresAt > Date.now()) return cached.actor

  // Called with the CALLER's token, never the service token: the question is who is
  // asking, and a service token would answer for the service instead.
  const api = createAccessApi({ token, transport: 'feature' })

  let access: Awaited<ReturnType<typeof api.getMyOrgAccess>>
  try {
    access = await api.getMyOrgAccess({ path: { orgId: orgId() } })
  } catch (error) {
    // Gate being unreachable must not become "allowed".
    throw new HttpError(
      403,
      `Could not verify organization access: ${error instanceof Error ? error.message : String(error)}`,
      'ACCESS_CHECK_FAILED',
    )
  }

  if (!access.hasOrgAccess || access.membershipStatus !== 'ready') {
    logStep('admin.denied', {
      reason: 'membership',
      membershipStatus: access.membershipStatus,
      hasOrgAccess: access.hasOrgAccess,
    })
    throw new HttpError(403, 'You are not a member of this organization', 'NOT_ORG_MEMBER')
  }

  const orgRole = typeof access.role === 'string' ? access.role : null
  if (!orgRole || !EMPLOYEE_ORG_ROLES.has(orgRole)) {
    logStep('admin.denied', { reason: 'role', orgRole })
    throw new HttpError(403, 'This application is for KIRIA staff only', 'NOT_EMPLOYEE')
  }

  const actor: AdminActor = {
    userId: String(access.user.id),
    email: typeof access.user.email === 'string' ? access.user.email : null,
    orgRole,
  }

  // Bound the map so a burst of distinct sessions cannot grow it without limit.
  if (cache.size > 500) {
    const now = Date.now()
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key)
    if (cache.size > 500) cache.clear()
  }
  cache.set(token, { actor, expiresAt: Date.now() + CACHE_TTL_MS })

  return actor
}

/** Clear the cache. Used by tests; never called from a request path. */
export function clearAdminCache(): void {
  cache.clear()
}
