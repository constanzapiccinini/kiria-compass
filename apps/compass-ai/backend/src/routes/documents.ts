/**
 * Documents, scoped to the verified portal.
 *
 * No route takes a tenant identifier from the caller: the client id comes from the
 * portal context and nowhere else, and every document lookup is filtered by it. A
 * document belonging to another client is therefore a 404 on every path — not a 403,
 * which would confirm the id exists.
 *
 * Phase 4B replaces the `client_id` filter with the `portal_visible_documents` view
 * so group sources work; the shape of these handlers does not change when it does.
 */

import { Hono } from 'hono'
import { raiseAlert } from '../lib/alerts.js'
import { isOcrConfigured, orgId } from '../lib/config.js'
import { HttpError, isUuid } from '../lib/auth.js'
import {
  assertNoTenantOverride,
  resolvePortalContext,
  type PortalContext,
} from '../lib/portal.js'
import { recordAudit } from '../lib/observability.js'
import {
  query,
  queryOne,
  readBoolean,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  type SqlRow,
} from '../lib/store.js'

export const documentRoutes = new Hono()

/** Reject a caller-supplied tenant id before doing anything else. */
function guardTenancy(c: Parameters<typeof assertNoTenantOverride>[0], body?: Record<string, unknown> | null): void {
  const probe = assertNoTenantOverride(c, body)
  if (probe) {
    throw new HttpError(400, `Request carried a tenant identifier "${probe}"`, 'TENANCY_PROBE')
  }
}

interface DocumentSummary {
  id: string
  name: string
  status: string
  statusDetail: string | null
  errorMessage: string | null
  pageCount: number | null
  chunkCount: number
  sourceKind: string
  needsOcr: boolean
  ocrPagesUsed: number
  byteSize: number
  version: number
  createdAt: string
  indexedAt: string | null
  /** Null renders as the virtual "Unfiled" node, never a folder row. */
  folderId: string | null
  /**
   * The library this document belongs to, which is the sidebar's grouping key.
   *
   * Nullable in the type because the column is nullable in the schema: a document
   * that still carries a `client_id` from before §6.5 has no library. The migration
   * moved every such row, and nothing writes one any more, so in practice this is
   * always set — but a document the UI cannot place has to render somewhere rather
   * than disappear, so the type says so honestly.
   */
  libraryId: string | null
}

function toSummary(row: SqlRow): DocumentSummary {
  return {
    id: readString(row, 'id'),
    name: readString(row, 'name'),
    status: readString(row, 'status'),
    statusDetail: readOptionalString(row, 'status_detail'),
    errorMessage: readOptionalString(row, 'error_message'),
    pageCount: readOptionalNumber(row, 'page_count'),
    chunkCount: readNumber(row, 'chunk_count'),
    sourceKind: readString(row, 'source_kind'),
    needsOcr: readBoolean(row, 'needs_ocr'),
    ocrPagesUsed: readNumber(row, 'ocr_pages_used'),
    byteSize: readNumber(row, 'byte_size'),
    version: readNumber(row, 'version'),
    createdAt: readString(row, 'created_at'),
    indexedAt: readOptionalString(row, 'indexed_at'),
    folderId: readOptionalString(row, 'folder_id'),
    libraryId: readOptionalString(row, 'library_id'),
  }
}

const SUMMARY_COLUMNS = `id, name, status, status_detail, error_message, page_count, chunk_count,
  source_kind, needs_ocr, ocr_pages_used, byte_size, version, created_at, indexed_at,
  folder_id, library_id`

/**
 * Qualify a bare column list with the `d` alias, for the queries that join the
 * visibility view. Callers pass plain column names everywhere else, so this keeps
 * one list rather than two that can drift apart.
 */
function qualify(columns: string): string {
  return columns
    .split(',')
    .map((column) => `d.${column.trim()}`)
    .join(', ')
}

/** The summary list, qualified, for joined reads. */
const SUMMARY_COLUMNS_D = qualify(SUMMARY_COLUMNS)

