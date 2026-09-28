/**
 * Compass AI backend.
 *
 * The SPA talks only to this backend; the backend owns every isolated-store and
 * OpenAI/Textract call. That keeps the OpenAI key server-side and lets one place
 * enforce workspace roles and cost caps.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { raiseAlert } from './lib/alerts.js'
import { HttpError } from './lib/auth.js'
import { PortalError } from './lib/portal.js'
import { isOcrConfigured, isOpenAiConfigured, stage } from './lib/config.js'
import { drainOnce, reclaimStaleJobs, requeueOrphanedBatches, startWorker } from './lib/ingest.js'
import { logStep } from './lib/observability.js'
import { withRequestScope } from './lib/request-scope.js'
import { queryOne, readOptionalString, resolveStore } from './lib/store.js'
import { chatRoutes } from './routes/chat.js'
import { documentRoutes } from './routes/documents.js'
import { folderRoutes } from './routes/folders.js'
import { sessionRoutes } from './routes/session.js'
import { registerDevAlertRoutes } from './routes/alerts-dev.js'

const app = new Hono().basePath('/api')

/**
 * Open a tenancy scope for the whole request (§4.3).
 *
 * First middleware, before any route: `resolvePortalContext` fills the scope in once
 * it has verified the portal token, and every store call made while handling the
 * request then carries that client automatically. Opening it here rather than at
 * resolution time means the resolution's own queries are inside the scope too, which
 * is where a tenancy mistake would matter most.
 *
 * A background job runs outside any request, so it gets no scope — that is the
 * unscoped path, and it needs no annotation because a worker cannot accidentally find
 * itself inside a request.
 */
app.use('*', (c, next) => withRequestScope(() => next()))

app.get('/health', (c) => c.json({ ok: true }))

/**
 * Readiness detail for operators: confirms the backend can actually reach the store
 * and reports whether OCR is wired up. Kept `private` in openapi.json.
 */
app.get('/health/detail', async (c) => {
  try {
    const store = await resolveStore()
    return c.json({
      ok: true,
      stage: store.stage,
      storeReachable: true,
      ocrConfigured: isOcrConfigured(),
      openAiConfigured: isOpenAiConfigured(),
      // Which RLS settings Gate injects for THIS token (§4.3 groundwork).
      //
      // Reported here because it cannot be established any other way: the
      // operator token used by scripts gets a different injection than the app's
      // own service token, and enabling RLS on a policy keyed to a setting the
      // backend does not actually carry turns every read into zero rows — a total
      // outage. So it is measured through the real token before any policy is
      // written. Values, not just presence, because a policy compares them.
      rlsSettings: await injectedRlsSettings(),
    })
  } catch (error) {
    return c.json(
      {
        ok: false,
        stage: stage(),
        storeReachable: false,
        ocrConfigured: isOcrConfigured(),
        openAiConfigured: isOpenAiConfigured(),
        error: error instanceof Error ? error.message : String(error),
      },
      503,
    )
  }
})

/**
 * Read the `app.*` settings Gate sets on this backend's transactions.
 *
 * `current_setting(name, true)` returns NULL rather than erroring for an unset
 * setting, so one statement can probe them all. Best-effort: a diagnostic must not
 * be the reason a health check reports unhealthy.
 */
async function injectedRlsSettings(): Promise<Record<string, string | null> | string> {
  try {
    const row = await queryOne(
      `SELECT current_setting('app.org_id', true)    AS org_id,
              current_setting('app.client_id', true) AS client_id,
              current_setting('app.user_id', true)   AS user_id,
              current_setting('app.auth_type', true) AS auth_type,
              current_setting('app.portal_id', true) AS portal_id,
              current_setting('app.rls_admin', true) AS rls_admin`,
    )
    if (!row) return 'no row returned'
    return {
      org_id: readOptionalString(row, 'org_id'),
      client_id: readOptionalString(row, 'client_id'),
      user_id: readOptionalString(row, 'user_id'),
      auth_type: readOptionalString(row, 'auth_type'),
      portal_id: readOptionalString(row, 'portal_id'),
      rls_admin: readOptionalString(row, 'rls_admin'),
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

app.route('/session', sessionRoutes)
app.route('/documents', documentRoutes)
app.route('/chats', chatRoutes)
app.route('/folders', folderRoutes)

// Non-production only, and structurally so: the handler is never registered in a
// deployed app, so `POST /api/alerts/test` 404s at the router rather than relying on
// a runtime check somebody could edit (§5D.4).
const devAlertsMounted = registerDevAlertRoutes(app)
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    step: 'boot.dev_alert_routes',
    mounted: devAlertsMounted,
  }),
)

