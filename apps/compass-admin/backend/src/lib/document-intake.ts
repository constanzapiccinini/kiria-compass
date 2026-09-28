/**
 * Taking PDFs in, and letting them go again — for a portal's tenant or for a library.
 *
 * Lifted out of `routes/documents.ts` when §5B added libraries, because the upload
 * contract is identical and only the column the row is stamped with differs:
 * `client_id` + `source_id` for a portal's own upload, `library_id` for a library.
 *
 * **Parameterised on the owner rather than forked**, which the spec asks for by name
 * and this codebase has already paid for twice. The last forked helper —
 * `ensureAppUploadSource`, copied between the two apps — filtered on a column that
 * did not exist and shipped a 500 to production on the path nobody exercised. A
 * second copy of *this* handler would be a second place for the `%PDF` check, the
 * content-hash dedupe, the 207 contract and the purge ordering to drift, and every
 * one of those took a real bug to get right.
 *
 * Everything below is deliberately identical for both owners:
 *
 *   - **`%PDF` by content, not extension.** A renamed .docx would otherwise be
 *     stored, queued, and fail deep in the parser where the message is useless.
 *   - **Dedupe on content hash**, not filename, so the same document re-sent under a
 *     new name is not embedded twice at full cost.
 *   - **Per-file outcomes, never a 4xx for the request.** A batch where one file is a
 *     duplicate and another is a scanned image has to say which is which.
 *   - **Soft-delete first, then enqueue the purge.** Access is revoked in the same
 *     request; storage is reclaimed shortly after. If the worker never runs the
 *     document stays invisible rather than half-deleted and readable.
 */

import { createHash } from 'node:crypto'
import { orgId } from './config.js'
import { storePdf } from './files.js'
import { recordAudit } from './observability.js'
import {
  insertRow,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  updateRows,
} from './store.js'

/** Upload cap, matching the client app's. A library must not be a way around it. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * Who the incoming documents belong to.
 *
 * A closed union rather than two optional ids: "exactly one owner" is the same
 * invariant 0013 put in the database as `CHECK ((client_id IS NULL) <> (library_id IS
 * NULL))`, and expressing it the same way in the type means a handler cannot forget
 * to set either one.
 */
export type IntakeOwner =
  | { kind: 'client'; clientId: string; sourceId: string }
  | { kind: 'library'; libraryId: string }

