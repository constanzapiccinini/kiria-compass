/**
 * Portal resolution — the tenancy boundary.
 *
 * Every client-facing request answers three questions here, and nowhere else:
 * WHERE is this request from (which portal), WHO is calling (which user), and WHAT
 * are they (employee or client). The answer is derived per request from platform
 * state; nothing role-shaped is stored, so nothing can drift from the truth.
 *
 * Two properties of the portal context token drive the whole design:
 *
 *   1. It carries NO user. It is minted once when the brick is saved, has no `exp`,
 *      and is served identically to every viewer of the portal page. It proves
 *      *where*, never *who*.
 *   2. Because it is static and shared, holding it is not evidence of anything.
 *      Identity comes from the caller's own `fbsfeaturetoken` session, which is why
 *      the verify call is made with the CALLER'S app token — Gate returns `userId`
 *      only when that session is itself bound to the verified portal.
 *
 * Gate's own contract is explicit that a portal-bound session still does not prove
 * portal *membership*. So for client actors this module checks membership directly
 * against the portal's member list rather than trusting the binding alone.
 */

import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { appPathIdCandidates, orgId, serviceGateAuth, type GateAuth } from './config.js'
import { ensurePortalTenant } from './portal-tenant.js'
import { raiseAlert } from './alerts.js'
import { createOrgUsersApi, createPortalFeatureContextApi } from './gate.js'
import { logStep, recordAudit } from './observability.js'
import { setRequestClient } from './request-scope.js'
import { insertRow, queryOne, readNumber, readString, updateRows } from './store.js'

/** The only two roles. Derived per request, never stored, never editable. */
export type Actor = 'employee' | 'client'

export interface PortalContext {
  /** Platform portal global id, from the verified token. */
  portalId: string
  /** Platform workspace behind the portal; used only for Gate membership calls. */
  workspaceId: string
  /** Our tenant id. Every client-facing query filters on this. */
  clientId: string
  clientName: string
  actor: Actor
  userId: string
  orgRole: string
  email: string | null
}

/** Stable machine codes, so tests and clients assert on codes rather than prose. */
export type PortalErrorCode =
  | 'PORTAL_CONTEXT_MISSING'
  | 'PORTAL_VERIFY_FAILED'
  | 'PORTAL_SESSION_ANONYMOUS'
  | 'PORTAL_NOT_BOUND'
  | 'PORTAL_PAUSED'
  | 'FORBIDDEN_CLIENT_ROLE'
  | 'FORBIDDEN_NOT_PORTAL_MEMBER'

export class PortalError extends Error {
  readonly status: 400 | 401 | 403 | 409 | 503
  readonly code: PortalErrorCode
  /** Text safe to show a client. Never leaks table names, ids or provider detail. */
  readonly clientMessage: string

  constructor(
    status: PortalError['status'],
    code: PortalErrorCode,
    message: string,
    clientMessage: string,
  ) {
    super(message)
    this.name = 'PortalError'
    this.status = status
    this.code = code
    this.clientMessage = clientMessage
  }
}

/** Org roles that make someone KIRIA staff. */
const EMPLOYEE_ORG_ROLES = new Set(['member', 'manager', 'owner'])

/**
 * Verify results are cached for 60s per (token, user).
 *
 * Deliberately short: the token is static and long-lived, so it is a portal
 * artifact rather than a credential, and a membership change must take effect
 * within a minute — not at the next deploy.
 */
const CACHE_TTL_MS = 60_000

interface CacheEntry {
  context: PortalContext
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function cacheKey(portalToken: string, appToken: string): string {
  // Hash both: the token identifies the portal, the app token the session. Neither
  // value is ever logged. The separator is written as an escape rather than a raw
  // byte, and NUL specifically because it cannot occur inside either token — so no
  // pair of (portal, app) tokens can ever collide onto one key.
  return createHash('sha256').update(`${portalToken}\u0000${appToken}`).digest('hex')
}

function readCache(key: string): PortalContext | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.context
}