/**
 * What a portal can see, per §6.5 — **one question, one query, both actors**.
 *
 * This used to be two queries. A client was resolved through
 * `portal_visible_documents`; an employee was resolved with `WHERE client_id = $1`,
 * so that staff inside the portal could also see rows still processing, failed, or
 * orphaned by a removed binding.
 *
 * That second query became a bug the moment libraries shipped. **A library document
 * has `client_id = NULL`** — it belongs to no tenant by design — so filtering on the
 * tenancy column hid every library document from staff, in the list and on open.
 * Measured on production for the portal that has one:
 *
 *   employee branch (client_id filter):  0 documents
 *   client branch (visibility view):     1 document
 *
 * Worse than a missing row: the chat's default scope comes from the same view, so an
 * answer would cite a library document that the sidebar did not list and the viewer
 * answered 404 for.
 *
 * §6.5 warned about exactly this and named the reason a `client_id` filter cannot
 * answer the question — a group source belongs to no single client. A library is the
 * same shape, and the warning was in a comment on the code that ignored it.
 *
 * ---------------------------------------------------------------------------
 * Why staff and clients still read differently
 *
 * The first fix collapsed both actors onto `portal_visible_documents`. That removed
 * the bug and removed something else with it: that view filters to
 * `status = 'indexed'` and not-orphaned, so a staff member who uploaded a document a
 * minute ago saw an empty sidebar with no hint that anything was happening, and a
 * document whose binding was removed became invisible to the only people who can fix
 * it.
 *
 * So the two branches are back, and this time the difference is the one that was
 * intended all along — **which rows, not which tenancy**:
 *
 * - a **client** sees `portal_visible_documents`: finished, unbroken documents only;
 * - **staff** see `portal_documents_admin`, which resolves the same libraries and
 *   sources but keeps rows that are processing, failed or orphaned, **plus** anything
 *   owned by this portal's own tenant — because a document whose source lost its
 *   binding has no row in either view, and staff can still reach it today.
 *
 * `EXISTS` rather than a join: it is a semi-join, so a portal ticked for both a
 * library and its own upload source cannot produce the row twice, and no `DISTINCT`
 * is needed to hide that.
 *
 * The tenancy predicate is a **union term, never the whole filter** — that is the
 * distinction §6.5 actually draws, and the one the unit test now checks.
 */

/**
 * Load a document that belongs to this portal's client, or 404.
 *
 * The single place a document id is resolved, so the tenancy filter cannot be
 * forgotten on one route. A foreign id is indistinguishable from a missing one.
 */
async function loadOwnedDocument(
  context: PortalContext,
  documentId: string,
  columns = SUMMARY_COLUMNS,
): Promise<SqlRow> {
  if (!isUuid(documentId)) throw new HttpError(400, 'documentId must be a UUID', 'BAD_REQUEST')

  // One statement per actor, so there is still exactly one place a document id is
  // resolved and exactly one place the scope is applied. Both reach the portal; only
  // the set of rows differs.
  const row = context.actor === 'client'
    ? await queryOne(
        `SELECT ${qualify(columns)}
           FROM documents d
           JOIN public.portal_visible_documents v ON v.document_id = d.id
          WHERE d.id = $1 AND v.portal_id = $2`,
        [documentId, context.portalId],
      )
    : await queryOne(
        `SELECT ${qualify(columns)}
           FROM documents d
          WHERE d.id = $1
            AND d.deleted_at IS NULL
            AND (d.client_id = $3
                 OR EXISTS (SELECT 1 FROM public.portal_documents_admin a
                             WHERE a.document_id = d.id AND a.portal_id = $2))`,
        [documentId, context.portalId, context.clientId],
      )

  if (!row) {
    await auditCrossTenantMiss(context, 'document', documentId)
    throw new HttpError(404, 'Document not found', 'NOT_FOUND')
  }
  return row
}