export interface UploadOutcome {
  name: string
  documentId?: string
  status: 'queued' | 'duplicate' | 'rejected'
  message?: string
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The owner's columns, for a `documents`, `ingest_jobs` or audit row. */
function ownerColumns(owner: IntakeOwner): Record<string, string | null> {
  return owner.kind === 'client'
    ? { client_id: owner.clientId, library_id: null }
    : { client_id: null, library_id: owner.libraryId }
}

/** The tenant an audit row belongs to. A library is org-level, so there is none. */
function auditClientId(owner: IntakeOwner): string | undefined {
  return owner.kind === 'client' ? owner.clientId : undefined
}

/**
 * Store, register and queue each file. Never throws for a per-file refusal.
 *
 * Returns one outcome per input file, in order, so the caller can answer 201 when
 * everything was accepted and 207 otherwise.
 */
export async function intakeDocuments(
  files: File[],
  owner: IntakeOwner,
  actorUserId: string,
  via: string,
): Promise<UploadOutcome[]> {
  const results: UploadOutcome[] = []
  const columns = ownerColumns(owner)

  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      results.push({
        name: file.name,
        status: 'rejected',
        message: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 100 MB.`,
      })
      continue
    }

    const bytes = new Uint8Array(await file.arrayBuffer())

    // Checked before paying for storage, and by content rather than by extension.
    const header = new TextDecoder().decode(bytes.subarray(0, 5))
    if (!header.startsWith('%PDF')) {
      results.push({ name: file.name, status: 'rejected', message: 'Only PDF files are supported.' })
      continue
    }

    const contentSha256 = sha256Hex(bytes)

    // Scoped to the owner: the same PDF may legitimately exist both in a library and
    // in one portal's private uploads, and neither should hide the other.
    const duplicate =
      owner.kind === 'client'
        ? await queryOne(
            `SELECT id, name FROM documents
              WHERE client_id = $1 AND content_sha256 = $2 AND status <> 'deleted'`,
            [owner.clientId, contentSha256],
          )
        : await queryOne(
            `SELECT id, name FROM documents
              WHERE library_id = $1 AND content_sha256 = $2 AND status <> 'deleted'`,
            [owner.libraryId, contentSha256],
          )
    if (duplicate) {
      results.push({
        name: file.name,
        documentId: readString(duplicate, 'id'),
        status: 'duplicate',
        message: `Identical content is already indexed as "${readString(duplicate, 'name')}".`,
      })
      continue
    }

    const stored = await storePdf(file.name, bytes, file.type || 'application/pdf')

    const created = await insertRow(
      'documents',
      {
        ...columns,
        // For a portal's own upload this is what makes the document visible at all —
        // `portal_visible_documents` joins `source_id`. A library document is
        // resolved through `library_id` instead, so it has no source: `source_id` is
        // the sync handle, and a library is not synced.
        source_id: owner.kind === 'client' ? owner.sourceId : null,
        name: file.name,
        stored_file_uuid: stored.storedFileUUID,
        read_url: stored.readUrl,
        content_type: stored.contentType,
        content_sha256: contentSha256,
        byte_size: bytes.byteLength,
        status: 'queued',
        status_detail: 'waiting to be processed',
        uploaded_by_user_id: actorUserId,
      },
      ['id'],
    )
    if (!created) throw new Error(`Failed to register document ${file.name}`)
    const documentId = readString(created, 'id')

    // The client app's worker picks this up. Enqueued after the row exists, so a
    // claimed job always has a document to work on.
    const job = await insertRow(
      'ingest_jobs',
      {
        ...columns,
        document_id: documentId,
        kind: 'parse',
        status: 'queued',
        payload: JSON.stringify({ userId: actorUserId }),
      },
      ['id'],
    )

    await recordAudit({
      orgId: orgId(),
      clientId: auditClientId(owner),
      actorUserId,
      action: 'document.upload',
      targetType: 'document',
      targetId: documentId,
      metadata: {
        name: file.name,
        byteSize: bytes.byteLength,
        contentSha256,
        via,
        libraryId: owner.kind === 'library' ? owner.libraryId : null,
        jobId: job ? readString(job, 'id') : null,
      },
    })

    results.push({ name: file.name, documentId, status: 'queued' })
  }

  return results
}

export interface DeleteResult {
  deleted: boolean
  purgeJobId: string | null
}

/**
 * Soft-delete a document and queue its purge.
 *
 * The owner is read from the row rather than passed in, because it is the row that
 * decides which column `ingest_jobs` must carry — and getting that wrong is not a
 * cosmetic error: after 0013 an `ingest_jobs` row with neither a client nor a library
 * violates the XOR check and the delete fails outright. That is the bug this function
 * exists to make impossible, and it is exactly what the old handler would have done
 * with a library document, since it copied `client_id` unconditionally.
 */
export async function softDeleteDocument(
  documentId: string,
  actorUserId: string,
  via: string,
): Promise<DeleteResult | null> {
  const row = await queryOne(
    `SELECT client_id, library_id, name, chunk_count, stored_file_uuid
       FROM documents WHERE id = $1`,
    [documentId],
  )
  if (!row) return null

  const clientId = readOptionalString(row, 'client_id')
  const libraryId = readOptionalString(row, 'library_id')

  const updated = await updateRows(
    'documents',
    { deleted_at: new Date().toISOString(), status: 'deleted', status_detail: null },
    [
      { column: 'id', operator: 'eq', value: documentId },
      // Filtered on "not already deleted" so a repeated call is a no-op rather than
      // moving the timestamp and losing when access was actually revoked.
      { column: 'deleted_at', operator: 'is_null' },
    ],
  )

  const job = await insertRow(
    'ingest_jobs',
    {
      client_id: clientId,
      library_id: libraryId,
      document_id: documentId,
      kind: 'delete',
      status: 'queued',
      payload: JSON.stringify({ userId: actorUserId }),
    },
    ['id'],
  )
  const purgeJobId = job ? readString(job, 'id') : null

  await recordAudit({
    orgId: orgId(),
    clientId: clientId ?? undefined,
    actorUserId,
    action: 'document.delete',
    targetType: 'document',
    targetId: documentId,
    metadata: {
      name: readString(row, 'name'),
      chunksToRemove: readNumber(row, 'chunk_count'),
      storedFileUUID: readOptionalString(row, 'stored_file_uuid'),
      alreadyDeleted: updated === 0,
      via,
      libraryId,
      jobId: purgeJobId,
    },
  })

  return { deleted: true, purgeJobId }
}
