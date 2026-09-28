/**
 * Who is asking, and what the admin shell needs to render itself.
 *
 * The SPA calls this first. It is also the cheapest possible probe of whether the
 * caller is staff at all, so a client who reaches this origin gets a clean 403 here
 * rather than a wall of failing screens.
 */

import { Hono } from 'hono'
import { requireAdmin } from '../lib/admin-auth.js'
import { orgId } from '../lib/config.js'
import { query, readNumber, readOptionalString, readString } from '../lib/store.js'

export const sessionRoutes = new Hono()

sessionRoutes.get('/', async (c) => {
  const actor = await requireAdmin(c)

  // Counts for the shell's navigation badges. One statement rather than four
  // round trips, so the header cannot show numbers from four different moments.
  const rows = await query(
    `SELECT
       (SELECT count(*) FROM clients WHERE status <> 'archived') AS clients,
       (SELECT count(*) FROM portals WHERE status = 'active') AS portals,
       (SELECT count(*) FROM system_alerts WHERE status = 'new') AS open_alerts,
       (SELECT defaults ->> 'alertsPaused' FROM app_settings WHERE org_id = current_setting('app.org_id', true)) AS alerts_paused`,
  )

  const counts = rows[0]
  return c.json({
    actor,
    counts: {
      clients: counts ? readNumber(counts, 'clients') : 0,
      portals: counts ? readNumber(counts, 'portals') : 0,
      openAlerts: counts ? readNumber(counts, 'open_alerts') : 0,
    },
    // Kept out of `counts`: it is not a count, and the rail needs it to decide
    // whether to badge the real number rather than to replace it.
    alertsPaused: counts ? readOptionalString(counts, 'alerts_paused') === 'true' : false,
  })
})

/**
 * Every portal, for the picker that scopes the rest of the app (§5A.5).
 *
 * Replaces `GET /session/clients`. Revision 2 of the phase spec removed the client
 * from the interface: **one portal is one client**, so a client picker was a picker
 * over a thing staff never create and never name. The `clients` row is still the
 * tenancy key every table and RLS policy is built on, which is why `clientId` comes
 * back on each entry — the screens below are per-tenant and always were. What
 * changed is that nobody has to know that.
 *
 * Kept on the session router rather than under /portals because the picker is part
 * of the shell: it loads once, before any screen has chosen a portal.
 */
sessionRoutes.get('/portals', async (c) => {
  await requireAdmin(c)

  const rows = await query(
    `SELECT p.id, p.portal_id, p.label, p.status, p.last_seen_at,
            c.id AS client_id, c.status AS client_status,
            (SELECT count(*) FROM documents d
              WHERE d.client_id = c.id AND d.deleted_at IS NULL) AS document_count
       FROM portals p
       JOIN clients c ON c.id = p.client_id
      WHERE p.org_id = $1
      ORDER BY p.label`,
    [orgId()],
  )

  return c.json({
    portals: rows.map((row) => ({
      id: readString(row, 'id'),
      portalId: readString(row, 'portal_id'),
      label: readString(row, 'label'),
      status: readString(row, 'status'),
      lastSeenAt: readOptionalString(row, 'last_seen_at'),
      // The tenancy key the per-portal screens read. Not shown anywhere.
      clientId: readString(row, 'client_id'),
      clientStatus: readString(row, 'client_status'),
      documentCount: readNumber(row, 'document_count'),
    })),
  })
})
