/**
 * Portals — §5A, screen 1.
 *
 * **In the interface there is one entity: the portal.** A portal is a client. There
 * is no client picker, no client list, and no "assign this portal to…" — that step,
 * which revision 1 of the phase spec asked for and this app shipped, is gone. One
 * client = one portal, and that relationship is already managed in FuseBase
 * workspaces; asking staff to restate it here was a way to get it wrong.
 *
 * In the database `clients` is unchanged: one row per portal, created automatically,
 * never edited by hand, never shown. It is the tenancy key `documents.client_id`,
 * `app.req_client_id` and twenty-odd proven RLS policies are built on, and renaming
 * it across every table, view and policy would be a week of mechanical risk to
 * change a word nobody outside the code reads.
 *
 * What was deleted here, and why each one had to go:
 *
 *   - `PUT /:portalRowId/client` — rebinding a portal to a different client is
 *     meaningless when the portal *is* the client.
 *   - `POST /clients`, `PUT /clients/:clientId/status` — staff no longer create or
 *     archive clients; provisioning does, and pausing the portal is the off switch.
 *   - the group routes — a library now ticks portals directly (§5B), which is what a
 *     group was for. The tables stay in the schema, unread; deciding their fate is
 *     §5D.
 *   - `PATCH /:portalRowId` — the manual rename. FuseBase is the source of truth for
 *     portal names now (§6A.4), so a hand-typed label would be overwritten by the
 *     next reconcile, and an edit that silently reverts is worse than no edit.
 *   - `DELETE /:portalRowId` — the "Disconnect" action. Under this model deleting
 *     the row would strand its tenant: the client, its documents and its chats would
 *     survive with no portal resolving to them, which is precisely the invisible
 *     -documents failure this phase exists to end. **Pause is the off switch**, and
 *     it is reversible.
 *
 * Every handler calls `requireAdmin` directly rather than trusting a middleware
 * someone might forget to apply to a new route.
 */

import { Hono } from 'hono'
import { orgId } from '../lib/config.js'
import { HttpError, isUuid } from '../lib/auth.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { recordAudit } from '../lib/observability.js'
import { ensurePortalTenant } from '../lib/portal-tenant.js'
import {
  displayLabel,
  lastReconcileRun,
  type Discovery,
  missingForDays,
  readPlatformPortals,
  reconcilePortals,
  removalGraceDays,
  removalImpact,
} from '../lib/portal-reconcile.js'
import {
  deleteRows,
  query,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  updateRows,
} from '../lib/store.js'

export const portalRoutes = new Hono()

async function readJsonBody(c: Parameters<typeof requireAdmin>[0]): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  return body as Record<string, unknown>
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) throw new HttpError(400, `${label} must be a UUID`, 'BAD_REQUEST')
  return value
}

// ---------------------------------------------------------------------------
// screen 1 — portals
// ---------------------------------------------------------------------------

interface PortalListEntry {
  portalId: string
  name: string
  url: string | null
  workspaceId: string | null
  /** True once a tenant exists for it. Registered portals serve visitors. */
  registered: boolean
  /** Set when registered. */
  id?: string
  label?: string
  status?: string
  lastSeenAt?: string | null
  clientId?: string
  documentsVisible?: number
  bindingCount?: number
  /** The libraries this portal receives, by name. */
  libraries?: Array<{ id: string; name: string }>
  /** True when Gate no longer lists it: the portal was deleted in FuseBase. */
  missingFromPlatform?: boolean
  /** When the reconcile first failed to find it on the platform (§6A.4). */
  missingSince?: string | null
  missingForDays?: number | null
  /**
   * Whether the grace period has elapsed and the portal may be removed permanently.
   *
   * Decided on the server: the grace period is configurable, and a screen that
   * computed it could offer a destructive action the API would refuse — or, worse,
   * one it would accept a day early.
   */
  removable?: boolean
  /** Set when unregistered and someone has already been turned away. */
  firstSeenAt?: string
  seenCount?: number
}

/**
 * Every portal, registered or not, merged from three sources on the portal id:
 *
 *   1. **Gate `listPortals`** — the platform's own list, the authority on what exists.
 *   2. **our `portals` table** — what has a tenant.
 *   3. **`portal_registrations`** — portals seen by a visitor, which is the fallback
 *      that still works when discovery does not.
 *
 * `lastSeenAt` is the most useful column on the screen: a portal registered but
 * never opened is the commonest "why doesn't it work", and invisible without it.
 */
