/**
 * Libraries — §5B.
 *
 * A library is a named set of documents belonging to no portal. Staff upload PDFs
 * into it, the pipeline parses, chunks and embeds them **once**, and then they tick
 * the portals that receive it. A portal shows the union of its own documents and
 * every library ticked for it.
 *
 * That is the offer shape — build it once, hand it to whoever should have it — and
 * the cost argument is real: a library on five portals is embedded once, not five
 * times. The assertion for that lives in `scripts/verify-library-rls.mjs`, which
 * measures the chunk count before and after a second portal is ticked.
 *
 * **A tick is a `portal_source_bindings` row and nothing else.** `portal_source_bindings`
 * already means "this portal reads this source", so a library grant IS that row.
 * Revision 1 of the spec added a `source_grants` table for the same question and
 * revision 2 dropped it: two mechanisms answering one question is how a viewer ends
 * up seeing a document nobody can explain.
 *
 * The upload and delete paths are the Phase 4 handlers parameterised on their owner
 * (`lib/document-intake.ts`), not copies of them. `%PDF` by content, dedupe on
 * content hash, per-file outcomes with 207 rather than a 4xx, soft-delete then
 * enqueue the purge — all identical, because the only real difference is which
 * column the row is stamped with.
 */

import { Hono } from 'hono'
import { orgId } from '../lib/config.js'
import { HttpError, isUuid } from '../lib/auth.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { intakeDocuments, softDeleteDocument } from '../lib/document-intake.js'
import { recordAudit } from '../lib/observability.js'
import {
  deleteRows,
  insertRow,
  query,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  updateRows,
} from '../lib/store.js'

export const libraryRoutes = new Hono()

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) throw new HttpError(400, `${label} must be a UUID`, 'BAD_REQUEST')
  return value
}

async function readJsonBody(
  c: Parameters<typeof requireAdmin>[0],
): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'A JSON body is required', 'BAD_REQUEST')
  }
  return body as Record<string, unknown>
}

/**
 * Load a library, refusing anything that is not one.
 *
 * The id is checked against `kind = 'library'` rather than just existing: every
 * route below writes bindings and documents, and pointing one of them at a client's
 * `app_upload` source by passing its id would attach org-wide documents to one
 * tenant's private source. Same class of mistake the tenancy model exists to prevent.
 */
async function loadLibrary(
  libraryId: string,
): Promise<{ id: string; name: string; archivedAt: string | null; isPrivate: boolean }> {
  const row = await queryOne(
    `SELECT id, name, archived_at, is_private FROM document_sources
      WHERE id = $1 AND org_id = $2 AND kind = 'library'`,
    [libraryId, orgId()],
  )
  if (!row) throw new HttpError(404, 'Library not found', 'NOT_FOUND')
  return {
    id: readString(row, 'id'),
    name: readString(row, 'name'),
    archivedAt: readOptionalString(row, 'archived_at'),
    isPrivate: row.is_private === true,
  }
}

/**
 * Every library, with what it holds and where it goes.
 *
 * "Goes to" is the column that matters: a library is a permission surface, and the
 * list has to answer "who has this" without a second click.
 */
