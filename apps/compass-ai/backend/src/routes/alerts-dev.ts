/**
 * Raise any alert code on demand — **non-production only** (§5D.4).
 *
 * Seven of the twelve alert codes had never been exercised: the conditions that
 * trigger them are a failing OCR provider, an expired OpenAI batch, an exhausted
 * token budget, a portal nobody has bound. Waiting for those to happen naturally is
 * how a broken alert path is discovered during the incident it was supposed to warn
 * about — the throttle, the dedupe counter and the email delivery all have to work
 * the *first* time they matter.
 *
 * So this raises a real alert through the real `raiseAlert`: the same dedupe key, the
 * same compare-and-set counter, the same 30-minute notification throttle, the same
 * email delivery. Nothing is stubbed. What is being tested is the path, so the path
 * has to be the actual one.
 *
 * ---------------------------------------------------------------------------
 * Why it cannot exist in production
 *
 * An alert email carries internal detail — table names, source names, tenant names —
 * and an alert in the inbox is something a person acts on. A route that manufactures
 * one is a route that can waste an on-call hour, and in the wrong hands a way to
 * bury a real alert under noise.
 *
 * **The guard is structural, not conditional.** `registerDevAlertRoutes` is called
 * only when `stage()` is not `prod`, so in a deployed app the handler is never
 * registered and the path 404s at the router — there is no code to reach and no
 * runtime check to get wrong. A guard written as an `if` inside the handler would
 * still be one edited line away from live; this is one that cannot be. The e2e suite
 * asserts the 404 against production rather than trusting this comment, because a
 * comment is not an assertion.
 *
 * `requireEmployee` is kept on top of that as defence in depth: on a dev machine the
 * route does exist, and it should still not answer a client.
 */

import { Hono } from 'hono'
import { HttpError } from '../lib/auth.js'
import { stage } from '../lib/config.js'
import { requireEmployee, resolvePortalContext } from '../lib/portal.js'
import { raiseAlert, type AlertCode } from '../lib/alerts.js'
import { logStep } from '../lib/observability.js'

/** Every code the registry defines, so a typo is a 400 that lists the valid ones. */
const CODES: readonly AlertCode[] = [
  'PORTAL_NOT_BOUND',
  'PORTAL_NO_SOURCE',
  'SOURCE_SYNC_FAILED',
  'SOURCE_CONFIG_INVALID',
  'DOC_OCR_FAILED',
  'DOC_EMBED_FAILED',
  'BATCH_EXPIRED',
  'OCR_BUDGET_REACHED',
  'TOKEN_BUDGET_REACHED',
  'LLM_TIMEOUT_REPEATED',
  'STORE_UNAVAILABLE',
  'TENANCY_PROBE',
]

function isAlertCode(value: unknown): value is AlertCode {
  return typeof value === 'string' && (CODES as readonly string[]).includes(value)
}

const devAlertRoutes = new Hono()

devAlertRoutes.post('/test', async (c) => {
  const context = await resolvePortalContext(c)
  requireEmployee(context)

  const body: unknown = await c.req.json().catch(() => null)
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : null

  if (!isAlertCode(code)) {
    throw new HttpError(
      400,
      `code must be one of: ${CODES.join(', ')}`,
      'UNKNOWN_ALERT_CODE',
    )
  }

  // Scoped to the caller's own tenant, and labelled in the cause. An operator who
  // finds this in the inbox tomorrow should be able to tell instantly that a test
  // put it there, without having to check the timestamp against a deploy log.
  const alertId = await raiseAlert({
    code,
    clientId: context.clientId,
    cause:
      `TEST ALERT raised deliberately from the ${stage()} environment by ` +
      `${context.email ?? context.userId} to exercise the ${code} path. ` +
      'Nothing is actually wrong.',
    remediationDetail: 'This alert was manufactured by a test. Resolve it and ignore it.',
    metadata: { test: true, raisedBy: context.userId, stage: stage() },
  })

  logStep('alert.test_raised', { code, alertId, userId: context.userId })

  // `raiseAlert` never throws and returns null when even recording failed, which is
  // itself the finding this route exists to surface — so it is reported rather than
  // flattened into a 200.
  return c.json({ code, alertId, recorded: alertId !== null }, alertId ? 201 : 500)
})

/**
 * Mount the dev-only alert routes, or don't.
 *
 * Returns whether they were mounted so startup can log it: a route that silently
 * does or does not exist depending on an environment variable is worth one line in
 * the boot output.
 */
export function registerDevAlertRoutes(app: Hono): boolean {
  if (stage() === 'prod') return false
  app.route('/alerts', devAlertRoutes)
  return true
}