portalRoutes.get('/', async (c) => {
  const actor = await requireAdmin(c)

  // One platform read, used for both jobs: reconciling what we already have, and
  // listing what the platform has that we do not.
  const platform = await readPlatformPortals()
  const discovery: Discovery = platform.ok
    ? { portals: platform.portals, error: null }
    : { portals: new Map(), error: platform.error }

  // Reconciled on every screen load (§4.1), throttled to one run per interval so
  // moving between screens does not hammer Gate. A failed read changes nothing.
  const reconcile = await reconcilePortals('screen', actor.userId, platform)

  const byId = new Map<string, PortalListEntry>();

  for (const [portalId, gate] of discovery.portals) {
    byId.set(portalId, {
      portalId,
      name: displayLabel(portalId, gate, null),
      url: gate.domain ? `https://${gate.domain}` : null,
      workspaceId: gate.workspaceId,
      registered: false,
    })
  }

  // Policy lives on the server: whether Remove is offered is not the screen's call.
  const graceDays = await removalGraceDays()

  const registered = await query(
    `SELECT p.id, p.portal_id, p.workspace_id, p.label, p.status, p.last_seen_at,
            p.missing_since,
            c.id AS client_id,
            (SELECT count(*) FROM portal_source_bindings b WHERE b.portal_row_id = p.id)
              AS binding_count,
            (SELECT count(*) FROM portal_visible_documents v WHERE v.portal_id = p.portal_id)
              AS visible_documents
       FROM portals p
       JOIN clients c ON c.id = p.client_id
      WHERE p.org_id = $1
      ORDER BY p.label`,
    [orgId()],
  )

  for (const row of registered) {
    const portalId = readString(row, 'portal_id')
    const gate = discovery.portals.get(portalId)
    byId.set(portalId, {
      portalId,
      // The stored label wins for a registered portal — staff may have renamed it,
      // and a rename the next discovery silently reverted would be a bug — **unless**
      // it is still the raw portal id. A portal that registered itself on a visitor's
      // first visit has no name to store: nothing in the verified context token
      // carries one, and calling Gate on that request path would put a network hop in
      // front of every page load. So the id is stored and the platform's name is
      // preferred here, which is why the list reads "Client B" and not "eq94vsqm…".
      name:
        readString(row, 'label') === portalId
          ? displayLabel(portalId, gate, null)
          : readString(row, 'label'),
      url: gate?.domain ? `https://${gate.domain}` : null,
      workspaceId: gate?.workspaceId ?? readOptionalString(row, 'workspace_id'),
      registered: true,
      id: readString(row, 'id'),
      label: readString(row, 'label'),
      status: readString(row, 'status'),
      lastSeenAt: readOptionalString(row, 'last_seen_at'),
      clientId: readString(row, 'client_id'),
      documentsVisible: readNumber(row, 'visible_documents'),
      bindingCount: readNumber(row, 'binding_count'),
      // Only claimed when the platform read actually succeeded — otherwise a failed
      // `listPortals` would mark every portal in the org as deleted.
      missingFromPlatform: discovery.error === null && gate === undefined,
      missingSince: readOptionalString(row, 'missing_since'),
      // Days missing, and whether the grace period has elapsed. Computed here so the
      // screen does not decide policy — whether Remove is offered is a server answer.
      missingForDays: missingForDays(readOptionalString(row, 'missing_since')),
      removable:
        (missingForDays(readOptionalString(row, 'missing_since')) ?? -1) >= graceDays,
    })
  }

  // The libraries each portal receives — the same relationship the Libraries screen
  // shows from the other side, so "why does this portal show 40 documents" has one
  // place to answer it (§5B.6). One statement for every portal rather than one per
  // portal: a list must not show N+1 round trips' worth of moments.
  const libraryRows = await query(
    `SELECT b.portal_row_id, s.id, s.name
       FROM portal_source_bindings b
       JOIN document_sources s ON s.id = b.source_id
      WHERE s.org_id = $1 AND s.kind = 'library'
      ORDER BY s.name`,
    [orgId()],
  )
  const librariesByPortalRow = new Map<string, Array<{ id: string; name: string }>>()
  for (const row of libraryRows) {
    const key = readString(row, 'portal_row_id')
    const list = librariesByPortalRow.get(key) ?? []
    list.push({ id: readString(row, 'id'), name: readString(row, 'name') })
    librariesByPortalRow.set(key, list)
  }
  for (const entry of byId.values()) {
    if (entry.id) entry.libraries = librariesByPortalRow.get(entry.id) ?? []
  }

  const sightings = await query(
    `SELECT portal_id, workspace_id, label, first_seen_at, last_seen_at, seen_count
       FROM portal_registrations
      WHERE org_id = $1
      ORDER BY last_seen_at DESC`,
    [orgId()],
  )

  for (const row of sightings) {
    const portalId = readString(row, 'portal_id')
    const existing = byId.get(portalId)
    // A sighting for a portal that now has a tenant is stale bookkeeping. Its label
    // is still worth keeping if nothing better was found.
    if (existing?.registered) continue

    const gate = discovery.portals.get(portalId)
    const sightingLabel = readOptionalString(row, 'label')
    byId.set(portalId, {
      portalId,
      name: displayLabel(portalId, gate, sightingLabel),
      url: gate?.domain ? `https://${gate.domain}` : null,
      workspaceId: gate?.workspaceId ?? readOptionalString(row, 'workspace_id'),
      registered: false,
      firstSeenAt: readString(row, 'first_seen_at'),
      lastSeenAt: readString(row, 'last_seen_at'),
      seenCount: readNumber(row, 'seen_count'),
    })
  }

  const portals = [...byId.values()].sort((a, b) => {
    // Unregistered first: they are the rows that might need a click.
    if (a.registered !== b.registered) return a.registered ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  const lastRun = await lastReconcileRun()

  return c.json({
    portals,
    discovery: {
      ok: discovery.error === null,
      error: discovery.error,
      note:
        discovery.error === null
          ? null
          : 'Could not list portals from the platform, so this shows only portals that ' +
            'are already registered or that a visitor has opened. Grant portals.read to ' +
            'this app and redeploy for the full list.',
    },
    /**
     * What the reconcile did on this load, and when it last succeeded (§6A.4).
     *
     * Reported rather than silent: a screen that reconciles invisibly leaves an
     * operator unable to tell "nothing changed" from "it did not run". `skipped`
     * says which, and `lastRun` is what lets the screen show an age instead of a
     * reassuring blank.
     */
    reconcile: {
      ran: !reconcile.skipped,
      ok: reconcile.ok,
      error: reconcile.error,
      renamed: reconcile.renamed,
      markedMissing: reconcile.markedMissing,
      restored: reconcile.restored,
      lastRunAt: lastRun?.startedAt ?? null,
      lastRunOk: lastRun?.ok ?? null,
      graceDays,
    },
  })
})

/**
 * Provision a portal's tenant (§A.3).
 *
 * One click, no data to type: the name comes from the platform and the tenant is
 * created by `ensurePortalTenant`. Provisioning every discovered portal
 * automatically is tempting and wrong — an org may hold portals that have nothing to
 * do with this app, and each would acquire a tenant, a settings row and a place in
 * every list. **Discovery lists; a person provisions.**
 *
 * Idempotent, so a double click returns the same tenant rather than a 409: the
 * caller asked for the portal to be usable, and it is.
 */
portalRoutes.post('/:portalId/provision', async (c) => {
  const actor = await requireAdmin(c)
  const portalId = c.req.param('portalId').trim()
  if (portalId.length === 0) throw new HttpError(400, 'portalId is required', 'BAD_REQUEST')

  const platform = await readPlatformPortals()
  const gate = platform.ok ? platform.portals.get(portalId) : undefined

  // A portal the platform does not list, and that nobody has ever opened, is almost
  // certainly a typed or stale id. Refusing it keeps the tenant list clean; a portal
  // that has been opened is real regardless of what discovery says.
  const sighting = await queryOne(
    'SELECT workspace_id, label FROM portal_registrations WHERE org_id = $1 AND portal_id = $2',
    [orgId(), portalId],
  )
  if (!gate && !sighting) {
    if (!platform.ok) {
      throw new HttpError(
        503,
        `Could not confirm portal ${portalId} with the platform: ${platform.error}`,
        'DISCOVERY_UNAVAILABLE',
      )
    }
    throw new HttpError(404, `The platform does not list a portal ${portalId}`, 'NOT_FOUND')
  }

  const workspaceId = gate?.workspaceId ?? readOptionalString(sighting ?? {}, 'workspace_id')
  const label = displayLabel(portalId, gate, readOptionalString(sighting ?? {}, 'label'))

  const tenant = await ensurePortalTenant(portalId, workspaceId, label, actor.userId)

  if (tenant.created) {
    // The portal now works, so the alert about it not working is resolved. Best
    // -effort: the tenant is what matters and this must not be able to fail it.
    await updateRows(
      'system_alerts',
      { status: 'resolved', resolved_at: new Date().toISOString() },
      [
        { column: 'org_id', operator: 'eq', value: orgId() },
        { column: 'code', operator: 'eq', value: 'PORTAL_NOT_BOUND' },
        { column: 'status', operator: 'ne', value: 'resolved' },
      ],
    ).catch(() => undefined)

    await recordAudit({
      orgId: orgId(),
      clientId: tenant.clientId,
      actorUserId: actor.userId,
      action: 'portal.provisioned',
      targetType: 'portal',
      targetId: tenant.portalRowId,
      metadata: { portalId, workspaceId, label, source: 'admin' },
    })
  }

  return c.json(
    {
      id: tenant.portalRowId,
      portalId,
      label,
      clientId: tenant.clientId,
      status: tenant.status,
      created: tenant.created,
    },
    201,
  )
})

/**
 * Reconcile against FuseBase now (§6A.4).
 *
 * The same function the screen load and the schedule call, with the trigger recorded
 * so a burst of runs can be attributed. Answers with what changed rather than `ok`,
 * because "Sync now" that reports nothing leaves an operator unsure whether it ran.
 */
portalRoutes.post('/reconcile', async (c) => {
  const actor = await requireAdmin(c)
  const outcome = await reconcilePortals('button', actor.userId)

  // 200 even when the platform read failed: the request itself was fine, and the
  // failure is the answer. The screen shows it as a warning banner, which is where
  // the person who pressed the button is looking.
  return c.json(outcome)
})

/**
 * There is no rename any more (§6A.4).
 *
 * `PATCH /portals/:id` used to set the label by hand. The platform name now wins on
 * every reconcile, so a manual rename would be overwritten within fifteen minutes —
 * and an edit that silently reverts is worse than no edit. Portal names live in
 * FuseBase; library and folder names are this app's own and are edited there.
 *
 * Deliberately left as a 404 by absence rather than a 405 with an explanation: the
 * SPA no longer offers the control, and the e2e suite asserts the route is gone the
 * same way it asserts for the client-assignment routes.
 */

/**
 * Pause or resume a portal.
 *
 * A paused portal resolves to nothing for its viewers. This is the only off switch
 * and it is deliberately reversible: the alternative — deleting the row — would
 * leave the tenant's documents with no portal resolving to them, which is the
 * failure mode this phase exists to end.
 */
portalRoutes.put('/:portalRowId/status', async (c) => {
  const actor = await requireAdmin(c)
  const portalRowId = requireUuid(c.req.param('portalRowId'), 'portalRowId')
  const body = await readJsonBody(c)

  const status = body.status
  if (status !== 'active' && status !== 'paused') {
    throw new HttpError(400, 'status must be "active" or "paused"', 'BAD_REQUEST')
  }

  const updated = await updateRows('portals', { status }, [
    { column: 'id', operator: 'eq', value: portalRowId },
    { column: 'org_id', operator: 'eq', value: orgId() },
  ])
  if (updated === 0) throw new HttpError(404, 'Portal not found', 'NOT_FOUND')

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: `portal.${status}`,
    targetType: 'portal',
    targetId: portalRowId,
  })

  return c.json({ ok: true })
})