libraryRoutes.get('/', async (c) => {
  await requireAdmin(c)

  const rows = await query(
    `SELECT s.id, s.name, s.description, s.archived_at, s.created_at, s.is_private,
            (SELECT count(*) FROM documents d
              WHERE d.library_id = s.id AND d.deleted_at IS NULL) AS document_count,
            (SELECT coalesce(sum(d.page_count), 0) FROM documents d
              WHERE d.library_id = s.id AND d.deleted_at IS NULL) AS page_count,
            (SELECT count(*) FROM documents d
              WHERE d.library_id = s.id AND d.deleted_at IS NULL AND d.status = 'indexed')
              AS indexed_count
       FROM document_sources s
      WHERE s.org_id = $1 AND s.kind = 'library'
      ORDER BY s.archived_at NULLS FIRST, s.name`,
    [orgId()],
  )

  // One statement for every library's portals rather than one per library: the list
  // must not show N+1 round trips' worth of moments.
  const bindings = await query(
    `SELECT b.source_id, p.id AS portal_row_id, p.label, p.status
       FROM portal_source_bindings b
       JOIN portals p ON p.id = b.portal_row_id
       JOIN document_sources s ON s.id = b.source_id
      WHERE s.org_id = $1 AND s.kind = 'library'
      ORDER BY p.label`,
    [orgId()],
  )

  const portalsByLibrary = new Map<
    string,
    Array<{ portalRowId: string; label: string; status: string }>
  >()
  for (const row of bindings) {
    const key = readString(row, 'source_id')
    const list = portalsByLibrary.get(key) ?? []
    list.push({
      portalRowId: readString(row, 'portal_row_id'),
      label: readString(row, 'label'),
      status: readString(row, 'status'),
    })
    portalsByLibrary.set(key, list)
  }

  return c.json({
    libraries: rows.map((row) => {
      const id = readString(row, 'id')
      return {
        id,
        name: readString(row, 'name'),
        description: readOptionalString(row, 'description'),
        archivedAt: readOptionalString(row, 'archived_at'),
        createdAt: readString(row, 'created_at'),
        // A private library belongs to one portal and cannot be shared (§6A.3). The
        // list says so, because the reason its tick checkbox is refused should be
        // visible before anyone clicks it.
        isPrivate: row.is_private === true,
        documentCount: readNumber(row, 'document_count'),
        pageCount: readNumber(row, 'page_count'),
        indexedCount: readNumber(row, 'indexed_count'),
        portals: portalsByLibrary.get(id) ?? [],
      }
    }),
  })
})

/** Create a library. Name only — the documents and the portals come after. */
libraryRoutes.post('/', async (c) => {
  const actor = await requireAdmin(c)
  const body = await readJsonBody(c)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length === 0) throw new HttpError(400, 'name is required', 'BAD_REQUEST')

  const description =
    typeof body.description === 'string' && body.description.trim().length > 0
      ? body.description.trim().slice(0, 2000)
      : null

  const existing = await queryOne(
    `SELECT id FROM document_sources
      WHERE org_id = $1 AND kind = 'library' AND lower(name) = lower($2)`,
    [orgId(), name],
  )
  if (existing) {
    throw new HttpError(409, `A library called "${name}" already exists`, 'LIBRARY_EXISTS')
  }

  const created = await insertRow(
    'document_sources',
    {
      org_id: orgId(),
      name: name.slice(0, 200),
      description,
      // Both columns are now CHECKed to 'library' and default to it (0019). Written
      // explicitly anyway: an insert that says what it is creating survives the next
      // person reading it.
      kind: 'library',
      owner_kind: 'library',
      created_by_user_id: actor.userId,
    },
    ['id'],
  )
  if (!created) throw new HttpError(500, 'Could not create the library', 'ERROR')
  const id = readString(created, 'id')

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: 'library.created',
    targetType: 'library',
    targetId: id,
    metadata: { name, description },
  })

  return c.json({ id, name, description }, 201)
})

/**
 * Rename, describe, or archive a library.
 *
 * Archiving hides it from pickers and stops it being offered; it **revokes nothing**
 * and everything already ticked stays readable. That is the deliberate difference
 * from deleting, and it is why archiving needs no confirmation while deleting is
 * refused outright below.
 */
libraryRoutes.patch('/:libraryId', async (c) => {
  const actor = await requireAdmin(c)
  const libraryId = requireUuid(c.req.param('libraryId'), 'libraryId')
  const library = await loadLibrary(libraryId)
  const body = await readJsonBody(c)

  const patch: Record<string, string | null> = {}

  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (name.length === 0) throw new HttpError(400, 'name cannot be empty', 'BAD_REQUEST')
    patch.name = name.slice(0, 200)
  }

  if (body.description === null || typeof body.description === 'string') {
    patch.description =
      typeof body.description === 'string' && body.description.trim().length > 0
        ? body.description.trim().slice(0, 2000)
        : null
  }

  if (typeof body.archived === 'boolean') {
    patch.archived_at = body.archived ? new Date().toISOString() : null
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'Nothing to change', 'BAD_REQUEST')
  }

  const updated = await updateRows('document_sources', patch, [
    { column: 'id', operator: 'eq', value: libraryId },
    { column: 'org_id', operator: 'eq', value: orgId() },
  ])
  if (updated === 0) throw new HttpError(404, 'Library not found', 'NOT_FOUND')

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: 'library.updated',
    targetType: 'library',
    targetId: libraryId,
    metadata: { was: library.name, patch },
  })

  return c.json({ ok: true })
})