function writeCache(key: string, context: PortalContext): void {
  // Bound the map so a burst of distinct sessions cannot grow it without limit.
  if (cache.size > 500) {
    const now = Date.now()
    for (const [existing, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(existing)
    }
    if (cache.size > 500) cache.clear()
  }
  cache.set(key, { context, expiresAt: Date.now() + CACHE_TTL_MS })
}

/**
 * Read the portal context token.
 *
 * The header is the normal path. The query parameter is accepted only because the
 * very first request of an embed is the page load itself; it is never read from a
 * request body, where a caller could set it freely alongside their own session.
 */
function readPortalToken(c: Context): { token: string; source: 'header' | 'query' } | null {
  const header = c.req.header('x-portal-context')
  if (header && header.trim().length > 0) return { token: header.trim(), source: 'header' }

  const query = c.req.query('portalFeatureContextToken')
  if (query && query.trim().length > 0) return { token: query.trim(), source: 'query' }

  return null
}

/** The caller's own app session token. Header first, same-origin cookie second. */
function readAppToken(c: Context): string | null {
  return c.req.header('x-app-feature-token') ?? getCookie(c, 'fbsfeaturetoken') ?? null
}

interface VerifiedContext {
  portalId: string
  workspaceId: string
  userId: string | null
  orgRole: string | null
}

/** Pull the status and response body out of an SDK error, for a usable log line. */
function describeGateError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const shaped = error as { status?: unknown; body?: unknown; message?: unknown }
  const status = typeof shaped.status === 'number' ? shaped.status : '?'
  const body =
    shaped.body === undefined
      ? ''
      : ` body=${typeof shaped.body === 'string' ? shaped.body : JSON.stringify(shaped.body)}`
  const message = typeof shaped.message === 'string' ? shaped.message : ''
  return `${status} ${message}${body}`.slice(0, 600)
}

/**
 * Describe a token without disclosing it: length, JWT segment count and a short
 * hash prefix. Enough to see truncation, double-encoding or a wrong parameter, and
 * enough to tell two failing loads apart, while the value itself stays out of logs.
 */
function fingerprintToken(token: string): string {
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 12)
  return `len=${token.length} segments=${token.split('.').length} sha=${digest}`
}

/**
 * The platform id env vars that are present, with values.
 *
 * These are public platform configuration — never secrets — and the list is
 * allow-listed by name so no token-bearing variable can be logged by accident.
 */
