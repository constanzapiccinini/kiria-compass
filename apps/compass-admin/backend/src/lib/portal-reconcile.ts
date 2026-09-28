/**
 * FuseBase is the source of truth for portals — §6A.4.
 *
 * A portal exists because it exists in FuseBase. This app's `portals` table is a
 * cache of that fact plus the tenancy it carries, and the reconcile is what keeps the
 * cache honest: names follow the platform, and a portal deleted there stops serving
 * here within one cycle.
 *
 * ---------------------------------------------------------------------------
 * The rule that matters most: a failed read changes nothing
 *
 * If `listPortals` errors, times out, or comes back empty, the reconcile **aborts
 * whole** and leaves every row exactly as it was. An empty list is indistinguishable
 * from "every portal was deleted", and acting on that reading would take every
 * client's documents away at once. A five-second outage, a permission change, a
 * renamed org and a genuine mass deletion all look identical from here, and only one
 * of them is worth acting on — so none of them are, automatically.
 *
 * ---------------------------------------------------------------------------
 * Two things the spec assumed that the platform does not offer
 *
 * §4.1.1 asks for every **page** of `listPortals`. There is no pagination: the
 * operation takes `orgId` and nothing else, and returns a flat `portals` array with no
 * cursor, offset or total (`tools_describe` on `listPortals`, confirmed against the
 * live schema). So there is no page two to miss. If pagination is ever added, this is
 * the one function that has to learn about it, and the guard below — abort on empty —
 * is what keeps a half-read list from looking like a deletion in the meantime.
 *
 * §4.1.3 says the **platform name** wins. `listPortals` returns no name at all, only
 * `domain`. So "the platform's name" is the domain's first label — `client-b-portal`
 * from `client-b-portal.p.nimbusweb.me` — which is what staff call these anyway. That
 * is the same derivation the Phase 5 discovery list already used.
 */

import { orgId, serviceGateAuth } from '../lib/config.js'
import { createPortalsApi } from '../lib/gate.js'
import { logStep, recordAudit } from '../lib/observability.js'
import { insertRow, query, queryOne, readNumber, readOptionalString, readString, updateRows } from '../lib/store.js'

/** How the reconcile was started, for attribution when a burst shows up. */
export type ReconcileTrigger = 'schedule' | 'screen' | 'button'

/** The screen load reconciles at most this often, so navigation does not hammer Gate. */
export const SCREEN_RECONCILE_INTERVAL_MS = 15 * 60 * 1000

export interface GatePortal {
  portalId: string
  domain: string | null
  workspaceId: string | null
}

/**
 * The platform list as the Portals screen consumes it: what was found, and whether
 * the finding is trustworthy. A non-null `error` means the list is empty because the
 * read failed, not because the org has no portals.
 */
export interface Discovery {
  portals: Map<string, GatePortal>
  error: string | null
}

export interface ReconcileOutcome {
  ok: boolean
  error: string | null
  portalsSeen: number
  renamed: Array<{ portalId: string; from: string; to: string }>
  markedMissing: Array<{ portalId: string; label: string }>
  restored: Array<{ portalId: string; label: string }>
  /** True when the run was skipped because a recent one already happened. */
  skipped: boolean
}

/**
 * The label a portal should carry, derived from the platform.
 *
 * Only the first label of the domain: `client-b-portal.p.nimbusweb.me` names the same
 * portal but reads like plumbing. Falls back to the portal id, which looks like a bug
 * when it shows — correctly, because it means the platform told us nothing usable.
 */
export function platformLabel(portal: GatePortal): string {
  const domain = portal.domain?.trim() ?? ''
  if (domain.length > 0) {
    const first = domain.split('.')[0]
    if (first && first.length > 0) return first.slice(0, 200)
    return domain.slice(0, 200)
  }
  return portal.portalId
}

/**
 * The label to show for a portal that may not be registered yet.
 *
 * Wraps `platformLabel` with the fallbacks the Portals list needs: a portal the
 * platform no longer lists has no domain to derive from, but a sighting may have
 * carried a label, and failing that the raw id is the honest answer.
 *
 * Lives here rather than in the route so there is one derivation of a portal's name.
 * There were briefly two — this module's and the route's — which is how "the platform
 * name wins" and "the stored label wins" ended up being decided in two places.
 */
export function displayLabel(
  portalId: string,
  gate: GatePortal | undefined,
  sightingLabel: string | null,
): string {
  if (gate) return platformLabel(gate)
  if (sightingLabel && sightingLabel.trim().length > 0) return sightingLabel.trim().slice(0, 200)
  return portalId
}

/** Narrow one `listPortals` entry without widening to `any`. */
function readGatePortal(value: unknown): GatePortal | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as { id?: unknown; domain?: unknown; workspaceId?: unknown }
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null
  return {
    portalId: entry.id,
    domain: typeof entry.domain === 'string' ? entry.domain : null,
    workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : null,
  }
}