/**
 * Delete a library.
 *
 * Refused while any portal is ticked, naming them (§B.5). A viewer's document list
 * emptying silently is the worst failure this app can produce, so it is not
 * something a single click may cause — untick everything first, deliberately, and
 * the refusal says exactly what to untick.
 *
 * Documents are the database's own refusal: `library_id` is `ON DELETE RESTRICT`, so
 * even if this check were bypassed the delete would fail rather than cascade a
 * library's documents away.
 */
libraryRoutes.delete('/:libraryId', async (c) => {
  const actor = await requireAdmin(c)
  const libraryId = requireUuid(c.req.param('libraryId'), 'libraryId')
  const library = await loadLibrary(libraryId)

  const ticked = await query(
    `SELECT p.label FROM portal_source_bindings b
       JOIN portals p ON p.id = b.portal_row_id
      WHERE b.source_id = $1
      ORDER BY p.label`,
    [libraryId],
  )
  if (ticked.length > 0) {
    const names = ticked.map((row) => readString(row, 'label')).join(', ')
    throw new HttpError(
      409,
      `"${library.name}" still goes to ${ticked.length} portal(s): ${names}. ` +
        'Untick them first — deleting it would empty their document lists.',
      'LIBRARY_IN_USE',
    )
  }

  const documents = await queryOne(
    'SELECT count(*)::int AS n FROM documents WHERE library_id = $1',
    [libraryId],
  )
  const documentCount = documents ? readNumber(documents, 'n') : 0
  if (documentCount > 0) {
    throw new HttpError(
      409,
      `"${library.name}" still holds ${documentCount} document(s). Delete them first, ` +
        'or archive the library instead — archiving keeps everything readable.',
      'LIBRARY_NOT_EMPTY',
    )
  }

  // Cost history outlives the library, and that is deliberate.
  //
  // `usage_events.library_id` is ON DELETE RESTRICT like every other library
  // reference, so once a library has cost anything to embed, the database will not
  // let it be deleted — deleting it would erase money that was actually spent from
  // the usage screen's arithmetic. `usage_events` cannot simply lose its owner
  // either: 0013's `CHECK ((client_id IS NULL) <> (library_id IS NULL))` means a
  // usage row must always name exactly one, so there is no "orphan it" option.
  //
  // Checked here rather than left to the database, because without this the DELETE
  // surfaced as a raw constraint violation — a 500 with a Postgres message — and the
  // caller was told nothing about archiving, which is the thing they actually want.
  // Found by e2e fixtures that would not clean themselves up.
  const usage = await queryOne(
    'SELECT count(*)::int AS n FROM usage_events WHERE library_id = $1',
    [libraryId],
  )
  const usageCount = usage ? readNumber(usage, 'n') : 0
  if (usageCount > 0) {
    throw new HttpError(
      409,
      `"${library.name}" has ${usageCount} recorded usage event(s), so its cost history ` +
        'would be lost. Archive it instead — an archived library disappears from every ' +
        'picker, stops being offered, and keeps what it already cost on the usage screen.',
      'LIBRARY_HAS_HISTORY',
    )
  }

  await deleteRows('document_sources', [
    { column: 'id', operator: 'eq', value: libraryId },
    { column: 'org_id', operator: 'eq', value: orgId() },
  ])

  await recordAudit({
    orgId: orgId(),
    actorUserId: actor.userId,
    action: 'library.deleted',
    targetType: 'library',
    targetId: libraryId,
    metadata: { name: library.name },
  })

  return c.json({ deleted: true })
})

