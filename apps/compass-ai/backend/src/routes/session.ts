/**
 * The session bootstrap — the only route this app needs to render itself.
 *
 * Everything is derived from the verified portal context: a request arrives from
 * exactly one portal, that portal is exactly one tenant, and the caller is either
 * KIRIA staff or that tenant's user. There is no list to choose from and nothing
 * to switch between.
 *
 * §5C removed the settings and audit routes that used to live here. This app
 * configures nothing for anyone now — Compass Admin owns settings, usage and the
 * audit trail — so the only thing left to send is what the shell needs to draw.
 */

import { Hono } from 'hono'
import { HttpError } from '../lib/auth.js'
import { assertNoTenantOverride, resolvePortalContext } from '../lib/portal.js'
import { resolveEffectiveSettings } from '../lib/settings.js'

export const sessionRoutes = new Hono()

/**
 * What this actor may do — three things, true for everyone (§5C).
 *
 * This app is view + chat only now, for staff as well as clients. The nine
 * employee-gated capabilities that used to live here are gone with the surfaces they
 * drew: upload, delete, re-index, folder management, settings, indexing, usage and
 * the audit log all belong to Compass Admin, and having two code paths for the same
 * job is what let one of them 500 in production for an hour unnoticed.
 *
 * Kept as a field rather than deleted outright: the SPA reads it as the shape of the
 * contract, and a future read-only affordance (export, print) belongs here.
 */
const CAPABILITIES = { viewDocuments: true, chat: true, exportAnswers: true } as const

sessionRoutes.get('/', async (c) => {
  const probe = assertNoTenantOverride(c)
  if (probe) {
    throw new HttpError(400, `Request carried a tenant identifier "${probe}"`, 'TENANCY_PROBE')
  }

  const context = await resolvePortalContext(c)
  const settings = await resolveEffectiveSettings(context.clientId, context.portalId)

  return c.json({
    // Identity, not permission. Audit rows need it, and the SPA keys the
    // "manage this in Compass Admin" ribbon off it.
    actor: context.actor,
    user: { id: context.userId, email: context.email },
    portalId: context.portalId,
    client: { id: context.clientId, name: context.clientName },
    capabilities: CAPABILITIES,
    // The three values that shape the experience, and no provenance — for staff as
    // well as clients now. Where a value was set is a question for the admin app,
    // which is the only place it can be changed.
    settings: {
      retrievalMode: settings.retrievalMode,
      maxAnswerTokens: settings.maxAnswerTokens,
      maxRetrievedTokens: settings.maxRetrievedTokens,
    },
  })
})
