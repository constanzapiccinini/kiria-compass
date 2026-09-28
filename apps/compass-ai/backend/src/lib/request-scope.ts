/**
 * Per-request tenancy scope, carried implicitly (§4.3 groundwork).
 *
 * ## Why this shape, and not the two typed functions
 *
 * The approved plan was to split the store layer into `clientQuery(ctx, …)` and
 * `workerQuery(…)`, with the compiler keeping them apart. Implementing it revealed the
 * cost: **150 call sites across 14 files**, every one needing a context argument
 * threaded to it. A mechanical edit that large is its own risk, and the failure mode is
 * the worst kind — one missed site silently keeps the unscoped path.
 *
 * This achieves the same two paths and enforces the split by **where the code runs**
 * rather than by which function was called:
 *
 *   - A request opens a scope. `resolvePortalContext` — already the single tenancy
 *     boundary every client-facing route goes through — writes the resolved client
 *     into it. Every store call made while handling that request then carries client
 *     scope automatically.
 *   - The worker runs outside any request, so there is no scope, and its store calls
 *     carry none. That is the unscoped path, and it needs no annotation because a
 *     background job cannot accidentally be inside a request.
 *
 * The honest trade-off against the typed version: the compiler cannot prove a given
 * call is scoped, so this is enforced at runtime and by structure instead. What it buys
 * is that **no call site can forget** — the 150 existing ones are scoped correctly
 * without being touched, which the typed version could only achieve by editing all of
 * them correctly.
 *
 * ## This is plumbing, not enforcement — yet
 *
 * `req_client_id` is attached to store calls, but **no policy consumes it**, so today
 * it changes nothing at runtime. It is landed separately and verified inert on purpose:
 * a policy and the context it depends on arriving in one deploy means a failure could
 * be either, and the symptom of getting it wrong is every read returning zero rows.
 *
 * `req_client_id` is a custom key because the reserved ones (`org_id`, `client_id`,
 * `portal_id`, `user_id`, `rls_admin`, …) cannot be supplied through caller-controlled
 * `rlsContext` at all — Gate refuses them, by design, since a caller could otherwise
 * forge its own tenancy. The platform's blessed alternative,
 * `trustedRuntimeContext.portalId`, needs `isolated_store.rls.delegate`, which this app
 * does not hold. The platform documentation is explicit that a custom key like this is
 * a reviewed temporary fallback, and that is exactly what it is here.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestScope {
  /**
   * The client this request resolved to, or null before resolution.
   *
   * Mutable because the scope is opened by middleware before anything is known, and
   * filled in by `resolvePortalContext` once the portal token has been verified. The
   * alternative — opening the scope after resolution — would leave the resolution's own
   * queries outside it, which is where a tenancy mistake would matter most.
   */
  clientId: string | null
}

const storage = new AsyncLocalStorage<RequestScope>()

/** Run `fn` inside a fresh request scope. Called once per request, by middleware. */
export function withRequestScope<T>(fn: () => T): T {
  return storage.run({ clientId: null }, fn)
}

/**
 * Record the resolved client for the remainder of this request.
 *
 * A no-op outside a request scope, so calling it from a worker path is harmless
 * rather than a crash.
 */
export function setRequestClient(clientId: string): void {
  const scope = storage.getStore()
  if (scope) scope.clientId = clientId
}

/**
 * The client scope in effect, or null.
 *
 * Null means one of two legitimate things — a background job, or a request that has
 * not resolved its portal yet — and store calls treat both the same way: no client
 * context on the wire.
 */
export function currentClientId(): string | null {
  return storage.getStore()?.clientId ?? null
}