/** Every document in a library, including the ones still processing. */
libraryRoutes.get('/:libraryId/documents', async (c) => {
  await requireAdmin(c)
  const libraryId = requireUuid(c.req.param('libraryId'), 'libraryId')
  await loadLibrary(libraryId)

  const rows = await query(
    `SELECT id, name, status, status_detail, error_message, page_count, chunk_count,
            byte_size, version, folder_id, created_at, indexed_at, deleted_at
       FROM documents
      WHERE library_id = $1
      ORDER BY deleted_at NULLS FIRST, created_at DESC`,
    [libraryId],
  )

  return c.json({
    documents: rows.map((row) => ({
      id: readString(row, 'id'),
      name: readString(row, 'name'),
      status: readString(row, 'status'),
      statusDetail: readOptionalString(row, 'status_detail'),
      errorMessage: readOptionalString(row, 'error_message'),
      pageCount: row.page_count === null ? null : readNumber(row, 'page_count'),
      chunkCount: readNumber(row, 'chunk_count'),
      byteSize: readNumber(row, 'byte_size'),
      version: readNumber(row, 'version'),
      folderId: readOptionalString(row, 'folder_id'),
      createdAt: readString(row, 'created_at'),
      indexedAt: readOptionalString(row, 'indexed_at'),
      deletedAt: readOptionalString(row, 'deleted_at'),
    })),
  })
})

/**
 * Upload PDFs into a library — identical contract to `POST /api/documents`.
 *
 * Same handler, parameterised on the owner. An archived library still accepts
 * uploads: archiving means "stop offering this", not "freeze it", and refusing here
 * would strand an operator mid-batch for a reason unrelated to the files.
 */
libraryRoutes.post('/:libraryId/documents', async (c) => {
  const actor = await requireAdmin(c)
  const libraryId = requireUuid(c.req.param('libraryId'), 'libraryId')
  await loadLibrary(libraryId)

  const form = await c.req.formData().catch(() => null)
  if (!form) throw new HttpError(400, 'A multipart/form-data body is required', 'BAD_REQUEST')

  const files = form.getAll('files').filter((entry): entry is File => entry instanceof File)
  if (files.length === 0) throw new HttpError(400, 'At least one file is required', 'BAD_REQUEST')

  const results = await intakeDocuments(
    files,
    { kind: 'library', libraryId },
    actor.userId,
    'admin-library',
  )

  const allQueued = results.every((result) => result.status === 'queued')
  return c.json({ results }, allQueued ? 201 : 207)
})

/** Soft-delete a document from a library and queue its purge. */
libraryRoutes.delete('/:libraryId/documents/:documentId', async (c) => {
  const actor = await requireAdmin(c)
  const libraryId = requireUuid(c.req.param('libraryId'), 'libraryId')
  const documentId = requireUuid(c.req.param('documentId'), 'documentId')
  await loadLibrary(libraryId)

  // Confirmed to be in THIS library, not merely to exist: the id comes from a URL,
  // and a document from another library — or from a portal's private uploads — must
  // not be deletable through the wrong one.
  const owned = await queryOne('SELECT id FROM documents WHERE id = $1 AND library_id = $2', [
    documentId,
    libraryId,
  ])
  if (!owned) throw new HttpError(404, 'Document not found in this library', 'NOT_FOUND')

  const result = await softDeleteDocument(documentId, actor.userId, 'admin-library')
  if (!result) throw new HttpError(404, 'Document not found', 'NOT_FOUND')

  return c.json(result, 202)
})

/**
 * Tick a portal — it starts receiving this library.
 *
 * Writes immediately, with no save button, because that is what makes untick
 * trustworthy: one row appears, one row disappears, and the audit trail reads as a
 * sequence of decisions rather than a diff between two form submissions.
 *
 * Idempotent: ticking twice is the same state, not a 409. Whether a portal receives
 * a library is a boolean, and a repeated click means the operator wants it on.
 */