function platformIdEnvSnapshot(): string {
  const names = [
    'FBS_ORG_ID',
    'FBS_APP_ID',
    'FBS_APP_FEATURE_GLOBAL_ID',
    'FBS_PRODUCT_ID',
    'FBS_ENV',
  ]
  const present = names
    .map((name) => [name, process.env[name]?.trim()] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    .map(([name, value]) => `${name}=${value}`)

  // Also name (never value) any other FBS_* key, so a variable carrying the feature
  // id under an unexpected name becomes visible instead of staying invisible.
  const otherKeys = Object.keys(process.env)
    .filter((key) => key.startsWith('FBS_') && !names.includes(key))
    .sort()

  return `${present.join(' ')} otherKeys=[${otherKeys.join(',')}]`
}

/**
 * Gate's `/apps/{id}` path segment is legacy-ambiguous: on some routes it is the
 * PRODUCT id, on others the App (feature) id. The verify response returns both
 * separately, which does not settle what the path wants — and on deploy the platform
 * injects `FBS_APP_ID` with the PRODUCT id, so the obvious single call sends the
 * product id whether or not that is what the route wants.
 *
 * A wrong id and a bad token both come back as `400 Invalid portal feature context
 * token`, so the two are indistinguishable from one response. Try each distinct id
 * the environment offers and keep the one Gate accepts, logging which. Same shape as
 * the documented "probe both transports" pattern for the deploy token; once the log
 * names the winner this can collapse to a single call.
 */
async function verifyToken(
  portalToken: string,
  callerAuth: GateAuth,
  tokenSource: 'header' | 'query',
): Promise<VerifiedContext> {
  const api = createPortalFeatureContextApi(callerAuth)
  const candidates = appPathIdCandidates()
  const failures: string[] = []

  for (const candidate of candidates) {
    try {
      const response = await api.verifyPortalFeatureContextToken({
        path: { orgId: orgId(), appId: candidate.id },
        body: { token: portalToken },
      })
      logStep('portal.verified', { pathParam: candidate.label, portalId: response.portalId })
      return {
        portalId: response.portalId,
        workspaceId: response.workspaceId,
        userId: typeof response.userId === 'number' ? String(response.userId) : null,
        orgRole: typeof response.orgRole === 'string' ? response.orgRole : null,
      }
    } catch (error) {
      failures.push(`${candidate.label}=${candidate.id}: ${describeGateError(error)}`)
    }
  }

  // Gate answers a wrong path id and a malformed token with the same 400, so on
  // failure record the shape of what we sent. Enough to tell those apart, and no
  // token value: only a length, a JWT segment count and a hash prefix. The env keys
  // are public platform config, not secrets, and only id-shaped ones are included.
  logStep('portal.verify_failed_shape', {
    token: `${fingerprintToken(portalToken)} source=${tokenSource}`,
    candidates: candidates.map((candidate) => candidate.label),
    platformIdEnv: platformIdEnvSnapshot(),
  })

  // A token for another product/app, a tampered token, or Gate being unreachable all
  // land here. None of them may fall through to an unscoped view.
  throw new PortalError(
    403,
    'PORTAL_VERIFY_FAILED',
    `Portal context verification failed. ${failures.join(' | ')}`,
    'This page could not be confirmed. Please reload, or contact your KIRIA team.',
  )
}

interface PortalMember {
  userId: string
  orgRole: string | null
  isPortalManager: boolean
  email: string | null
}

function readMember(value: unknown): PortalMember | null {
  if (typeof value !== 'object' || value === null) return null
  const member = value as Record<string, unknown>
  const rawId = member.userId
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return null

  return {
    userId: String(rawId),
    orgRole: typeof member.orgRole === 'string' ? member.orgRole : null,
    isPortalManager: member.isPortalManager === true,
    email: typeof member.email === 'string' ? member.email : null,
  }
}

/**
 * Find the caller in the portal's member list.
 *
 * This is the membership check the portal token cannot provide. It runs on the
 * service token because reading org membership is an org-scoped read the caller's
 * own token is not granted.
 */
async function findPortalMember(
  workspaceId: string,
  userId: string,
): Promise<PortalMember | null> {
  const api = createOrgUsersApi(serviceGateAuth())
  const response = await api.listPortalMembers({ path: { orgId: orgId(), workspaceId } })

  const members = Array.isArray(response.members) ? response.members : []
  for (const raw of members) {
    const member = readMember(raw)
    if (member && member.userId === userId) return member
  }
  return null
}

interface BoundClient {
  clientId: string
  clientName: string
  portalStatus: string
}

/** Resolve the portal row that binds this platform portal to one of our clients. */
async function findBoundClient(portalId: string): Promise<BoundClient | null> {
  const row = await queryOne(
    `SELECT p.client_id, p.status AS portal_status, c.name AS client_name, c.status AS client_status
       FROM portals p
       JOIN clients c ON c.id = p.client_id
      WHERE p.org_id = $1 AND p.portal_id = $2`,
    [orgId(), portalId],
  )
  if (!row) return null

  return {
    clientId: readString(row, 'client_id'),
    clientName: readString(row, 'client_name'),
    portalStatus: readString(row, 'portal_status'),
  }
}

/**
 * Resolve the trusted context for a client-facing request.
 *
 * Throws `PortalError` for every rejection, each with a stable code and a message
 * that is safe to show a client.
 */
export async function resolvePortalContext(c: Context): Promise<PortalContext> {
  const portalContextToken = readPortalToken(c)
  if (!portalContextToken) {
    throw new PortalError(
      400,
      'PORTAL_CONTEXT_MISSING',
      'No portal context token on the request (expected x-portal-context)',
      'This app must be opened from your KIRIA portal.',
    )
  }

  const appToken = readAppToken(c)
  if (!appToken) {
    throw new PortalError(
      401,
      'PORTAL_SESSION_ANONYMOUS',
      'No app session token on the request',
      'Please sign in to view this page.',
    )
  }

  const { token: portalToken, source: tokenSource } = portalContextToken

  const key = cacheKey(portalToken, appToken)
  const cached = readCache(key)
  if (cached) {
    // The scope has to be set on a cache hit too. Missing this would mean that for
    // 60 seconds after a first resolution, every subsequent request ran with no
    // client scope at all — the kind of gap that only appears under real traffic,
    // never in a single-request test.
    setRequestClient(cached.clientId)
    return cached
  }

  const started = Date.now()
  const callerAuth: GateAuth = { token: appToken, transport: 'feature' }
  const verified = await verifyToken(portalToken, callerAuth, tokenSource)

  // No userId means the session is anonymous, unbound, or bound to a DIFFERENT
  // portal. The app is never public, so all three are a hard stop.
  if (!verified.userId) {
    throw new PortalError(
      401,
      'PORTAL_SESSION_ANONYMOUS',
      'Verified portal token but the caller session is not bound to this portal',
      'Please sign in through your KIRIA portal to view this page.',
    )
  }

  const member = await findPortalMember(verified.workspaceId, verified.userId)
  const orgRole = verified.orgRole ?? member?.orgRole ?? null

  if (!orgRole) {
    throw new PortalError(
      403,
      'FORBIDDEN_NOT_PORTAL_MEMBER',
      `Could not determine an org role for user ${verified.userId} on portal ${verified.portalId}`,
      'You do not have access to this page.',
    )
  }

  let actor: Actor
  if (EMPLOYEE_ORG_ROLES.has(orgRole) || member?.isPortalManager === true) {
    actor = 'employee'
  } else if (orgRole === 'client') {
    // A client must actually be a member of THIS portal. The portal token is static
    // and shared, so possessing it proves nothing on its own.
    if (!member) {
      throw new PortalError(
        403,
        'FORBIDDEN_NOT_PORTAL_MEMBER',
        `User ${verified.userId} is not a member of portal ${verified.portalId}`,
        'You do not have access to this page.',
      )
    }
    actor = 'client'
  } else {
    // guest, or anything the platform adds later: refuse rather than guess.
    throw new PortalError(
      403,
      'FORBIDDEN_CLIENT_ROLE',
      `Org role "${orgRole}" has no access to this app`,
      'You do not have access to this page.',
    )
  }

  // ---------------------------------------------------------------------------
  // Self-registration (§5A.4) — the path that always works.
  //
  // A portal that a real person has opened, through a token Gate has verified,
  // is a portal that exists. There is nothing for a human to decide: one portal is
  // one client, so the tenant is provisioned here and the request continues. The
  // visitor sees an empty document list instead of a refusal.
  //
  // **Order is the whole safety argument.** Everything above this line has already
  // run: the token was verified by Gate — which is what confirms the portal belongs
  // to this org and this app — the caller's session was confirmed to be bound to
  // *this* portal, and their org role was resolved. An unverified token provisions
  // nothing, because it never reaches this line.
  //
  // This replaces `PORTAL_NOT_BOUND` as the normal path. The code below is kept and
  // still fires, but only when provisioning itself fails — which is a real fault
  // worth an alert, rather than the greeting every new portal used to get.
  // ---------------------------------------------------------------------------
  let bound = await findBoundClient(verified.portalId)
  if (!bound) {
    // The sighting is still recorded, before provisioning rather than instead of it:
    // it is how the admin screen names a portal that has no name anywhere else, and
    // it survives as the record of when the portal was first opened.
    await recordPortalSighting(verified.portalId, verified.workspaceId)

    try {
      const tenant = await ensurePortalTenant(
        verified.portalId,
        verified.workspaceId,
        // Nothing in the verified context token carries a portal name, and calling
        // Gate here would put a network hop in front of every first page load. The
        // id is stored; the admin list prefers the platform's name over it, and staff
        // can rename it.
        verified.portalId,
        verified.userId,
      )
      logStep('portal.self_registered', {
        portalId: verified.portalId,
        clientId: tenant.clientId,
        userId: verified.userId,
        created: tenant.created,
      })
      bound = {
        clientId: tenant.clientId,
        clientName: tenant.clientName,
        portalStatus: tenant.status,
      }
    } catch (error) {
      logStep('portal.self_registration_failed', {
        portalId: verified.portalId,
        error: error instanceof Error ? error.message : String(error),
      })
      // Now this is a genuine fault: a verified visitor cannot be served and no
      // amount of waiting will fix it. Not awaited — the refusal must not wait on an
      // alert write, and `raiseAlert` never throws.
      void raiseAlert({
        code: 'PORTAL_NOT_BOUND',
        dedupeExtra: verified.portalId,
        cause:
          `Portal ${verified.portalId} has no row in \`portals\` and provisioning one ` +
          `failed: ${error instanceof Error ? error.message : String(error)}. A viewer ` +
          `reached the app through this portal and was refused.`,
        remediationDetail:
          `Open Compass Admin → Portals and provision ${verified.portalId} by hand. ` +
          `Self-registration should have done this automatically, so the failure above ` +
          `is the thing to fix.`,
        metadata: { portalId: verified.portalId, workspaceId: verified.workspaceId },
      })
      throw new PortalError(
        409,
        'PORTAL_NOT_BOUND',
        `Portal ${verified.portalId} could not be provisioned`,
        'This portal is not set up yet. Your KIRIA team has been notified.',
      )
    }
  }

  if (bound.portalStatus !== 'active') {
    throw new PortalError(
      409,
      'PORTAL_PAUSED',
      `Portal ${verified.portalId} is ${bound.portalStatus}`,
      'This portal is paused. Please contact your KIRIA team.',
    )
  }

  const context: PortalContext = {
    portalId: verified.portalId,
    workspaceId: verified.workspaceId,
    clientId: bound.clientId,
    clientName: bound.clientName,
    actor,
    userId: verified.userId,
    orgRole,
    email: member?.email ?? null,
  }

  writeCache(key, context)
  // Every store call for the rest of this request now carries this client (§4.3).
  // Set here rather than at each call site because this is already the single point
  // where tenancy is decided — a route that skips it has no context at all, which is
  // the failure mode the tenancy tests cover.
  setRequestClient(context.clientId)
  void touchPortalSeen(context.portalId)
  logStep('portal.resolved', {
    portalId: context.portalId,
    clientId: context.clientId,
    actor: context.actor,
    durationMs: Date.now() - started,
  })

  return context
}

/**
 * Assert the caller is KIRIA staff.
 *
 * Called inside the handler, not in the router: a route that forgets this fails
 * closed on the tenancy filter rather than silently allowing a write, and the check
 * is visible at the point the write happens.
 */
export function requireEmployee(context: PortalContext): void {
  if (context.actor !== 'employee') {
    throw new PortalError(
      403,
      'FORBIDDEN_CLIENT_ROLE',
      `Actor "${context.actor}" may not perform this action`,
      'You do not have permission to do that.',
    )
  }
}

/**
 * Reject any caller-supplied tenant identifier.
 *
 * Tenancy comes from the verified portal context and nowhere else. A request that
 * carries one of these is a probe, not a mistake, so it is refused rather than
 * silently ignored, and it raises a TENANCY_PROBE alert.
 */
const TENANT_KEYS = ['workspaceId', 'clientId', 'portalId', 'workspace_id', 'client_id', 'portal_id']

export function assertNoTenantOverride(
  c: Context,
  body?: Record<string, unknown> | null,
): string | null {
  for (const key of TENANT_KEYS) {
    const inQuery = c.req.query(key) !== undefined
    const inBody = Boolean(body && Object.prototype.hasOwnProperty.call(body, key))
    if (!inQuery && !inBody) continue

    // Record the attempt here rather than at each of the five call sites, so no route
    // can be added later that refuses a probe silently.
    //
    // Deliberately not awaited: this runs before portal resolution, on a request that
    // is about to be refused, and `recordAudit` writes a stdout line before it touches
    // the database — so the durable signal is already emitted even if the process is
    // frozen before the insert lands. Awaiting would put a database round trip in
    // front of every rejection, which is exactly the wrong place for one.
    void recordAudit({
      orgId: orgId(),
      // No client: the probe is refused before any portal is resolved, and inventing
      // one here would attribute an attack to whichever tenant it was aimed at.
      clientId: null,
      action: 'tenancy_probe_denied',
      targetType: 'request',
      targetId: `${c.req.method} ${new URL(c.req.url).pathname}`,
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      metadata: { key, location: inQuery ? 'query' : 'body' },
    })

    // Also an alert, for the same reason the audit row exists: an entry in a log
    // nobody opens is not a notification. Deliberately deduped on the code alone, so
    // a scripted sweep of every tenant key on every route raises one alert whose
    // occurrence count is the signal, rather than hundreds that bury it.
    void raiseAlert({
      code: 'TENANCY_PROBE',
      cause:
        `A request carried the tenant identifier "${key}" in the ${inQuery ? 'query string' : 'request body'} ` +
        `to ${c.req.method} ${new URL(c.req.url).pathname}. The app takes tenancy only from the verified ` +
        `portal token, so the request was refused before any data was read. No legitimate client sends this.`,
      metadata: {
        key,
        location: inQuery ? 'query' : 'body',
        path: new URL(c.req.url).pathname,
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      },
    })

    return key
  }
  return null
}

/**
 * Record that an unbound portal was visited.
 *
 * Upsert by hand on `(org_id, portal_id)`: the structured row API has no
 * `ON CONFLICT`, so this updates first and inserts only when nothing matched. The
 * order matters — inserting first would raise a unique violation on every visit
 * after the first, which is the common case, not the rare one.
 *
 * Never throws. It runs on a request that is already being refused, and a failure to
 * write a diagnostic must not turn a clean 409 into a 500. Same rule as `raiseAlert`.
 */
async function recordPortalSighting(
  portalId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const now = new Date().toISOString()

    const existing = await queryOne(
      'SELECT id, seen_count FROM portal_registrations WHERE org_id = $1 AND portal_id = $2',
      [orgId(), portalId],
    )

    if (existing) {
      await updateRows(
        'portal_registrations',
        {
          last_seen_at: now,
          seen_count: readNumber(existing, 'seen_count') + 1,
          workspace_id: workspaceId,
          // Cleared on a fresh sighting: a portal dismissed as "not ours" that starts
          // turning people away again is worth surfacing a second time.
          dismissed_at: null,
        },
        [{ column: 'id', operator: 'eq', value: readString(existing, 'id') }],
      )
      return
    }

    await insertRow(
      'portal_registrations',
      { org_id: orgId(), portal_id: portalId, workspace_id: workspaceId },
      ['id'],
    )
    logStep('portal.sighting_recorded', { portalId, workspaceId })
  } catch (error) {
    console.error('[portal] could not record sighting for', portalId, error)
  }
}

/**
 * Stamp the portal as seen.
 *
 * Here rather than in the session route, which is where it used to live: that only
 * covered visitors who happened to load the SPA shell first, so a portal reached by
 * any other route read as "never opened". It is behind the 60-second resolve cache,
 * so this is at most one small write per minute per session, not one per request.
 *
 * Best-effort — a liveness signal must never fail a request that is otherwise fine.
 */
async function touchPortalSeen(portalId: string): Promise<void> {
  await updateRows('portals', { last_seen_at: new Date().toISOString() }, [
    { column: 'portal_id', operator: 'eq', value: portalId },
  ]).catch(() => undefined)
}

/** Clear the cache. Used by tests and after a portal binding changes. */
export function clearPortalCache(): void {
  cache.clear()
}
