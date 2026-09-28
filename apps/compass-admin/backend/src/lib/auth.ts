/**
 * Errors and small shared guards.
 *
 * Deliberately does **not** export a "current user" helper. The copy of this file in
 * the client app has `requireUser`, which establishes only that the caller is
 * authenticated — useful there, dangerous here: an admin route wired to it would be
 * reachable by any signed-in FuseBase user, including a portal client.
 *
 * In this backend there is exactly one way to identify a caller — `requireAdmin` in
 * `admin-auth.ts` — so the weaker check cannot be reached for by accident.
 */

/** Machine-coded HTTP error, mapped to `{ error: { code, message } }` by the app. */
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
 * Shape check for a v4 UUID-ish id.
 *
 * Applied before an id reaches SQL. Postgres would reject a malformed uuid anyway,
 * but as a 500-shaped driver error rather than the 400 the caller deserves.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