/**
 * "Preview what this portal sees" (§9.1 and §6.2).
 *
 * Resolved through `portal_documents_admin` rather than by client, because the whole
 * question is what the *bindings* expose — a client-scoped list would answer a
 * different question and look right while doing so. Rows a viewer cannot see are
 * included and flagged, since the point of the screen is to explain the difference.
 */
portalRoutes.get('/:portalRowId/preview', async (c) => {
  await requireAdmin(c)
  const portalRowId = requireUuid(c.req.param('portalRowId'), 'portalRowId')

  const portal = await queryOne('SELECT portal_id FROM portals WHERE id = $1 AND org_id = $2', [
    portalRowId,
    orgId(),
  ])
  if (!portal) throw new HttpError(404, 'Portal not found', 'NOT_FOUND')
  const portalId = readString(portal, 'portal_id')

  const rows = await query(
    `SELECT d.id, d.name, a.status,
            s.name AS source_name, s.kind AS source_kind,
            lib.id AS library_id, lib.name AS library_name
       FROM public.portal_documents_admin a
       JOIN documents d ON d.id = a.document_id
       LEFT JOIN document_sources s   ON s.id = d.source_id
       -- How the document reached this portal (§5B.6). Without it the screen can
       -- list forty documents and explain none of them, which is the question it
       -- exists to answer.
       LEFT JOIN document_sources lib ON lib.id = a.library_id
      WHERE a.portal_id = $1
      ORDER BY d.name`,
    [portalId],
  )

  const visible = await query(
    'SELECT document_id FROM public.portal_visible_documents WHERE portal_id = $1',
    [portalId],
  )
  const visibleIds = new Set(visible.map((row) => readString(row, 'document_id')))

  return c.json({
    portalId,
    documents: rows.map((row) => {
      const id = readString(row, 'id')
      const libraryName = readOptionalString(row, 'library_name')
      const sourceKind = readOptionalString(row, 'source_kind')
      return {
        id,
        name: readString(row, 'name'),
        status: readString(row, 'status'),
        sourceName: readOptionalString(row, 'source_name'),
        sourceKind,
        libraryName,
        /**
         * How this document reached this portal, in one phrase.
         *
         * Composed here rather than in the SPA because it is the answer to the
         * screen's central question, and it should read the same wherever it is
         * shown — including in a support reply pasted from the response.
         */
        origin:
          libraryName !== null
            ? `library "${libraryName}"`
            : sourceKind === 'app_upload'
              ? 'uploaded to this portal'
              : sourceKind === 'compasses_table'
                ? `synced from ${readOptionalString(row, 'source_name') ?? 'a table'}`
                : 'unknown',
        // The honest answer to "will the viewer see this row", rather than leaving
        // the reader to infer it from the status.
        clientVisible: visibleIds.has(id),
      }
    }),
  })
})

