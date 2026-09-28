/**
 * Documents and folders, scoped by library — §6A.2.
 *
 * Everything here was keyed on `clientId` until Phase 6. A library is now the only
 * way a document enters the system, so it is also the only way one is organised: the
 * listing and the upload moved to `routes/libraries.ts` (where the library is already
 * loaded and checked), and what stays here is what is addressed by a document id or a
 * folder id rather than by an owner.
 *
 * The one owner-scoped route left is the folder tree, which now takes `libraryId`.
 * Reading it per library rather than per client is not a refinement of the old
 * behaviour — after §6.5 no document carries a `client_id` at all, so the old query
 * returned an empty tree for every caller.
 *
 * Authorization is "is this caller staff", answered by `requireAdmin`. An explicit
 * owner id in the query string is correct in this app and would be a `TENANCY_PROBE`
 * in the client app, where the question is "which portal is this".
 */

import { Hono } from 'hono'
import { orgId } from '../lib/config.js'
import { HttpError, isUuid } from '../lib/auth.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { softDeleteDocument } from '../lib/document-intake.js'
import {
  createFolder,
  libraryFolders,
  type FolderOwner,
  deleteFolder,
  moveFolder,
  renameFolder,
  reorderSiblings,
} from '../lib/folders.js'
import { recordAudit } from '../lib/observability.js'
import {
  insertRow,
  query,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  updateRows,
} from '../lib/store.js'

export const documentRoutes = new Hono()

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) throw new HttpError(400, `${label} must be a UUID`, 'BAD_REQUEST')
  return value
}

/**
 * Resolve a folder's owning library from a caller-supplied id — §6A.2.
 *
 * Checked against `kind = 'library'` rather than merely existing, for the same reason
 * the library routes do it: a client's own source id is a perfectly valid uuid, and
 * accepting one here would build a folder tree on something that is not a library and
 * that no portal resolves folders through.
 *
 * Folders were keyed on `client_id` until 0015. Every folder belongs to a library
 * now, because every document does.
 */
async function loadLibraryOwner(raw: unknown): Promise<FolderOwner> {
  if (typeof raw !== 'string' || !isUuid(raw)) {
    throw new HttpError(400, 'libraryId is required and must be a UUID', 'BAD_REQUEST')
  }
  const row = await queryOne(
    `SELECT id FROM document_sources
      WHERE id = $1 AND org_id = $2 AND kind = 'library'`,
    [raw, orgId()],
  )
  if (!row) throw new HttpError(404, 'Library not found', 'NOT_FOUND')
  return libraryFolders(raw)
}

/** A library's folder tree, read-only here — the mutations are further down. */
documentRoutes.get('/folders', async (c) => {
  await requireAdmin(c)
  const owner = await loadLibraryOwner(c.req.query('libraryId'))

  const rows = await query(
    `SELECT id, parent_id, name, position, depth
       FROM document_folders
      WHERE ${owner.column} = $1
      ORDER BY depth, position, name`,
    [owner.value],
  )

  return c.json({
    folders: rows.map((row) => ({
      id: readString(row, 'id'),
      parentId: readOptionalString(row, 'parent_id'),
      name: readString(row, 'name'),
      position: readNumber(row, 'position'),
      depth: readNumber(row, 'depth'),
    })),
  })
})

/**
 * File a document into an existing folder of its own library, or to Unfiled with
 * `folderId: null`.
 *
 * Never re-indexes: where a document sits has nothing to do with its content.
 *
 * It used to also set `folder_pinned`, which meant "a person filed this, do not let
 * the next sync move it". 0019 dropped the column: with no sync there is nothing left
 * for it to defend the folder against.
 *
 * Both the document and the target folder are confirmed to belong to the library
 * named in the body. Checking only the folder would let a document be moved into a
 * tree it does not belong to; checking only the document would let it be filed under
 * another library's folder. Either one renders as a document that has vanished from
 * the tree a viewer is looking at.
 */
documentRoutes.put('/:documentId/folder', async (c) => {
  const actor = await requireAdmin(c)
  const documentId = requireUuid(c.req.param('documentId'), 'documentId')

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  const raw = (body as { folderId?: unknown }).folderId
  const owner = await loadLibraryOwner((body as { libraryId?: unknown }).libraryId)

  const folderId = raw === null || raw === undefined ? null : requireUuid(String(raw), 'folderId')

  if (folderId) {
    const folder = await queryOne(
      `SELECT id FROM document_folders WHERE id = $1 AND ${owner.column} = $2`,
      [folderId, owner.value],
    )
    if (!folder) throw new HttpError(404, 'Folder not found in this library', 'NOT_FOUND')
  }

  const moved = await updateRows('documents', { folder_id: folderId }, [
    { column: 'id', operator: 'eq', value: documentId },
    { column: owner.column, operator: 'eq', value: owner.value },
  ])
  if (moved === 0) throw new HttpError(404, 'Document not found in this library', 'NOT_FOUND')

  await recordAudit({
    orgId: orgId(),
    // A library document belongs to no tenant, so no clientId is recorded.
    actorUserId: actor.userId,
    action: 'document.moved',
    targetType: 'document',
    targetId: documentId,
    metadata: { folderId, libraryId: owner.value },
  })

  return c.json({ ok: true })
})