/**
 * Record an audit entry when a 404 was a *cross-tenant* attempt rather than a typo.
 *
 * §15 requires a trail for "portal A asks for portal B's document id". Auditing every
 * 404 would bury that signal in mistyped ids, so this asks the one question that
 * separates them: does the row exist under some *other* client? Only then is it a
 * denial worth recording.
 *
 * The lookup deliberately selects no data — it reads a single foreign key to decide
 * whether the id exists at all, and the caller still gets an identical 404 either way,
 * so nothing about the other tenant leaks into the response.
 *
 * Best-effort by construction: `recordAudit` never throws, and a failure to write the
 * trail must not convert a clean 404 into a 500.
 */
async function auditCrossTenantMiss(
  context: PortalContext,
  targetType: 'document' | 'chat',
  targetId: string,
): Promise<void> {
  const table = targetType === 'document' ? 'documents' : 'chats'
  const existing = await queryOne(`SELECT client_id FROM ${table} WHERE id = $1`, [
    targetId,
  ]).catch(() => null)

  // Absent everywhere: an ordinary not-found, and not worth an audit row.
  if (!existing) return

  const ownedByClientId = readOptionalString(existing, 'client_id')

  /**
   * A library document is not a cross-tenant attempt.
   *
   * `client_id IS NULL` means the row belongs to a library rather than to any tenant
   * (0013's XOR check), so asking for one this portal is not ticked for is an
   * ordinary miss — the same shape as a mistyped id. Recording it as
   * `cross_tenant_denied` would put a tenancy denial in the audit trail on every such
   * request and bury the signal §15 wants this for.
   *
   * It also **fixed a 500.** This used to build the metadata with
   * `readString(existing, 'client_id')`, which throws on NULL — and the throw escaped
   * before the 404 was raised, so requesting any library document a portal did not
   * have turned into a server error. That is why the value is read as optional and
   * the early return comes first.
   */
  if (ownedByClientId === null) return

  await recordAudit({
    orgId: orgId(),
    clientId: context.clientId,
    actorUserId: context.userId,
    action: `${targetType}.cross_tenant_denied`,
    targetType,
    targetId,
    metadata: {
      portalId: context.portalId,
      actor: context.actor,
      // The owning client is recorded because an investigator needs to know which
      // tenant was reached for; it is never sent to the caller.
      ownedByClientId,
    },
  })
}

/** List this portal's documents. Both actors; clients see only indexed ones. */
documentRoutes.get('/', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)

  const rows = context.actor === 'client'
    ? await query(
        `SELECT ${SUMMARY_COLUMNS_D}
           FROM documents d
           JOIN public.portal_visible_documents v ON v.document_id = d.id
          WHERE v.portal_id = $1
          ORDER BY d.created_at DESC`,
        [context.portalId],
      )
    : await query(
        `SELECT ${SUMMARY_COLUMNS_D}
           FROM documents d
          WHERE d.deleted_at IS NULL
            AND d.status <> 'deleted'
            AND (d.client_id = $2
                 OR EXISTS (SELECT 1 FROM public.portal_documents_admin a
                             WHERE a.document_id = d.id AND a.portal_id = $1))
          ORDER BY d.created_at DESC`,
        [context.portalId, context.clientId],
      )

  // An empty list is either "still indexing" or "nobody finished configuring this
  // portal", and only the second needs staff. Raised for whoever is looking rather
  // than only for clients: a staff member seeing an empty portal is the same signal,
  // and after §5C they see the same list. The extra query runs only when the list
  // came back empty, which is rare and already the slow-and-worrying case.
  if (rows.length === 0) {
    void warnIfPortalHasNoSources(context)
  }

  return c.json({
    documents: rows.map(toSummary),
    ocrConfigured: context.actor === 'employee' ? isOcrConfigured() : undefined,
  })
})

/**
 * Raise PORTAL_NO_SOURCE when a bound portal has nothing attached to it.
 *
 * Deliberately conditioned on the bindings, not on the document count: a portal with
 * a source whose documents are still indexing is working correctly and will fix
 * itself, and alerting on that would train staff to ignore the code. No bindings is
 * the state that never resolves on its own.
 *
 * Best-effort — the client already has their (empty) list, and this must not turn a
 * successful response into a failed one.
 */
