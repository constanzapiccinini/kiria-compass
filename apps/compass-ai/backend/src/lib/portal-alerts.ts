/**
 * Alerts about portal state — §6A.4, the half that lives in this app.
 *
 * The reconcile runs in the **admin** app: it reads FuseBase and writes
 * `portals.status`, `missing_since` and a row in `portal_reconcile_runs`. The alert
 * engine — dedupe key, compare-and-set counter, 30-minute notification throttle,
 * email delivery, delivery retry — lives **here**, and backends are not shared on
 * this platform.
 *
 * So the responsibility is split along the line that already exists: the admin
 * decides state, and this app's worker notices state and raises. That is exactly what
 * it already does for failed jobs, stuck batches and exhausted budgets, and it avoids
 * a second copy of ~500 lines of the most carefully tuned code in the project.
 *
 * It also makes the alert durable rather than incidental. If the worker is down when
 * a reconcile marks a portal missing, the row is still `missing` on the next sweep and
 * the alert is raised then — where a fire-and-forget call from the admin would simply
 * have been lost.
 *
 * Both directions are handled: a portal that comes back resolves its own alert, which
 * is the path that proves the reconcile's caution about never deleting was worth
 * having.
 */

import { raiseAlert, resolveAlerts } from './alerts.js'
import { orgId } from './config.js'
import { logStep } from './observability.js'
import { query, readOptionalString, readString } from './store.js'

export interface PortalAlertSweep {
  missing: number
  restored: number
  reconcileFailed: boolean
}

/**
 * Raise and resolve the portal-state alerts.
 *
 * Safe to call on every worker tick: `raiseAlert` dedupes on
 * `(code, clientId, portalRowId, …)` and throttles notifications to one per 30
 * minutes, so a portal that stays missing produces one alert with a rising
 * occurrence count rather than a new one every sweep.
 *
 * Never throws — it runs inside the drain loop, and a failure to report a problem
 * must not stop the queue from being drained.
 */
export async function sweepPortalAlerts(): Promise<PortalAlertSweep> {
  const sweep: PortalAlertSweep = { missing: 0, restored: 0, reconcileFailed: false }

  try {
    // --- portals FuseBase no longer lists ---------------------------------
    const missing = await query(
      `SELECT p.id, p.portal_id, p.label, p.client_id, p.missing_since
         FROM portals p
        WHERE p.org_id = $1 AND p.status = 'missing'`,
      [orgId()],
    )

    for (const row of missing) {
      const label = readString(row, 'label')
      const portalId = readString(row, 'portal_id')
      await raiseAlert({
        code: 'PORTAL_MISSING',
        clientId: readString(row, 'client_id'),
        portalRowId: readString(row, 'id'),
        dedupeExtra: portalId,
        cause:
          `FuseBase no longer lists portal "${label}" (${portalId}). It stopped ` +
          `serving its viewers when the reconcile noticed, on ` +
          `${readOptionalString(row, 'missing_since') ?? 'an unknown date'}. Nothing ` +
          `has been deleted.`,
        metadata: {
          portalId,
          label,
          missingSince: readOptionalString(row, 'missing_since'),
        },
      })
      sweep.missing += 1
    }

    // --- portals that came back ---------------------------------------------
    //
    // Resolved by the absence of the condition rather than by an event, so a restore
    // that happened while this worker was down is still picked up.
    const active = await query(
      `SELECT p.id, p.portal_id, p.label, p.client_id
         FROM portals p
        WHERE p.org_id = $1 AND p.status <> 'missing' AND p.missing_since IS NULL`,
      [orgId()],
    )

    for (const row of active) {
      // Every field the raise used, because `resolveAlerts` recomputes the dedupe
      // key from its arguments — `sha256(code|clientId|portalRowId|sourceId|documentId|
      // dedupeExtra)`. Passing a subset produces a different key and silently
      // resolves nothing, which would leave a portal that came back looking broken
      // forever.
      const resolved = await resolveAlerts({
        code: 'PORTAL_MISSING',
        clientId: readString(row, 'client_id'),
        portalRowId: readString(row, 'id'),
        dedupeExtra: readString(row, 'portal_id'),
      })
      if (resolved > 0) {
        sweep.restored += resolved
        logStep('portal.missing_alert_resolved', {
          portalId: readString(row, 'portal_id'),
          label: readString(row, 'label'),
        })
      }
    }

    // --- a reconcile that could not read the platform ------------------------
    //
    // Only the most recent run matters: an older failure followed by a success is
    // not a current problem, and alerting on history would keep an inbox permanently
    // red for something already fixed.
    const latest = await query(
      `SELECT ok, error, started_at, triggered_by
         FROM portal_reconcile_runs
        WHERE org_id = $1
        ORDER BY started_at DESC
        LIMIT 1`,
      [orgId()],
    )
    const run = latest[0]

    if (run && run.ok !== true) {
      sweep.reconcileFailed = true
      await raiseAlert({
        code: 'PORTAL_RECONCILE_FAILED',
        cause:
          `The portal reconcile could not read FuseBase, so nothing was changed and ` +
          `the portal list is the previous state. Last attempt ` +
          `${readString(run, 'started_at')} (${readString(run, 'triggered_by')}): ` +
          `${readOptionalString(run, 'error') ?? 'no detail'}`,
        metadata: {
          startedAt: readString(run, 'started_at'),
          triggeredBy: readString(run, 'triggered_by'),
          error: readOptionalString(run, 'error'),
        },
      })
    } else if (run) {
      // The latest run succeeded, so whatever was wrong is not wrong now.
      await resolveAlerts({ code: 'PORTAL_RECONCILE_FAILED' })
    }
  } catch (error) {
    // Same rule as `raiseAlert` itself: reporting a problem must never create one.
    console.error('[portal-alerts] sweep failed', error)
  }

  return sweep
}
