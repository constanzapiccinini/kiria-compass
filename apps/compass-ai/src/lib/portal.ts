/**
 * Portal embed context, browser side.
 *
 * The platform passes a signed context token in the iframe URL. It is read from
 * `window.location.search` once, held in memory, and sent on every backend call as
 * `x-portal-context`.
 *
 * Deliberately NOT persisted to localStorage or sessionStorage: it is a portal
 * artifact shared by every viewer of the page, so a copy left in storage outlives
 * the session that legitimately received it. Reading it once at load also means a
 * later navigation cannot swap the app into a different portal's context.
 */

const QUERY_KEY = 'portalFeatureContextToken'

let portalToken: string | null = null
let captured = false

/**
 * Read one parameter out of a raw query string.
 *
 * Deliberately not `URLSearchParams`, which applies HTML form-encoding semantics
 * and decodes `+` as a space. A JWT is base64url and so unaffected, but an opaque
 * base64 token is not: a single `+` would arrive silently mangled and Gate would
 * reject it as invalid with nothing to distinguish it from a forged token. Percent
 * decoding is still applied, because the platform does percent-encode the value.
 */
function readRawQueryParam(search: string, key: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search

  for (const pair of query.split('&')) {
    if (pair.length === 0) continue

    const separator = pair.indexOf('=')
    const rawKey = separator === -1 ? pair : pair.slice(0, separator)
    if (decodeURIComponent(rawKey) !== key) continue

    const rawValue = separator === -1 ? '' : pair.slice(separator + 1)
    try {
      return decodeURIComponent(rawValue)
    } catch {
      // A malformed escape sequence: keep the literal text rather than dropping the
      // token, so the backend's rejection describes what actually arrived.
      return rawValue
    }
  }

  return null
}

/** Remove one parameter from a raw query string, leaving every other byte intact. */
function stripRawQueryParam(search: string, key: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search

  const kept = query
    .split('&')
    .filter((pair) => {
      if (pair.length === 0) return false
      const separator = pair.indexOf('=')
      const rawKey = separator === -1 ? pair : pair.slice(0, separator)
      try {
        return decodeURIComponent(rawKey) !== key
      } catch {
        return true
      }
    })
    .join('&')

  return kept.length > 0 ? `?${kept}` : ''
}

/**
 * Capture the token from the current URL. Safe to call more than once; only the
 * first call reads the URL.
 */
export function capturePortalToken(): string | null {
  if (captured) return portalToken
  captured = true

  try {
    const value = readRawQueryParam(window.location.search, QUERY_KEY)
    portalToken = value && value.trim().length > 0 ? value.trim() : null

    // Strip it from the visible URL once captured: it is not meaningful to a human,
    // and leaving it in the address bar invites copy-pasting a portal artifact into
    // a chat or a ticket. Other parameters are carried through byte for byte rather
    // than re-encoded, for the same reason the read above avoids URLSearchParams.
    if (portalToken && window.history.replaceState) {
      const remaining = stripRawQueryParam(window.location.search, QUERY_KEY)
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${remaining}${window.location.hash}`,
      )
    }
  } catch {
    portalToken = null
  }

  return portalToken
}

export function getPortalToken(): string | null {
  return captured ? portalToken : capturePortalToken()
}

/** True when the app was not opened through a portal embed. */
export function isMissingPortalContext(): boolean {
  return getPortalToken() === null
}

/** Headers for a backend call. Empty when there is no context to send. */
export function portalHeaders(): Record<string, string> {
  const token = getPortalToken()
  return token ? { 'x-portal-context': token } : {}
}