async function warnIfPortalHasNoSources(context: PortalContext): Promise<void> {
  try {
    const row = await queryOne(
      `SELECT COUNT(*) AS bindings
         FROM portal_source_bindings b
         JOIN portals p ON p.id = b.portal_row_id
        WHERE p.portal_id = $1`,
      [context.portalId],
    )
    if (!row || Number(row.bindings) !== 0) return

    await raiseAlert({
      code: 'PORTAL_NO_SOURCE',
      clientId: context.clientId,
      dedupeExtra: context.portalId,
      cause:
        `Portal ${context.portalId} is bound to ${context.clientName} but has no sources attached, ` +
        `so its document list is empty. A viewer has just opened it and seen nothing.`,
      metadata: { portalId: context.portalId },
    })
  } catch (error) {
    console.error('[documents] failed to check portal source bindings', error)
  }
}

documentRoutes.get('/:documentId', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const row = await loadOwnedDocument(context, c.req.param('documentId'))
  return c.json({ document: toSummary(row) })
})

/**
 * Stream the PDF bytes for the viewer.
 *
 * The Gate file service `readUrl` is a public URL, so handing it to the browser
 * would let anyone with the link read the document. Proxying keeps the tenancy check
 * on the bytes themselves.
 */
documentRoutes.get('/:documentId/file', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const row = await loadOwnedDocument(
    context,
    c.req.param('documentId'),
    'name, read_url, content_type',
  )

  const readUrl = readOptionalString(row, 'read_url')
  if (!readUrl) throw new HttpError(404, 'This document has no stored file', 'NOT_FOUND')

  const upstream = await fetch(readUrl)
  if (!upstream.ok || !upstream.body) {
    throw new HttpError(
      502,
      `Could not read the stored document (upstream ${upstream.status})`,
      'UPSTREAM_UNAVAILABLE',
    )
  }

  const filename = readString(row, 'name').replace(/["\\]/g, '')
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': readOptionalString(row, 'content_type') ?? 'application/pdf',
      'content-disposition': `inline; filename="${filename}"`,
      'cache-control': 'private, max-age=3600',
    },
  })
})

/** Page text. Used by the viewer and for citation verification. */
documentRoutes.get('/:documentId/pages', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const document = await loadOwnedDocument(context, c.req.param('documentId'), 'id')

  const rows = await query(
    `SELECT page_number, text, char_count, extracted_by, ocr_confidence
       FROM document_pages WHERE document_id = $1 ORDER BY page_number ASC`,
    [readString(document, 'id')],
  )

  return c.json({
    pages: rows.map((row) => ({
      pageNumber: readNumber(row, 'page_number'),
      text: readString(row, 'text'),
      charCount: readNumber(row, 'char_count'),
      extractedBy: readString(row, 'extracted_by'),
      ocrConfidence: readOptionalNumber(row, 'ocr_confidence'),
    })),
  })
})

/** Paragraph geometry, so a citation can highlight the exact region. */
documentRoutes.get('/:documentId/paragraphs', async (c) => {
  guardTenancy(c)
  const context = await resolvePortalContext(c)
  const document = await loadOwnedDocument(context, c.req.param('documentId'), 'id')
  const documentId = readString(document, 'id')

  const pageParam = c.req.query('page')
  const params: (string | number)[] = [documentId]
  let sql = `SELECT page_number, paragraph_index, paragraph_key, text, bbox
               FROM document_paragraphs WHERE document_id = $1`
  if (pageParam !== undefined) {
    const pageNumber = Number(pageParam)
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new HttpError(400, 'page must be a positive integer', 'BAD_REQUEST')
    }
    sql += ' AND page_number = $2'
    params.push(pageNumber)
  }
  sql += ' ORDER BY page_number ASC, paragraph_index ASC'

  const rows = await query(sql, params)

  return c.json({
    paragraphs: rows.map((row) => ({
      pageNumber: readNumber(row, 'page_number'),
      paragraphIndex: readNumber(row, 'paragraph_index'),
      paragraphKey: readString(row, 'paragraph_key'),
      text: readString(row, 'text'),
      bbox: row.bbox ?? null,
    })),
  })
})
