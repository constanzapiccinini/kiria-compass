/**
 * Indexing health and repair — moved here from the client app by §5C.
 *
 * "Why is this document not searchable yet" is a staff question, and the answer
 * lives in `document_index_health` plus the job queue. The client app used to expose
 * all of this, gated by capability; §5C makes that app view + chat only, so the
 * surface moves to where the people who use it already are.
 *
 * ---------------------------------------------------------------------------
 * What moved, what did not, and why
 *
 * Moved: the snapshot, `retry-failed`, and `reindex-unsearchable`. All three are SQL
 * plus an `ingest_jobs` insert, which this backend can do — the client app's worker
 * picks the jobs up exactly as it does for an upload from this app.
 *
 * **Not moved: `POST /batches/:id/poll` and `POST /batches/:id/cancel`.** They call
 * OpenAI's Batch API, which only the client app's backend is wired to; reimplementing
 * that here would be a second integration to keep in step. Before dropping them the
 * production numbers were checked rather than assumed:
 *
 *   clients with batch embedding enabled: 0
 *   embedding batches ever created:       0
 *
 * So both endpoints have never been reachable — batch embedding is off by default
 * (`0002`) and nobody has turned it on. Meanwhile the worker already polls every
 * open batch every five minutes and sweeps orphaned polls on its own, so the manual
 * buttons were a way to wait less, not the only way to finish. Keeping unreachable
 * code that looks supported is the exact trap §5D was written to close, and if batch
 * embedding is ever switched on, the buttons come back with the screen that needs
 * them.
 *
 * Every handler takes an explicit `portalRowId`, like the rest of this app: the
 * authorization question here is "is this caller staff", answered by `requireAdmin`.
 *
 * It took a `clientId` until §6A.2, and that stopped working rather than merely
 * reading oddly. **A library document has `client_id = NULL`** — it belongs to no
 * tenant by design — so after §6.5 moved every upload into a library, a
 * client-scoped indexing screen showed zero documents, zero jobs and zero cost for a
 * portal that was busily indexing. This is the third instance of the same mistake in
 * this codebase (Phase 4's sourceless upload, Phase 5's staff document list), and
 * the invariant §6.5 draws from them is the one applied here:
 *
 *   a tenancy predicate may be a UNION term, never the whole scope.
 *
 * So each read is "this tenant's own rows, OR the rows this portal receives" — the
 * portal resolved through `portal_source_bindings`, which is what a tick is.
 *
 * ## Cost is reported in two numbers, on purpose
 *
 * A library's spend belongs to the library, not to any one portal: three portals
 * receiving it did not each pay for the embedding, it was paid once. Adding it into
 * this portal's month-to-date would show a cost that is real but not attributable
 * here, and summing the screen across portals would then over-count the month. So
 * `usageMonthToDate` stays this tenant's own, and `libraryUsageMonthToDate` is
 * reported beside it as shared.
 */

import { Hono } from 'hono'
import { orgId } from '../lib/config.js'
import { HttpError, isUuid } from '../lib/auth.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { recordAudit } from '../lib/observability.js'
import {
  insertRow,
  query,
  queryAll,
  queryOne,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  updateRows,
} from '../lib/store.js'

export const indexingRoutes = new Hono()

/**
 * The two ids every read below needs, resolved from one portal.
 *
 * `portal_id` is the platform's id and what the visibility views key on;
 * `client_id` is the tenancy key the tables carry. Both come from the same row, so
 * they cannot disagree — deriving the portal from a caller-supplied `clientId`
 * instead would be ambiguous, because one tenant may own more than one portal, and
 * production has such a tenant.
 */
interface IndexingScope {
  portalRowId: string
  portalId: string
  clientId: string
}

