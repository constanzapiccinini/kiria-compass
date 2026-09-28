/**
 * Compass Admin backend.
 *
 * A separate app from the client-facing Compass AI, on its own origin with its own
 * backend (§9). That separation is the point: no admin route is reachable from the
 * client app's origin, so a mistake in the client app's authorization cannot expose
 * an admin surface.
 *
 * Two things this backend deliberately does **not** do:
 *
 * - **It does not run the ingestion worker.** Jobs are written into the shared
 *   `ingest_jobs` table and the client app's worker executes them, so there is one
 *   implementation of the pipeline and one set of retry semantics.
 * - **It never accepts a portal context token.** Authorization is org role, checked
 *   per request against Gate. A portal token must not be a way in here.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { HttpError } from './lib/auth.js'
import { logStep } from './lib/observability.js'
import { stage } from './lib/config.js'
import { sessionRoutes } from './routes/session.js'
import { portalRoutes } from './routes/portals.js'
import { documentRoutes } from './routes/documents.js'
import { libraryRoutes } from './routes/libraries.js'
import { indexingRoutes } from './routes/indexing.js'
import { settingsRoutes } from './routes/settings.js'
import { operationsRoutes } from './routes/operations.js'

const app = new Hono().basePath('/api')

/**
 * Health, unauthenticated by design.
 *
 * Reports nothing about the org or the store — a liveness probe must not become an
 * unauthenticated read of configuration.
 */
app.get('/health', (c) => c.json({ ok: true }))

app.route('/session', sessionRoutes)
app.route('/portals', portalRoutes)
app.route('/documents', documentRoutes)
app.route('/libraries', libraryRoutes)
app.route('/indexing', indexingRoutes)
app.route('/settings', settingsRoutes)
app.route('/ops', operationsRoutes)

/**
 * One error shape for every route: `{ error: { code, message } }`.
 *
 * Matches the client app so a single SPA error handler works against either, and so
 * tests can assert on stable codes rather than prose.
 *
 * Unexpected errors are logged in full and answered with a generic message: an
 * admin is staff, but a stack trace in a response is still a way for internals to
 * end up in a screenshot or a ticket.
 */
app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code ?? 'ERROR', message: error.message } }, error.status)
  }
  console.error('[admin] unhandled error', error)
  return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong' } }, 500)
})

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'No such route' } }, 404))

const port = Number(process.env.BACKEND_PORT) || 3001

serve({ fetch: app.fetch, port }, () => {
  logStep('admin.server_started', { port, stage: stage() })
})

export default app