/**
 * Read the platform's portal list.
 *
 * An empty list is returned as an **error**, not as an empty success, so the caller
 * cannot accidentally treat it as "there are no portals". That conflation is the one
 * this whole module is arranged to prevent.
 */
export async function readPlatformPortals(): Promise<
  { ok: true; portals: Map<string, GatePortal> } | { ok: false; error: string }
> {
  try {
    const api = createPortalsApi(serviceGateAuth())
    const response = await api.listPortals({ path: { orgId: orgId() } })
    const entries = Array.isArray(response.portals) ? response.portals : []

    const portals = new Map<string, GatePortal>()
    for (const entry of entries) {
      const portal = readGatePortal(entry)
      if (portal) portals.set(portal.portalId, portal)
    }

    if (portals.size === 0) {
      return {
        ok: false,
        error:
          'listPortals returned no portals. Treated as a failed read rather than as ' +
          'an empty organization: acting on it would mark every portal missing at once.',
      }
    }
    return { ok: true, portals }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'listPortals failed',
    }
  }
}

/** The most recent run, for "last reconciled" and for the skip window. */
export async function lastReconcileRun(): Promise<{
  startedAt: string
  ok: boolean
  error: string | null
} | null> {
  const row = await queryOne(
    `SELECT started_at, ok, error
       FROM portal_reconcile_runs
      WHERE org_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [orgId()],
  )
  if (!row) return null
  return {
    startedAt: readString(row, 'started_at'),
    ok: row.ok === true,
    error: readOptionalString(row, 'error'),
  }
}

/**
 * Reconcile this org's portals against FuseBase.
 *
 * Idempotent: a second run with the same platform state changes nothing and reports
 * empty lists. Safe to call on every screen load — `trigger: 'screen'` additionally
 * skips when a run happened inside `SCREEN_RECONCILE_INTERVAL_MS`, so navigating
 * between screens does not hammer Gate.
 */
export async function reconcilePortals(
  trigger: ReconcileTrigger,
  actorUserId: string | null,
  /**
   * A platform list the caller has already read.
   *
   * The Portals screen needs the same list to show discovered-but-unregistered
   * portals, so passing it in keeps a screen load to one Gate call instead of two.
   * Omit it and this reads its own.
   */
  prefetched?: { ok: true; portals: Map<string, GatePortal> } | { ok: false; error: string },
): Promise<ReconcileOutcome> {
  const empty: ReconcileOutcome = {
    ok: true,
    error: null,
    portalsSeen: 0,
    renamed: [],
    markedMissing: [],
    restored: [],
    skipped: false,
  }

  if (trigger === 'screen') {
    const last = await lastReconcileRun()
    if (last && Date.now() - new Date(last.startedAt).getTime() < SCREEN_RECONCILE_INTERVAL_MS) {
      return { ...empty, skipped: true }
    }
  }

  const platform = prefetched ?? (await readPlatformPortals())

  if (!platform.ok) {
    // Recorded before returning, because this row is what the client app's worker
    // reads to raise PORTAL_RECONCILE_FAILED — the alert engine lives over there.
    await insertRow(
      'portal_reconcile_runs',
      {
        org_id: orgId(),
        finished_at: new Date().toISOString(),
        ok: false,
        error: platform.error,
        triggered_by: trigger,
      },
      ['id'],
    ).catch(() => undefined)

    logStep('portal.reconcile_failed', { trigger, error: platform.error })
    return { ...empty, ok: false, error: platform.error }
  }

  const ours = await query(
    `SELECT id, portal_id, label, status, missing_since
       FROM portals
      WHERE org_id = $1`,
    [orgId()],
  )

  const renamed: ReconcileOutcome['renamed'] = []
  const markedMissing: ReconcileOutcome['markedMissing'] = []
  const restored: ReconcileOutcome['restored'] = []

  for (const row of ours) {
    const portalRowId = readString(row, 'id')
    const portalId = readString(row, 'portal_id')
    const label = readString(row, 'label')
    const status = readString(row, 'status')
    const missingSince = readOptionalString(row, 'missing_since')
    const onPlatform = platform.portals.get(portalId)

    if (!onPlatform) {
      // Already known missing: leave `missing_since` alone. Re-stamping it on every
      // cycle would reset the grace period forever and the Remove action would never
      // become available.
      if (status === 'missing') continue

      await updateRows(
        'portals',
        { status: 'missing', missing_since: new Date().toISOString() },
        [{ column: 'id', operator: 'eq', value: portalRowId }],
      )
      markedMissing.push({ portalId, label })

      await recordAudit({
        orgId: orgId(),
        actorUserId,
        action: 'portal.marked_missing',
        targetType: 'portal',
        targetId: portalRowId,
        metadata: { portalId, label, trigger, previousStatus: status },
      })
      continue
    }

    const updates: Record<string, unknown> = {}

    // Back from the dead. This is the path the caution above exists for, so it is
    // handled explicitly rather than left to "it will sort itself out".
    if (status === 'missing' || missingSince !== null) {
      updates.status = 'active'
      updates.missing_since = null
      restored.push({ portalId, label })
    }

    // The platform name wins, always (§4.1.3). There is no manual rename any more, so
    // these two can never disagree.
    const wanted = platformLabel(onPlatform)
    if (wanted !== label) {
      updates.label = wanted
      renamed.push({ portalId, from: label, to: wanted })
    }

    // Keep the workspace fresh: Gate membership calls need it, and a portal moved
    // between workspaces would otherwise resolve members against the old one.
    const workspaceId = onPlatform.workspaceId
    if (workspaceId && workspaceId !== readOptionalString(row, 'workspace_id')) {
      updates.workspace_id = workspaceId
    }

    if (Object.keys(updates).length > 0) {
      await updateRows('portals', updates, [
        { column: 'id', operator: 'eq', value: portalRowId },
      ])
    }

    if (restored.some((entry) => entry.portalId === portalId)) {
      await recordAudit({
        orgId: orgId(),
        actorUserId,
        action: 'portal.restored',
        targetType: 'portal',
        targetId: portalRowId,
        metadata: { portalId, label: wanted, trigger },
      })
    }
  }

  await insertRow(
    'portal_reconcile_runs',
    {
      org_id: orgId(),
      finished_at: new Date().toISOString(),
      ok: true,
      portals_seen: platform.portals.size,
      renamed: renamed.length,
      marked_missing: markedMissing.length,
      restored: restored.length,
      triggered_by: trigger,
    },
    ['id'],
  ).catch(() => undefined)

  logStep('portal.reconciled', {
    trigger,
    portalsSeen: platform.portals.size,
    renamed: renamed.length,
    markedMissing: markedMissing.length,
    restored: restored.length,
  })

  return {
    ok: true,
    error: null,
    portalsSeen: platform.portals.size,
    renamed,
    markedMissing,
    restored,
    skipped: false,
  }
}

/**
 * How long a portal must have been missing before it can be removed.
 *
 * Read from `app_settings.defaults.portalRemovalGraceDays` when set, so it is
 * configurable without a deploy (§4.2), and 7 days otherwise.
 */
export async function removalGraceDays(): Promise<number> {
  const row = await queryOne('SELECT defaults FROM app_settings WHERE org_id = $1', [orgId()])
  const raw = row?.defaults
  const defaults =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const configured = defaults.portalRemovalGraceDays
  if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 0) {
    return configured
  }
  return 7
}

/** Days a portal has been missing, or null when it is not missing. */
export function missingForDays(missingSince: string | null): number | null {
  if (!missingSince) return null
  const since = new Date(missingSince).getTime()
  if (Number.isNaN(since)) return null
  return Math.floor((Date.now() - since) / (24 * 60 * 60 * 1000))
}

/** Count of rows a permanent removal would destroy, for the confirmation text. */
export async function removalImpact(portalRowId: string): Promise<{
  clientId: string
  label: string
  chats: number
  documents: number
  privateLibraries: number
  sharedLibraries: number
}> {
  const portal = await queryOne(
    'SELECT client_id, label FROM portals WHERE id = $1 AND org_id = $2',
    [portalRowId, orgId()],
  )
  if (!portal) throw new Error(`portal ${portalRowId} not found`)
  const clientId = readString(portal, 'client_id')

  const counts = await queryOne(
    `SELECT
       (SELECT count(*) FROM chats WHERE client_id = $1) AS chats,
       (SELECT count(*) FROM documents d
          JOIN portal_source_bindings b ON b.source_id = d.library_id
          JOIN document_sources s ON s.id = d.library_id
         WHERE b.portal_row_id = $2 AND s.is_private IS TRUE AND d.deleted_at IS NULL)
         AS documents,
       (SELECT count(*) FROM document_sources s
          JOIN portal_source_bindings b ON b.source_id = s.id
         WHERE b.portal_row_id = $2 AND s.is_private IS TRUE) AS private_libraries,
       (SELECT count(*) FROM document_sources s
          JOIN portal_source_bindings b ON b.source_id = s.id
         WHERE b.portal_row_id = $2 AND s.is_private IS FALSE) AS shared_libraries`,
    [clientId, portalRowId],
  )

  return {
    clientId,
    label: readString(portal, 'label'),
    chats: counts ? readNumber(counts, 'chats') : 0,
    documents: counts ? readNumber(counts, 'documents') : 0,
    privateLibraries: counts ? readNumber(counts, 'private_libraries') : 0,
    sharedLibraries: counts ? readNumber(counts, 'shared_libraries') : 0,
  }
}