async function requireScope(c: Parameters<typeof requireAdmin>[0]): Promise<IndexingScope> {
  const portalRowId = c.req.query('portalRowId')
  if (!portalRowId) throw new HttpError(400, 'portalRowId is required', 'BAD_REQUEST')
  if (!isUuid(portalRowId)) throw new HttpError(400, 'portalRowId must be a UUID', 'BAD_REQUEST')

  const row = await queryOne(
    'SELECT portal_id, client_id FROM portals WHERE id = $1 AND org_id = $2',
    [portalRowId, orgId()],
  )
  if (!row) throw new HttpError(404, 'Portal not found', 'NOT_FOUND')

  return {
    portalRowId,
    portalId: readString(row, 'portal_id'),
    clientId: readString(row, 'client_id'),
  }
}

/**
 * The libraries this portal receives, as a subquery.
 *
 * A tick is a `portal_source_bindings` row and nothing else, so this is the whole
 * definition of "reaches this portal" for a library-owned row. Inlined as SQL rather
 * than fetched first: a separate read would be a second moment, and the point of the
 * batched snapshot below is that every result set comes from one.
 *
 * Takes its placeholder from the caller rather than hard-coding `$1`, because the
 * statements below each carry **only the parameters they actually reference**. That
 * is not tidiness: Postgres rejects a prepared statement with an unused parameter —
 * `could not determine data type of parameter $1` — since there is no context from
 * which to infer its type. The first version of this file passed the same three
 * arguments to every statement in the batch, and every one that did not mention
 * `$1` failed. It surfaced as a plain 500 on the indexing screen and shipped that
 * way, because nothing in the type system or the SQL text looks wrong.
 */
function tickedLibraries(placeholder: string): string {
  return `SELECT source_id FROM portal_source_bindings WHERE portal_row_id = ${placeholder}`
}


function requestMeta(headers: Headers): { ip: string | null; userAgent: string | null } {
  return {
    ip: headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: headers.get('user-agent'),
  }
}

/**
 * Everything the indexing screen needs, in one round trip.
 *
 * Deliberately one endpoint rather than four: the screen polls while work is in
 * flight, each isolated-store call pays a ~250ms floor, and the four result sets come
 * from a single transaction — so the per-document rows and the status summary can
 * never disagree mid-transition.
 */