/**
 * What a permanent removal would destroy (§4.2).
 *
 * Read before the confirmation is shown, so the dialog states real numbers rather
 * than a generic warning. A count of what is about to be lost is the difference
 * between a considered decision and a reflex.
 */
portalRoutes.get('/:portalRowId/removal-impact', async (c) => {
  await requireAdmin(c)
  const portalRowId = requireUuid(c.req.param('portalRowId'), 'portalRowId')

  const row = await queryOne(
    'SELECT status, missing_since FROM portals WHERE id = $1 AND org_id = $2',
    [portalRowId, orgId()],
  )
  if (!row) throw new HttpError(404, 'Portal not found', 'NOT_FOUND')

  const graceDays = await removalGraceDays()
  const days = missingForDays(readOptionalString(row, 'missing_since'))
  const impact = await removalImpact(portalRowId)

  return c.json({
    ...impact,
    status: readString(row, 'status'),
    missingForDays: days,
    graceDays,
    removable: (days ?? -1) >= graceDays,
  })
})

/**
 * Remove a missing portal permanently (§4.2).
 *
 * The only destructive action in this app, and it is deliberately hard to reach:
 *
 *   1. **The portal must be missing**, not merely paused. A paused portal is a
 *      decision someone made here; a missing one is a decision made in FuseBase.
 *   2. **The grace period must have elapsed.** Absence is also what a partial page, a
 *      permission change and a five-second outage look like, so the row waits out a
 *      configurable number of days before anyone can act on it.
 *   3. **The name must be typed.** Not a checkbox: this deletes a client's chats and
 *      their history, and the one guard that reliably stops a mis-click on the wrong
 *      row is having to reproduce the row's name.
 *   4. **The audit row is written before the delete**, so the record survives even if
 *      the delete then fails — the opposite order loses the trail exactly when
 *      someone needs it.
 *
 * Shared libraries are untouched: they belong to other portals too, and the tick is
 * removed with the portal rather than the library with the tick.
 */