/**
 * Queue a re-index.
 *
 * Enqueued for the client app's worker, the same as a sync: one pipeline, one set of
 * retry semantics.
 */
documentRoutes.post('/:documentId/reindex', async (c) => {
  const actor = await requireAdmin(c)
  const documentId = requireUuid(c.req.param('documentId'), 'documentId')

  const document = await queryOne('SELECT client_id, library_id FROM documents WHERE id = $1', [
    documentId,
  ])
  if (!document) throw new HttpError(404, 'Document not found', 'NOT_FOUND')

  // Both columns, read from the row rather than assumed. After 0013 a document
  // belongs to a tenant OR to a library, and an `ingest_jobs` row with neither
  // violates the XOR check outright — so copying `client_id` unconditionally, which
  // is what this did, would have made a library document impossible to re-index.
  const clientId = readOptionalString(document, 'client_id')
  const libraryId = readOptionalString(document, 'library_id')

  const job = await insertRow(
    'ingest_jobs',
    {
      client_id: clientId,
      library_id: libraryId,
      document_id: documentId,
      kind: 'reindex',
      status: 'queued',
      payload: JSON.stringify({ userId: actor.userId }),
    },
    ['id'],
  )

  await recordAudit({
    orgId: orgId(),
    clientId,
    actorUserId: actor.userId,
    action: 'document.reindex_requested',
    targetType: 'document',
    targetId: documentId,
    metadata: { libraryId, jobId: job ? readString(job, 'id') : null },
  })

  return c.json({ jobId: job ? readString(job, 'id') : null }, 202)
})

/**
 * Version history for a document (§9.4).
 *
 * Walks the `supersedes_document_id` chain that Phase 1 already writes on re-ingest,
 * rather than a separate history table — the versions are real rows, so they are
 * their own history.
 */
documentRoutes.get('/:documentId/versions', async (c) => {
  await requireAdmin(c)
  const documentId = requireUuid(c.req.param('documentId'), 'documentId')

  const rows = await query(
    `WITH RECURSIVE chain AS (
       SELECT id, version, supersedes_document_id, name, status, created_at, chunk_count
         FROM documents WHERE id = $1
       UNION ALL
       SELECT d.id, d.version, d.supersedes_document_id, d.name, d.status, d.created_at, d.chunk_count
         FROM documents d
         JOIN chain ch ON d.id = ch.supersedes_document_id
     )
     SELECT * FROM chain ORDER BY version DESC`,
    [documentId],
  )

  return c.json({
    versions: rows.map((row) => ({
      id: readString(row, 'id'),
      version: readNumber(row, 'version'),
      name: readString(row, 'name'),
      status: readString(row, 'status'),
      chunkCount: readNumber(row, 'chunk_count'),
      createdAt: readString(row, 'created_at'),
    })),
  })
})

/**
 * Delete a document — §9.4.
 *
 * Two steps, in this order, and the order is the point:
 *
 * 1. **Soft-delete immediately**, so the document leaves every client's view in the
 *    same request. `portal_visible_documents` filters on `deleted_at`, so this is
 *    what actually revokes access — waiting for the worker would leave a document
 *    readable for as long as the queue is behind.
 * 2. **Enqueue the purge**, which the client app's worker performs. Chunks, pages,
 *    paragraphs and the row itself go there, using the same `purgeDocument` the
 *    client app's own delete uses. Reimplementing that here would be a second
 *    chance to destroy the wrong index, and this app's whole stance is that the
 *    pipeline lives in one place.
 *
 * So a client loses access instantly and the storage is reclaimed shortly after. If
 * the worker never runs, the document stays soft-deleted and invisible rather than
 * half-deleted and readable — which is the right way round for that failure.
 */
documentRoutes.delete('/:documentId', async (c) => {
  const actor = await requireAdmin(c)
  const documentId = requireUuid(c.req.param('documentId'), 'documentId')

  const result = await softDeleteDocument(documentId, actor.userId, 'admin')
  if (!result) throw new HttpError(404, 'Document not found', 'NOT_FOUND')

  return c.json(result, 202)
})

// ---------------------------------------------------------------------------
// folder organisation — admin-only (§7)
//
// The client portal shows the tree and never edits it, so these are the only
// endpoints that mutate it. Each delegates to `lib/folders.ts`, which owns the cycle
// and depth rules; the routes here do argument validation and nothing else, so the
// subtle logic has exactly one implementation in this app.
// ---------------------------------------------------------------------------

