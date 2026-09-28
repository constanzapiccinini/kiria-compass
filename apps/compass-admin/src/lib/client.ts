/**
 * Typed client for the admin backend.
 *
 * Same-origin relative paths only, so the platform routes the call and the
 * `fbsfeaturetoken` cookie rides along — no host is baked into the bundle, which is
 * what makes one build safe to deploy against any environment.
 *
 * No portal context header exists here. This app has no portal, and every route
 * authorizes on the caller's org role instead.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface ErrorShape {
  error?: { code?: unknown; message?: unknown }
}

function readError(payload: unknown, fallback: string): { code: string; message: string } {
  if (typeof payload === 'object' && payload !== null) {
    const shaped = payload as ErrorShape
    const message = typeof shaped.error?.message === 'string' ? shaped.error.message : fallback
    const code = typeof shaped.error?.code === 'string' ? shaped.error.code : 'ERROR'
    return { code, message }
  }
  return { code: 'ERROR', message: fallback }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // The session cookie is the whole authorization basis, so it must be sent.
    credentials: 'include',
    headers: { ...(init.headers ?? {}) },
  })

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null)
    const shaped = readError(payload, `Request failed with ${response.status}`)
    throw new ApiError(response.status, shaped.message, shaped.code)
  }

  return (await response.json()) as T
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

// --- types -----------------------------------------------------------------

/**
 * One file's outcome in an upload batch.
 *
 * Per file rather than per request: a batch where one PDF is a duplicate and another
 * is a scanned image has to say which is which, or the operator re-uploads the wrong
 * one.
 */
export interface UploadOutcome {
  name: string
  documentId?: string
  status: 'queued' | 'duplicate' | 'rejected'
  message?: string
}

export interface AdminActor {
  userId: string
  email: string | null
  orgRole: string
}

export interface SessionResponse {
  actor: AdminActor
  counts: {
    clients: number
    portals: number
    openAlerts: number
  }
  /**
   * Whether alert delivery is paused.
   *
   * Beside `counts` rather than in it: the count stays truthful while this is on, and
   * the rail uses this to decide whether to badge the real number — not to replace it.
   */
  alertsPaused: boolean
}

/**
 * A portal, as the picker in the shell needs it.
 *
 * Replaces `ClientRef`. Revision 2 of the phase spec removed the client from the
 * interface: one portal is one client, so a picker over clients was a picker over a
 * thing staff never create and never name.
 */
export interface PortalRef {
  /** `portals.id` — our row, not the platform's portal id. */
  id: string
  portalId: string
  label: string
  status: string
  lastSeenAt: string | null
  /**
   * The tenancy key the per-portal screens read.
   *
   * Still `clients.id`, still what every table, view and RLS policy underneath is
   * keyed on, and never shown anywhere in the interface (§1).
   */
  clientId: string
  clientStatus: string
  documentCount: number
}

/**
 * A portal as the merge of three sources: the platform's list, our own rows, and
 * sightings from portals a visitor has opened (§5A.5).
 *
 * `registered` means a tenant exists, which is the same thing as "this portal serves
 * visitors". The optional fields are genuinely optional rather than nullable: an
 * unregistered portal has no status and no documents, and a registered one has no
 * sighting counts.
 */
/** What one reconcile run did, as `POST /reconcile` reports it. */
export interface ReconcileOutcome {
  ok: boolean
  error: string | null
  portalsSeen: number
  renamed: number
  markedMissing: number
  restored: number
  skipped?: boolean
}

/**
 * What a permanent removal would destroy.
 *
 * Read before the confirmation is shown so the dialog can state real numbers. A
 * count of what is about to be lost is the difference between a considered decision
 * and a reflex.
 */
export interface RemovalImpact {
  label: string
  chats: number
  documents: number
  privateLibraries: number
  sharedLibraries: number
  status: string
  missingForDays: number | null
  graceDays: number
  removable: boolean
}