portalRoutes.delete('/:portalRowId/permanently', async (c) => {
  const actor = await requireAdmin(c)
  const portalRowId = requireUuid(c.req.param('portalRowId'), 'portalRowId')
  const body = await readJsonBody(c)

  const row = await queryOne(
    'SELECT portal_id, client_id, label, status, missing_since FROM portals WHERE id = $1 AND org_id = $2',
    [portalRowId, orgId()],
  )
  if (!row) throw new HttpError(404, 'Portal not found', 'NOT_FOUND')

  const label = readString(row, 'label')
  const status = readString(row, 'status')
  const missingSince = readOptionalString(row, 'missing_since')

  if (status !== 'missing') {
    throw new HttpError(
      409,
      `"${label}" is ${status}, not missing. Only a portal that FuseBase no longer ` +
        'lists can be removed — pause it instead if you want it to stop serving.',
      'PORTAL_NOT_MISSING',
    )
  }

  const graceDays = await removalGraceDays()
  const days = missingForDays(missingSince)
  if ((days ?? -1) < graceDays) {
    throw new HttpError(
      409,
      `"${label}" has been missing for ${days ?? 0} day(s). It can be removed after ` +
        `${graceDays}, in case the platform read was wrong or the portal comes back.`,
      'PORTAL_GRACE_PERIOD',
    )
  }

  const typed = typeof body.confirmLabel === 'string' ? body.confirmLabel.trim() : ''
  if (typed !== label) {
    throw new HttpError(
      400,
      `Type the portal's name exactly ("${label}") to confirm removal.`,
      'CONFIRMATION_MISMATCH',
    )
  }

  const clientId = readString(row, 'client_id')
  const impact = await removalImpact(portalRowId)

  // Written first, and deliberately not best-effort in spirit: this is the only
  // record that will exist afterwards.
  await recordAudit({
    orgId: orgId(),
    clientId,
    actorUserId: actor.userId,
    action: 'portal.removed_permanently',
    targetType: 'portal',
    targetId: portalRowId,
    metadata: {
      portalId: readString(row, 'portal_id'),
      label,
      missingSince,
      missingForDays: days,
      destroyed: {
        chats: impact.chats,
        documents: impact.documents,
        privateLibraries: impact.privateLibraries,
      },
      sharedLibrariesKept: impact.sharedLibraries,
    },
  })

  // Private libraries first: `library_id` is ON DELETE RESTRICT, so their documents
  // and derived rows have to go before the library, and the library before the portal
  // whose binding points at it.
  const privateLibraries = await query(
    `SELECT s.id
       FROM document_sources s
       JOIN portal_source_bindings b ON b.source_id = s.id
      WHERE b.portal_row_id = $1 AND s.is_private IS TRUE`,
    [portalRowId],
  )

  for (const library of privateLibraries) {
    const libraryId = readString(library, 'id')
    for (const table of [
      'document_chunks',
      'document_paragraphs',
      'document_pages',
      'ingest_jobs',
      'embedding_batches',
      'usage_events',
      'document_folders',
      'documents',
    ]) {
      await deleteRows(table, [{ column: 'library_id', operator: 'eq', value: libraryId }])
    }
    await deleteRows('portal_source_bindings', [
      { column: 'source_id', operator: 'eq', value: libraryId },
    ])
    await deleteRows('document_sources', [{ column: 'id', operator: 'eq', value: libraryId }])
  }

  // The tenant's own rows. Shared libraries are NOT touched — only this portal's
  // ticks to them, which go with the portal row itself via ON DELETE CASCADE.
  for (const table of [
    'chat_documents',
    'chat_messages',
    'chats',
    'rag_traces',
    'usage_events',
    'document_folders',
    'client_settings',
  ]) {
    await deleteRows(table, [{ column: 'client_id', operator: 'eq', value: clientId }])
  }

  // `portals.client_id` is ON DELETE RESTRICT, so the portal goes before its tenant.
  await deleteRows('portals', [{ column: 'id', operator: 'eq', value: portalRowId }])
  await deleteRows('clients', [{ column: 'id', operator: 'eq', value: clientId }])

  return c.json({ removed: true, label, destroyed: impact })
})