/** Create a folder under an existing parent, or at the root with `parentId: null`. */
documentRoutes.post('/folders', async (c) => {
  const actor = await requireAdmin(c)

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  const payload = body as { libraryId?: unknown; parentId?: unknown; name?: unknown }

  // Folders belong to a library (§6A.2), so this is a libraryId. The owner is
  // validated by `loadLibraryOwner`, which refuses anything that is not a library.
  const owner = await loadLibraryOwner(payload.libraryId)

  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (name.length === 0) throw new HttpError(400, 'name is required', 'BAD_REQUEST')

  // Absent and explicit null both mean "at the root". A string must be a real uuid.
  const parentId =
    payload.parentId === undefined || payload.parentId === null
      ? null
      : requireUuid(String(payload.parentId), 'parentId')

  const folder = await createFolder({ owner, parentId, name, userId: actor.userId })
  return c.json({ folder }, 201)
})

/** Rename a folder. Never touches position or parent. */
documentRoutes.patch('/folders/:folderId', async (c) => {
  const actor = await requireAdmin(c)
  const folderId = requireUuid(c.req.param('folderId'), 'folderId')

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  const payload = body as { libraryId?: unknown; name?: unknown }

  // Folders belong to a library (§6A.2), so this is a libraryId. The owner is
  // validated by `loadLibraryOwner`, which refuses anything that is not a library.
  const owner = await loadLibraryOwner(payload.libraryId)

  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (name.length === 0) throw new HttpError(400, 'name is required', 'BAD_REQUEST')

  await renameFolder(owner, folderId, name)

  // Audited here rather than inside the helper: the helper is shared shape, and the
  // actor is only known at the route.
  await recordAudit({
    orgId: orgId(),
    // A library folder belongs to no tenant, so no clientId is recorded.
    actorUserId: actor.userId,
    action: 'folder.renamed',
    targetType: 'folder',
    targetId: folderId,
    metadata: { name, via: 'admin' },
  })

  return c.json({ ok: true })
})

/**
 * Reparent a folder — the operation that can create a cycle.
 *
 * Separate from reorder on purpose. `moveFolder` refuses to place a folder under its
 * own descendant and refuses a move whose deepest descendant would exceed the depth
 * limit, both checked before anything is written. Putting reparenting behind the
 * reorder endpoint would run it through validation that does not look for cycles.
 */
documentRoutes.put('/folders/:folderId/parent', async (c) => {
  const actor = await requireAdmin(c)
  const folderId = requireUuid(c.req.param('folderId'), 'folderId')

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  const payload = body as { libraryId?: unknown; parentId?: unknown }

  // Folders belong to a library (§6A.2), so this is a libraryId. The owner is
  // validated by `loadLibraryOwner`, which refuses anything that is not a library.
  const owner = await loadLibraryOwner(payload.libraryId)

  const parentId =
    payload.parentId === undefined || payload.parentId === null
      ? null
      : requireUuid(String(payload.parentId), 'parentId')

  await moveFolder(owner, folderId, parentId)

  await recordAudit({
    orgId: orgId(),
    // A library folder belongs to no tenant, so no clientId is recorded.
    actorUserId: actor.userId,
    action: 'folder.reparented',
    targetType: 'folder',
    targetId: folderId,
    metadata: { parentId, via: 'admin' },
  })

  return c.json({ ok: true })
})

/**
 * Put one parent's children in an explicit order.
 *
 * `orderedIds` must list every child of that parent: a partial list would leave the
 * omitted folders on positions that collide with the new ones.
 */
documentRoutes.put('/folders/order', async (c) => {
  const actor = await requireAdmin(c)

  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  const payload = body as { libraryId?: unknown; parentId?: unknown; orderedIds?: unknown }

  // Folders belong to a library (§6A.2), so this is a libraryId. The owner is
  // validated by `loadLibraryOwner`, which refuses anything that is not a library.
  const owner = await loadLibraryOwner(payload.libraryId)

  const parentId =
    payload.parentId === undefined || payload.parentId === null
      ? null
      : requireUuid(String(payload.parentId), 'parentId')

  if (!Array.isArray(payload.orderedIds)) {
    throw new HttpError(400, 'orderedIds must be an array', 'BAD_REQUEST')
  }
  const orderedIds = payload.orderedIds.map((id, index) =>
    requireUuid(String(id), `orderedIds[${index}]`),
  )

  const folders = await reorderSiblings({ owner, parentId, orderedIds, userId: actor.userId })
  return c.json({ folders })
})

/**
 * Delete a folder. Its children move up to its parent; its documents become Unfiled.
 *
 * Nothing is deleted recursively: a folder is an organisational label, and losing a
 * subtree of documents because a label was removed would be indefensible.
 */
documentRoutes.delete('/folders/:folderId', async (c) => {
  const actor = await requireAdmin(c)
  const folderId = requireUuid(c.req.param('folderId'), 'folderId')

  const owner = await loadLibraryOwner(c.req.query('libraryId'))

  await deleteFolder(owner, folderId)

  await recordAudit({
    orgId: orgId(),
    // A library folder belongs to no tenant, so no clientId is recorded.
    actorUserId: actor.userId,
    action: 'folder.deleted',
    targetType: 'folder',
    targetId: folderId,
    metadata: { via: 'admin' },
  })

  return c.json({ deleted: true })
})