export interface PortalRow {
  portalId: string
  name: string
  url: string | null
  workspaceId: string | null
  registered: boolean
  id?: string
  label?: string
  status?: string
  lastSeenAt?: string | null
  clientId?: string
  documentsVisible?: number
  bindingCount?: number
  /** The libraries this portal receives — the same relationship from the other side. */
  libraries?: Array<{ id: string; name: string }>
  /** Registered, but the platform no longer lists it — deleted in FuseBase. */
  missingFromPlatform?: boolean
  /** When the reconcile first failed to find this portal on the platform. */
  missingSince?: string | null
  /** Whole days since then — what the grace period is measured against. */
  missingForDays?: number | null
  /** True once the grace period has elapsed, so the backend would accept a removal. */
  removable?: boolean
  firstSeenAt?: string
  seenCount?: number
}

export interface PortalsResponse {
  portals: PortalRow[]
  /**
   * What the reconcile did on this load, and when it last succeeded.
   *
   * Reported rather than silent: a screen that reconciles invisibly leaves an
   * operator unable to tell "nothing changed" from "it did not run". `ran` says
   * which.
   */
  reconcile?: {
    ran: boolean
    ok: boolean
    error: string | null
    renamed: number
    markedMissing: number
    restored: number
    lastRunAt: string | null
    lastRunOk: boolean | null
    graceDays: number
  }
  /**
   * Whether the platform list was actually readable.
   *
   * Reported rather than inferred: without it, a missing `portals.read` grant and
   * "this org has no portals" look identical on screen.
   */
  discovery: { ok: boolean; error: string | null; note: string | null }
}

/** A portal receiving a library — the "goes to" column (§5B.6). */
export interface LibraryPortal {
  portalRowId: string
  label: string
  status: string
}

export interface LibraryRow {
  id: string
  name: string
  description: string | null
  archivedAt: string | null
  createdAt: string
  documentCount: number
  pageCount: number
  indexedCount: number
  /**
   * Every portal this library goes to.
   *
   * On the row rather than behind a click, because a library IS a permission: "who
   * has this" is the first question anyone asks of the list, and a list that cannot
   * answer it invites the wrong assumption.
   */
  portals: LibraryPortal[]
  /**
   * A private library belongs to one portal and cannot be ticked to a second.
   *
   * Created automatically with the portal's tenant (§3), replacing the `app_upload`
   * source. "Private" is the only promise it makes, so the API refuses a second tick
   * with a 409 rather than quietly widening it.
   */
  isPrivate: boolean
}

export interface LibraryDocument {
  id: string
  name: string
  status: string
  statusDetail: string | null
  errorMessage: string | null
  pageCount: number | null
  chunkCount: number
  byteSize: number
  createdAt: string
  indexedAt: string | null
  deletedAt: string | null
  /** Null renders as Unfiled, which is a virtual node rather than a folder row. */
  folderId: string | null
  version: number
}

export interface PortalPreviewRow {
  id: string
  name: string
  status: string
  sourceName: string | null
  sourceKind: string | null
  libraryName: string | null
  /**
   * How this document reached the portal, in one phrase — its own upload, a table
   * source, or a named library.
   *
   * Composed by the backend so it reads identically everywhere, including in a
   * support reply pasted straight from the response.
   */
  origin: string
  clientVisible: boolean
}

/** One document's indexing health — moved here from the client app by §5C. */
export interface IndexHealthDocument {
  documentId: string
  name: string
  status: string
  statusDetail: string | null
  errorMessage: string | null
  pageCount: number | null
  chunkCount: number
  /**
   * Chunks that exist, versus chunks that have a vector.
   *
   * The pair is the point: a document with chunks and no embeddings reads as
   * `indexed` everywhere else while no question can ever reach it.
   */
  chunksPresent: number
  chunksEmbedded: number
  sourceKind: string
  createdAt: string
  indexedAt: string | null
}