/**
 * Drain the ingest queue on demand.
 *
 * Under `/api/webhooks/` so the platform proxy lets a scheduled caller through
 * without an app token; it is a safety net for jobs left behind when a replica is
 * recycled mid-run, and is idempotent.
 */
app.post('/webhooks/ingest-drain-8fbc21d7a4e35b90', async (c) => {
  // Rescue batches whose poll job was lost with a recycled replica first, so their
  // polls are in the queue this drain will process.
  const reclaimed = await reclaimStaleJobs()
  const orphanedBatchPolls = await requeueOrphanedBatches()
  let processed = 0
  while (processed < 25 && (await drainOnce())) processed += 1
  return c.json({ processed, reclaimed, orphanedBatchPolls })
})

/** Single error boundary: HttpError carries its own status, everything else is a 500. */
/**
 * Single error boundary.
 *
 * Every failure carries a stable machine `code`, so clients and the e2e suite branch
 * on codes rather than prose. A `PortalError` also carries a separately-authored
 * client-safe message: clients never see table names, ids, provider names or stack
 * traces — the detail goes to the log and, for named failures, to `system_alerts`.
 */
app.onError((error, c) => {
  if (error instanceof PortalError) {
    // Log the real reason; return only what is safe to show.
    console.error('[portal]', error.code, error.message)
    return c.json({ error: { code: error.code, message: error.clientMessage } }, error.status)
  }
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status)
  }
  console.error('[unhandled]', error)

  // A store outage is the one unhandled failure worth a named alert: it takes the
  // whole app down rather than one feature, and the remediation is different from
  // any application bug.
  //
  // Being straight about a real limitation: `raiseAlert` writes to that same store,
  // so while it is completely unreachable the row cannot land and the `console.error`
  // inside `raiseAlert` is the only trace. It is still attempted, because the
  // outages that actually happen are partial or brief — a Gate blip, one statement
  // class failing, a store that returns seconds later — and in those the row does
  // land. This is not a substitute for external uptime monitoring.
  if (isStoreFailure(error)) {
    void raiseAlert({
      code: 'STORE_UNAVAILABLE',
      cause:
        `A request failed because the isolated store could not be reached: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      metadata: { path: new URL(c.req.url).pathname, method: c.req.method },
    })
  }

  return c.json(
    { error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } },
    500,
  )
})

/**
 * Whether a failure came from the store rather than from application logic.
 *
 * Matched on message text, which is imprecise by nature — the Gate SDK throws plain
 * errors for transport failures, so there is no type to test. Kept deliberately
 * narrow: a false positive raises a critical alert about the wrong thing, which is
 * worse than missing one, since the log line is written either way.
 */
function isStoreFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('isolatedstore') ||
    message.includes('isolated store') ||
    message.includes('queryisolatedstoresql') ||
    message.includes('econnrefused') ||
    message.includes('fetch failed')
  )
}

app.notFound((c) => c.json({ error: 'Not found' }, 404))

const port = Number(process.env.BACKEND_PORT) || 3001

serve({ fetch: app.fetch, port }, () => {
  logStep('server.started', { port, stage: stage(), ocrConfigured: isOcrConfigured() })
  // Ingestion runs in-process; a warm replica (backend.minReplicas: 1) keeps the
  // queue moving between requests.
  startWorker()
})

export default app
