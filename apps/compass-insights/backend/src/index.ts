/**
 * Compass Insights backend.
 *
 * A third app, and the smallest of the three by design. §5 states what it is for and,
 * more usefully, what it is not:
 *
 * > `compass-insights` therefore contains **no pipeline code at all** — it reads and
 * > it manages queues.
 *
 * The analysis itself — embedding, clustering, flagging, purging — runs in the client
 * app's worker, where the queue, the cron and the OpenAI client already live. That is
 * what keeps a third app from becoming a third copy of the helpers that have already
 * caused two production incidents here.
 *
 * The four helpers it does need are **copied verbatim** from Compass Admin and held to
 * that by `tests/drift.test.ts`, which compares them byte for byte. When a security
 * fix lands in one copy and not the other, that test says so on the next commit rather
 * than in an incident six months later.
 *
 * ## Three things this backend does not do
 *
 * - **No worker.** No `startWorker`, no drain loop. Jobs are the client app's.
 * - **No model calls.** Nothing here embeds or completes; the drift test fails the
 *   build if an import for either appears.
 * - **No portal context, ever.** Authorization is org role, checked per request
 *   against Gate — the same stance as the admin app. A portal token must not be a way
 *   in here, and unlike the admin app the consequence would be worse: these tables
 *   hold every client's questions.
 *
 * ## Why it is staff-only at the platform edge too
 *
 * `--access=orgRole:member` (§7), plus `requireAdmin` on every route, plus RLS
 * policies that refuse any request carrying `app.req_client_id`. Three independent
 * layers, because the thing behind them is the verbatim question text of every client
 * in the book.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { HttpError } from './lib/auth.js'
import { logStep } from './lib/observability.js'
import { stage } from './lib/config.js'
import { metricsRoutes } from './routes/metrics.js'
import { flagsRoutes } from './routes/flags.js'

const app = new Hono().basePath('/api')

/**
 * Health, unauthenticated by design.
 *
 * Reports nothing about the org or the store — a liveness probe must not become an
 * unauthenticated read of configuration.
 */
app.get('/health', (c) => c.json({ ok: true }))

app.route('/metrics', metricsRoutes)

// The review queue (§7 screen 5) — the one part of this app that writes. Mounted
// beside the metrics rather than under them because a decision is not a metric.
app.route('/flags', flagsRoutes)

/**
 * One error shape for every route: `{ error: { code, message } }`.
 *
 * Identical to the other two apps so one SPA error handler works against any of them,
 * and so tests assert on stable codes rather than prose.
 */
app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code ?? 'ERROR', message: error.message } }, error.status)
  }
  console.error('[insights] unhandled error', error)
  return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong' } }, 500)
})

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'No such route' } }, 404))

const port = Number(process.env.BACKEND_PORT) || 3001

serve({ fetch: app.fetch, port }, () => {
  logStep('insights.server_started', { port, stage: stage() })
})

export default app