export interface IngestJobView {
  id: string
  documentId: string | null
  kind: string
  status: string
  attempts: number
  maxAttempts: number
  nextRunAt: string | null
  lastError: string | null
  createdAt: string
  finishedAt: string | null
}

export interface IndexingSnapshot {
  documents: IndexHealthDocument[]
  statusCounts: Record<string, number>
  jobs: IngestJobView[]
  usageMonthToDate: { inputTokens: number; outputTokens: number; ocrPages: number; costUsd: number }
  /**
   * The spend of the libraries this portal receives.
   *
   * Separate from `usageMonthToDate` because it is shared: three portals ticked to
   * one library did not each pay for its embedding, it was paid once. Folding it in
   * would attribute one cost to several portals and over-count the month.
   */
  libraryUsageMonthToDate: {
    inputTokens: number
    outputTokens: number
    ocrPages: number
    costUsd: number
  }
}
export interface FolderRow {
  id: string
  parentId: string | null
  name: string
  position: number
  depth: number
}

export type SettingsLayer = 'default' | 'org' | 'client' | 'portal'

export interface SettingsResponse {
  settings: Record<string, unknown>
  /** Which layer supplied each effective value — the answer to "why is it that". */
  sources: Record<string, SettingsLayer>
}

export interface AlertPause {
  paused: boolean
  pausedAt: string | null
  /** Alerts first seen since the pause began — what resuming would reveal. */
  raisedWhilePaused: number
}

export interface AlertRow {
  id: string
  code: string
  severity: string
  scope: string
  title: string
  cause: string
  remediation: string
  clientMessage: string | null
  status: string
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
  clientName: string | null
  sourceName: string | null
  metadata: unknown
}

export interface AlertChannelFlags {
  /** Always true — the inbox reads `system_alerts` directly and cannot be turned off. */
  inApp: boolean
  email: boolean
  monday: boolean
}

export interface AlertSettingsResponse {
  channels: AlertChannelFlags
  recipients: Array<{ userId?: string; email?: string }>
  notes: { recipientRule: string; mondayStatus: string }
}

export interface UsageRow {
  clientId: string
  clientName: string
  inputTokens: number
  outputTokens: number
  ocrPages: number
  costUsd: number
  events: number
}

export interface AuditEntry {
  id: string
  action: string
  actorUserId: string | null
  targetType: string | null
  targetId: string | null
  ip: string | null
  metadata: unknown
  createdAt: string
  clientName: string | null
}

// --- calls -----------------------------------------------------------------