libraryRoutes.put('/:libraryId/portals/:portalRowId', async (c) => {
  const actor = await requireAdmin(c)
  const libraryId = requireUuid(c.req.param('libraryId'), 'libraryId')
  const portalRowId = requireUuid(c.req.param('portalRowId'), 'portalRowId')
  const library = await loadLibrary(libraryId)

  const portal = await queryOne('SELECT label FROM portals WHERE id = $1 AND org_id = $2', [
    portalRowId,
    orgId(),
  ])
  if (!portal) throw new HttpError(404, 'Portal not found', 'NOT_FOUND')

  /**
   * A private library goes to exactly one portal (§6A.3).
   *
   * "Private" is the only promise this kind of library makes, so the API keeps it
   * rather than trusting the screen not to offer the option. Staff who want to share
   * these files move them to a shared library — an explicit, audited action — and
   * the refusal says so, because otherwise the answer looks like a missing feature.
   *
   * Checked before the archive rule below: being private is the more specific reason,
   * and an operator should hear the one that will not change.
   */
  if (library.isPrivate) {
    const owner = await queryOne(
      `SELECT p.label
         FROM portal_source_bindings b
         JOIN portals p ON p.id = b.portal_row_id
        WHERE b.source_id = $1
        LIMIT 1`,
      [libraryId],
    )
    // Re-ticking the portal it already belongs to is the same state, not an error.
    if (!owner || readString(owner, 'label') !== readString(portal, 'label')) {
      throw new HttpError(
        409,
        `"${library.name}" is this portal's private library, so it cannot also go to ` +
          `${readString(portal, 'label')}. Put the files in a shared library instead.`,
        'LIBRARY_IS_PRIVATE',
      )
    }
  }

  // An archived library is one staff have decided to stop offering (§5D.5), so it
  // must not gain a NEW recipient. Existing ticks are untouched and stay readable —
  // that is what makes archiving safe to do without auditing who already has it.
  if (library.archivedAt !== null) {
    throw new HttpError(
      409,
      `"${library.name}" is archived, so it cannot be given to another portal. ` +
        'Restore it first if it should be offered again.',
      'LIBRARY_ARCHIVED',
    )
  }

  const existing = await queryOne(
    'SELECT source_id FROM portal_source_bindings WHERE portal_row_id = $1 AND source_id = $2',
    [portalRowId, libraryId],
  )

  if (!existing) {
    await insertRow(
      'portal_source_bindings',
      { org_id: orgId(), portal_row_id: portalRowId, source_id: libraryId },
      ['source_id'],
    )

    // This is the permission surface of the product: who gave what to whom, and
    // when. It must be reconstructable a year later, so the row names both sides in
    // words rather than only by id.
    await recordAudit({
      orgId: orgId(),
      actorUserId: actor.userId,
      action: 'library.granted',
      targetType: 'library',
      targetId: libraryId,
      metadata: {
        libraryName: library.name,
        portalRowId,
        portalLabel: readString(portal, 'label'),
      },
    })
  }

  return c.json({ ticked: true })
})

/**
 * Untick a portal — it stops receiving this library.
 *
 * Deletes the binding and nothing else. Every document, chunk and page survives, so
 * re-ticking restores access instantly and at no cost. That is the whole difference
 * between untick and delete, and `verify-library-rls.mjs` asserts it.
 */
libraryRoutes.delete('/:libraryId/portals/:portalRowId', async (c) => {
  const actor = await requireAdmin(c)
  const libraryId = requireUuid(c.req.param('libraryId'), 'libraryId')
  const portalRowId = requireUuid(c.req.param('portalRowId'), 'portalRowId')
  const library = await loadLibrary(libraryId)

  const portal = await queryOne('SELECT label FROM portals WHERE id = $1 AND org_id = $2', [
    portalRowId,
    orgId(),
  ])
  if (!portal) throw new HttpError(404, 'Portal not found', 'NOT_FOUND')

  const removed = await deleteRows('portal_source_bindings', [
    { column: 'portal_row_id', operator: 'eq', value: portalRowId },
    { column: 'source_id', operator: 'eq', value: libraryId },
  ])

  if (removed > 0) {
    await recordAudit({
      orgId: orgId(),
      actorUserId: actor.userId,
      action: 'library.revoked',
      targetType: 'library',
      targetId: libraryId,
      metadata: {
        libraryName: library.name,
        portalRowId,
        portalLabel: readString(portal, 'label'),
      },
    })
  }

  return c.json({ ticked: false })
})