indexingRoutes.get('/', async (c) => {
  await requireAdmin(c)
  const scope = await requireScope(c)

  const [documentRows, statusRows, jobRows, usageRows, libraryUsageRows] = await queryAll([
    {
      sql: `SELECT h.document_id, h.name, h.status, h.status_detail, h.error_message,
                   h.page_count, h.chunk_count, h.chunks_present, h.chunks_embedded,
                   h.source_kind, h.needs_ocr, h.created_at, h.indexed_at
              FROM document_index_health h
             WHERE h.client_id = $1
                OR EXISTS (SELECT 1 FROM public.portal_documents_admin a
                            WHERE a.document_id = h.document_id AND a.portal_id = $2)
             ORDER BY h.created_at DESC
             LIMIT 200`,
      params: [scope.clientId, scope.portalId],
    },
    {
      // Counts come from the whole scope, not just the 200-row window above.
      sql: `SELECT d.status, COUNT(*) AS count
              FROM documents d
             WHERE d.status <> 'deleted'
               AND (d.client_id = $1
                    OR EXISTS (SELECT 1 FROM public.portal_documents_admin a
                                WHERE a.document_id = d.id AND a.portal_id = $2))
             GROUP BY d.status`,
      params: [scope.clientId, scope.portalId],
    },
    {
      sql: `SELECT id, document_id, kind, status, attempts, max_attempts, next_run_at,
                   last_error, created_at, finished_at
              FROM ingest_jobs
             WHERE client_id = $1 OR library_id IN (${tickedLibraries('$2')})
             ORDER BY created_at DESC
             LIMIT 50`,
      params: [scope.clientId, scope.portalRowId],
    },
    {
      sql: `SELECT COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(ocr_pages), 0)     AS ocr_pages,
                   COALESCE(SUM(cost_usd), 0)      AS cost_usd
              FROM usage_events
             WHERE client_id = $1
               AND created_at >= date_trunc('month', now())`,
      params: [scope.clientId],
    },
    {
      // The libraries' own spend, kept separate: it is shared with every other portal
      // ticked to them, so folding it in here would attribute one cost to many.
      sql: `SELECT COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(ocr_pages), 0)     AS ocr_pages,
                   COALESCE(SUM(cost_usd), 0)      AS cost_usd
              FROM usage_events
             WHERE library_id IN (${tickedLibraries('$1')})
               AND created_at >= date_trunc('month', now())`,
      params: [scope.portalRowId],
    },
  ])

  const usageRow = usageRows[0]
  const libraryUsageRow = libraryUsageRows[0]

  return c.json({
    documents: documentRows.map((row) => ({
      documentId: readString(row, 'document_id'),
      name: readString(row, 'name'),
      status: readString(row, 'status'),
      statusDetail: readOptionalString(row, 'status_detail'),
      errorMessage: readOptionalString(row, 'error_message'),
      pageCount: readOptionalNumber(row, 'page_count'),
      chunkCount: readNumber(row, 'chunk_count'),
      // The pair that matters: chunks that exist versus chunks that have a vector.
      // A document with chunks and no embeddings is indexed but unsearchable, which
      // looks fine in every other screen.
      chunksPresent: readNumber(row, 'chunks_present'),
      chunksEmbedded: readNumber(row, 'chunks_embedded'),
      sourceKind: readString(row, 'source_kind'),
      createdAt: readString(row, 'created_at'),
      indexedAt: readOptionalString(row, 'indexed_at'),
    })),
    statusCounts: Object.fromEntries(
      statusRows.map((row) => [readString(row, 'status'), readNumber(row, 'count')]),
    ),
    jobs: jobRows.map((row) => ({
      id: readString(row, 'id'),
      documentId: readOptionalString(row, 'document_id'),
      kind: readString(row, 'kind'),
      status: readString(row, 'status'),
      attempts: readNumber(row, 'attempts'),
      maxAttempts: readNumber(row, 'max_attempts'),
      nextRunAt: readOptionalString(row, 'next_run_at'),
      lastError: readOptionalString(row, 'last_error'),
      createdAt: readString(row, 'created_at'),
      finishedAt: readOptionalString(row, 'finished_at'),
    })),
    usageMonthToDate: {
      inputTokens: usageRow ? readNumber(usageRow, 'input_tokens') : 0,
      outputTokens: usageRow ? readNumber(usageRow, 'output_tokens') : 0,
      ocrPages: usageRow ? readNumber(usageRow, 'ocr_pages') : 0,
      costUsd: usageRow ? readNumber(usageRow, 'cost_usd') : 0,
    },
    /** Shared with every other portal ticked to the same libraries — see the docblock. */
    libraryUsageMonthToDate: {
      inputTokens: libraryUsageRow ? readNumber(libraryUsageRow, 'input_tokens') : 0,
      outputTokens: libraryUsageRow ? readNumber(libraryUsageRow, 'output_tokens') : 0,
      ocrPages: libraryUsageRow ? readNumber(libraryUsageRow, 'ocr_pages') : 0,
      costUsd: libraryUsageRow ? readNumber(libraryUsageRow, 'cost_usd') : 0,
    },
  })
})

/**
 * Retry every failed job in this portal's scope — its own, and its libraries'.
 *
 * Resets `attempts` so an exhausted job gets a genuine fresh run — the usual reason
 * to press this is that the cause (a missing API key, an expired credential) has just
 * been fixed, and a job that has used up its attempts would otherwise never run
 * again however healthy the system now is.
 */