export const api = {
  session: (): Promise<SessionResponse> => request<SessionResponse>('/api/session'),

  /** Every portal, for the picker in the shell. Replaces `clients()`. */
  sessionPortals: (): Promise<{ portals: PortalRef[] }> =>
    request<{ portals: PortalRef[] }>('/api/session/portals'),

  /** Every portal the org has, registered or not, and whether discovery worked. */
  portals: (): Promise<PortalsResponse> => request<PortalsResponse>('/api/portals'),

  /**
   * Give a portal a tenant.
   *
   * No client is passed because none is chosen: one portal is one client, and the
   * name comes from the platform. Idempotent, so a double click is not an error.
   */
  provisionPortal: (
    portalId: string,
  ): Promise<{ id: string; label: string; clientId: string; created: boolean }> =>
    request(`/api/portals/${encodeURIComponent(portalId)}/provision`, jsonInit('POST', {})),

  /**
   * Re-read the platform's portal list and apply it (§6A.4).
   *
   * There is no rename to pair with this. A portal's name comes from FuseBase and is
   * rewritten on every reconcile, so an edit made here would revert within fifteen
   * minutes — and an edit that silently reverts is worse than no edit at all. Rename
   * the portal in FuseBase and press this.
   */
  reconcilePortals: (): Promise<ReconcileOutcome> =>
    request<ReconcileOutcome>('/api/portals/reconcile', { method: 'POST' }),

  removalImpact: (portalRowId: string): Promise<RemovalImpact> =>
    request<RemovalImpact>(`/api/portals/${portalRowId}/removal-impact`),

  /**
   * Remove a missing portal and everything private to it, permanently.
   *
   * `confirmLabel` must be the portal's name, typed. The backend refuses anything
   * else, and refuses the call outright unless the portal is missing and the grace
   * period has elapsed — this is the only destructive action in the app.
   */
  removePortalPermanently: (
    portalRowId: string,
    confirmLabel: string,
  ): Promise<{ removed: boolean }> =>
    request<{ removed: boolean }>(`/api/portals/${portalRowId}/permanently`, {
      ...jsonInit('DELETE', { confirmLabel }),
    }),

  portalPreview: (portalRowId: string): Promise<{ portalId: string; documents: PortalPreviewRow[] }> =>
    request(`/api/portals/${portalRowId}/preview`),

  /**
   * Pause or resume a portal. The only off switch, and reversible.
   *
   * There is deliberately no delete: removing the row would strand the tenant, whose
   * documents and chats would survive with no portal resolving to them.
   */
  setPortalStatus: (portalRowId: string, status: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/api/portals/${portalRowId}/status`, jsonInit('PUT', { status })),

  /**
   * A library's folder tree.
   *
   * Keyed on the library, not the client. Folders belonged to a tenant until 0015;
   * after §6.5 no document carries a `client_id` at all, so the client-scoped
   * version of this returned an empty tree for every caller rather than being merely
   * out of date.
   */
  folders: (libraryId: string): Promise<{ folders: FolderRow[] }> =>
    request<{ folders: FolderRow[] }>(
      `/api/documents/folders?libraryId=${encodeURIComponent(libraryId)}`,
    ),

  // --- folder organisation (admin-only; the client portal never edits the tree) ---

  createFolder: (
    libraryId: string,
    parentId: string | null,
    name: string,
  ): Promise<{ folder: FolderRow }> =>
    request<{ folder: FolderRow }>(
      '/api/documents/folders',
      jsonInit('POST', { libraryId, parentId, name }),
    ),

  renameFolder: (folderId: string, libraryId: string, name: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(
      `/api/documents/folders/${folderId}`,
      jsonInit('PATCH', { libraryId, name }),
    ),

  /**
   * Reparent a folder. Separate from reordering because this is the operation that
   * can create a cycle, and the backend refuses one before writing anything.
   */
  reparentFolder: (
    folderId: string,
    libraryId: string,
    parentId: string | null,
  ): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(
      `/api/documents/folders/${folderId}/parent`,
      jsonInit('PUT', { libraryId, parentId }),
    ),

  /** `orderedIds` must be the complete sibling set; the backend refuses a partial one. */
  reorderFolders: (
    libraryId: string,
    parentId: string | null,
    orderedIds: string[],
  ): Promise<{ folders: FolderRow[] }> =>
    request<{ folders: FolderRow[] }>(
      '/api/documents/folders/order',
      jsonInit('PUT', { libraryId, parentId, orderedIds }),
    ),

  deleteFolder: (folderId: string, libraryId: string): Promise<{ deleted: boolean }> =>
    request<{ deleted: boolean }>(
      `/api/documents/folders/${folderId}?libraryId=${encodeURIComponent(libraryId)}`,
      { method: 'DELETE' },
    ),

  /**
   * File a document into a folder of its own library, or to Unfiled with null.
   *
   * The library travels with the call because the backend confirms both the document
   * and the target folder belong to it — a folder id alone would let a document be
   * filed under another library's tree, where the viewer looking at it would never
   * find it.
   */
  moveDocument: (
    documentId: string,
    libraryId: string,
    folderId: string | null,
  ): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(
      `/api/documents/${documentId}/folder`,
      jsonInit('PUT', { libraryId, folderId }),
    ),

  reindexDocument: (documentId: string): Promise<{ jobId: string | null }> =>
    request<{ jobId: string | null }>(`/api/documents/${documentId}/reindex`, { method: 'POST' }),

  // --- indexing (§5C, moved from the client app) --------------------------

  /**
   * Indexing health for one portal.
   *
   * Keyed on the portal, not the tenant. A library document has `client_id = NULL`,
   * so after §6.5 a client-scoped snapshot reported zero documents, zero jobs and
   * zero cost for a portal that was actively indexing.
   */
  indexing: (portalRowId: string): Promise<IndexingSnapshot> =>
    request<IndexingSnapshot>(`/api/indexing?portalRowId=${encodeURIComponent(portalRowId)}`),

  /** Requeue every failed job, resetting attempts so an exhausted job runs again. */
  retryFailedJobs: (portalRowId: string): Promise<{ requeued: number }> =>
    request(`/api/indexing/retry-failed?portalRowId=${encodeURIComponent(portalRowId)}`, {
      method: 'POST',
    }),

  /** Re-index everything with no embeddings — indexed but unreachable by a question. */
  reindexUnsearchable: (portalRowId: string): Promise<{ enqueued: number }> =>
    request(`/api/indexing/reindex-unsearchable?portalRowId=${encodeURIComponent(portalRowId)}`, {
      method: 'POST',
    }),
  // --- libraries (§5B) ----------------------------------------------------

  libraries: (): Promise<{ libraries: LibraryRow[] }> =>
    request<{ libraries: LibraryRow[] }>('/api/libraries'),

  createLibrary: (name: string, description?: string): Promise<{ id: string }> =>
    request<{ id: string }>('/api/libraries', jsonInit('POST', { name, description })),

  /** Rename, describe, or archive. Archiving revokes nothing. */
  updateLibrary: (
    libraryId: string,
    patch: { name?: string; description?: string | null; archived?: boolean },
  ): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/api/libraries/${libraryId}`, jsonInit('PATCH', patch)),

  /** Refused with 409 while any portal is ticked, or any document remains. */
  deleteLibrary: (libraryId: string): Promise<{ deleted: boolean }> =>
    request<{ deleted: boolean }>(`/api/libraries/${libraryId}`, { method: 'DELETE' }),

  libraryDocuments: (libraryId: string): Promise<{ documents: LibraryDocument[] }> =>
    request<{ documents: LibraryDocument[] }>(`/api/libraries/${libraryId}/documents`),

  /**
   * Upload PDFs into a library — the only upload left (§6A.1).
   *
   * No `content-type` header: the browser must set it, because only the browser knows
   * the multipart boundary it generated. Setting it by hand produces a body the server
   * cannot parse, and the failure looks like a malformed request rather than a header
   * mistake.
   */
  uploadLibraryDocuments: (
    libraryId: string,
    files: File[],
  ): Promise<{ results: UploadOutcome[] }> => {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    return request<{ results: UploadOutcome[] }>(`/api/libraries/${libraryId}/documents`, {
      method: 'POST',
      body: form,
    })
  },

  deleteLibraryDocument: (
    libraryId: string,
    documentId: string,
  ): Promise<{ deleted: boolean; purgeJobId: string | null }> =>
    request(`/api/libraries/${libraryId}/documents/${documentId}`, { method: 'DELETE' }),

  /**
   * Tick or untick a portal.
   *
   * Writes immediately with no save button. That is what makes untick trustworthy:
   * one row appears, one row disappears, and the audit trail reads as a sequence of
   * decisions rather than a diff between two form submissions.
   */
  setLibraryPortal: (
    libraryId: string,
    portalRowId: string,
    ticked: boolean,
  ): Promise<{ ticked: boolean }> =>
    request<{ ticked: boolean }>(`/api/libraries/${libraryId}/portals/${portalRowId}`, {
      method: ticked ? 'PUT' : 'DELETE',
    }),

  /**
   * Delete a document. Soft-deletes immediately and queues the purge.
   *
   * Irreversible from this screen, so the caller must confirm first — the reason the
   * UI wraps it in a window.confirm naming the document and its passage count.
   */
  deleteDocument: (documentId: string): Promise<{ deleted: boolean; purgeJobId: string | null }> =>
    request<{ deleted: boolean; purgeJobId: string | null }>(`/api/documents/${documentId}`, {
      method: 'DELETE',
    }),

  documentVersions: (documentId: string): Promise<{ versions: Array<{ id: string; version: number; name: string; status: string; chunkCount: number; createdAt: string }> }> =>
    request(`/api/documents/${documentId}/versions`),

  settings: (clientId: string, portalRowId?: string): Promise<SettingsResponse> =>
    request<SettingsResponse>(
      `/api/settings?clientId=${encodeURIComponent(clientId)}${
        portalRowId ? `&portalRowId=${encodeURIComponent(portalRowId)}` : ''
      }`,
    ),

  saveClientSettings: (
    clientId: string,
    values: Record<string, unknown>,
  ): Promise<{ ok: boolean; applied: string[] }> =>
    request(`/api/settings/clients/${clientId}`, jsonInit('PUT', values)),

  saveDefaults: (
    values: Record<string, unknown>,
  ): Promise<{ ok: boolean; applied: string[] }> =>
    request('/api/settings/defaults', jsonInit('PUT', values)),

  savePortalOverride: (
    portalRowId: string,
    values: Record<string, unknown>,
  ): Promise<{ ok: boolean; applied: string[] }> =>
    request(`/api/settings/portals/${portalRowId}`, jsonInit('PUT', values)),

  settingsPortals: (clientId: string): Promise<{ portals: Array<{ id: string; portalId: string; label: string; override: Record<string, unknown> }> }> =>
    request(`/api/settings/portals?clientId=${encodeURIComponent(clientId)}`),

  alerts: (status = 'open', clientId?: string): Promise<{ alerts: AlertRow[] } & AlertPause> =>
    request<{ alerts: AlertRow[] } & AlertPause>(
      `/api/ops/alerts?status=${encodeURIComponent(status)}${
        clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''
      }`,
    ),

  setAlertStatus: (alertId: string, status: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/api/ops/alerts/${alertId}/status`, jsonInit('PUT', { status })),

  setAlertsPaused: (paused: boolean): Promise<AlertPause> =>
    request<AlertPause>('/api/ops/alerts/pause', jsonInit('PUT', { paused })),

  alertSettings: (): Promise<AlertSettingsResponse> =>
    request<AlertSettingsResponse>('/api/ops/alert-settings'),

  saveAlertSettings: (
    channels: AlertChannelFlags,
    recipients: string[],
  ): Promise<{ channels: Record<string, boolean> }> =>
    request<{ channels: Record<string, boolean> }>(
      '/api/ops/alert-settings',
      // Recipients go up as bare strings; the backend classifies each as a user id or
      // an email using Gate's own rule, so the UI does not have to guess.
      jsonInit('PUT', { channels, recipients }),
    ),

  usage: (): Promise<{ periodStart: string; pricing: unknown; clients: UsageRow[] }> =>
    request('/api/ops/usage'),

  audit: (filters: { clientId?: string; action?: string; before?: string } = {}): Promise<{
    entries: AuditEntry[]
    nextBefore: string | null
  }> => {
    const params = new URLSearchParams()
    if (filters.clientId) params.set('clientId', filters.clientId)
    if (filters.action) params.set('action', filters.action)
    if (filters.before) params.set('before', filters.before)
    const query = params.toString()
    return request(`/api/ops/audit${query ? `?${query}` : ''}`)
  },

  auditActions: (): Promise<{ actions: string[] }> =>
    request<{ actions: string[] }>('/api/ops/audit/actions'),
}
