/**
 * HTTP errors and app-token reading.
 *
 * Authorization itself lives in `lib/portal.ts`. From Phase 4A there is no stored
 * role model: `Role`, `ROLE_RANK` and `requireWorkspaceRole` are gone, along with
 * self-service workspace creation. An actor is derived per request from the verified
 * portal context plus the caller's org role, so there is no membership table that
 * can drift out of step with the platform.
 */

import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { fusebaseHost } from './config.js'

export interface CurrentUser {
  userId: string
  email: string | null
}

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503
  /** Stable machine code, so clients and tests assert on codes rather than prose. */
  readonly code: string

  constructor(status: HttpError['status'], message: string, code = 'ERROR') {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/**
 * Read the caller's app token. The header is best-effort (the deployed platform
 * proxy may strip it); the same-origin `fbsfeaturetoken` cookie is the reliable
 * source.
 */
export function readAppToken(c: Context): string | null {
  return c.req.header('x-app-feature-token') ?? getCookie(c, 'fbsfeaturetoken') ?? null
}

interface UsersMeResponse {
  id?: unknown
  email?: unknown
}

/**
 * Resolve the current user from the app token.
 *
 * Identity only — it confers no access. Portal-scoped requests take identity from
 * the verified portal context instead, because that call also proves *where* the
 * caller is. This remains for the admin surface (Phase 4C), which has no portal.
 */
export async function fetchCurrentUser(appToken: string): Promise<CurrentUser | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(`https://app-api.${fusebaseHost()}/v4/api/users/me`, {
      headers: { 'x-app-feature-token': appToken },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) return null
    if (!response.ok) {
      throw new HttpError(
        503,
        `Could not resolve current user (upstream ${response.status})`,
        'IDENTITY_UNAVAILABLE',
      )
    }

    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null) return null
    const body = payload as UsersMeResponse
    const id = body.id
    if (typeof id !== 'string' && typeof id !== 'number') return null

    return {
      userId: String(id),
      email: typeof body.email === 'string' ? body.email : null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Require an authenticated user, or fail closed. */
export async function requireUser(c: Context): Promise<CurrentUser> {
  const appToken = readAppToken(c)
  if (!appToken) throw new HttpError(401, 'Missing app token', 'UNAUTHENTICATED')

  const user = await fetchCurrentUser(appToken)
  if (!user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED')
  return user
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