indexingRoutes.post('/retry-failed', async (c) => {
  const actor = await requireAdmin(c)
  const scope = await requireScope(c)

  const failed = await query(
    `SELECT id, document_id, kind FROM ingest_jobs
      WHERE status = 'failed'
        AND (client_id = $1 OR library_id IN (${tickedLibraries('$2')}))
      ORDER BY created_at ASC
      LIMIT 200`,
    [scope.clientId, scope.portalRowId],
  )

  let requeued = 0
  for (const row of failed) {
    // Filtered on `status = 'failed'` so a job the worker claimed a moment ago is
    // not yanked out from under it.
    const changed = await updateRows(
      'ingest_jobs',
      {
        status: 'queued',
        attempts: 0,
        last_error: null,
        finished_at: null,
        locked_by: null,
        next_run_at: new Date().toISOString(),
      },
      [
        { column: 'id', operator: 'eq', value: readString(row, 'id') },
        { column: 'status', operator: 'eq', value: 'failed' },
      ],
    )
    if (changed > 0) requeued += 1
  }

  // A document marked failed must go back to queued, or every screen still shows it
  // as failed while its job runs.
  const documentIds = failed
    .map((row) => readOptionalString(row, 'document_id'))
    .filter((id): id is string => id !== null)

  for (const documentId of [...new Set(documentIds)]) {
    await updateRows(
      'documents',
      { status: 'queued', status_detail: 'retry requested', error_message: null },
      [
        { column: 'id', operator: 'eq', value: documentId },
        { column: 'status', operator: 'eq', value: 'failed' },
      ],
    )
  }

  await recordAudit({
    orgId: orgId(),
    clientId: scope.clientId,
    actorUserId: actor.userId,
    action: 'indexing.retry_failed',
    targetType: 'portal',
    targetId: scope.portalRowId,
    ...requestMeta(c.req.raw.headers),
    metadata: { requeued, via: 'admin' },
  })

  return c.json({ requeued })
})

/**
 * Re-index every document that is not currently searchable.
 *
 * "Not searchable" means `chunks_embedded = 0` — the document may be `indexed` and
 * look perfectly healthy while no question can ever reach it, which is the failure
 * this button exists for.
 */
indexingRoutes.post('/reindex-unsearchable', async (c) => {
  const actor = await requireAdmin(c)
  const scope = await requireScope(c)

  const rows = await query(
    `SELECT h.document_id, d.client_id, d.library_id
       FROM document_index_health h
       JOIN documents d ON d.id = h.document_id
      WHERE h.chunks_embedded = 0
        AND (h.client_id = $1
             OR EXISTS (SELECT 1 FROM public.portal_documents_admin a
                         WHERE a.document_id = h.document_id AND a.portal_id = $2))
      ORDER BY h.created_at ASC
      LIMIT 100`,
    [scope.clientId, scope.portalId],
  )

  let enqueued = 0
  for (const row of rows) {
    const documentId = readString(row, 'document_id')
    await updateRows(
      'documents',
      { status: 'queued', status_detail: 're-index requested', error_message: null },
      [{ column: 'id', operator: 'eq', value: documentId }],
    )
    // The client app's worker drains this queue. Enqueued after the status change so
    // a claimed job never finds a document that still reads as indexed.
    //
    // The owner comes from the DOCUMENT, not from the portal's tenant. After 0013 a
    // job belongs to a tenant OR to a library, and a row with both — which is what
    // copying `scope.clientId` onto a library document would produce — violates the
    // XOR check and fails the request outright.
    await insertRow(
      'ingest_jobs',
      {
        client_id: readOptionalString(row, 'client_id'),
        library_id: readOptionalString(row, 'library_id'),
        document_id: documentId,
        kind: 'reindex',
        status: 'queued',
        payload: JSON.stringify({ userId: actor.userId }),
      },
      ['id'],
    )
    enqueued += 1
  }

  await recordAudit({
    orgId: orgId(),
    clientId: scope.clientId,
    actorUserId: actor.userId,
    action: 'indexing.reindex_unsearchable',
    targetType: 'portal',
    targetId: scope.portalRowId,
    ...requestMeta(c.req.raw.headers),
    metadata: { enqueued, via: 'admin' },
  })

  return c.json({ enqueued }, 202)
})
