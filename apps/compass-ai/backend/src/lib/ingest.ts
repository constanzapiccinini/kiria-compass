/**
 * Ingestion pipeline: parse -> (OCR) -> chunk -> embed -> index.
 *
 * Work runs through the `ingest_jobs` queue rather than inline in the upload request,
 * because a long document easily exceeds the platform's 30s request ceiling. Jobs are
 * claimed with a compare-and-set update so several backend replicas can drain the
 * queue without processing the same document twice.
 */

import { raiseAlert, retryFailedDeliveries } from './alerts.js'
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './config.js'
import { chunkParagraphs, estimateTokens, type Chunk } from './chunk.js'
import { fetchStoredPdf } from './files.js'
import { createEmbeddings, OpenAiError } from './openai.js'
import { extractPdf, type ExtractedPage, type ExtractedParagraph } from './pdf.js'
import { OcrNotConfiguredError, ocrPdf } from './textract.js'
import { getIngestSettings } from './settings.js'
import { orgOwner, ownerColumns, type RowOwner } from './owner.js'
import {
  listOpenBatches,
  pollBatch,
  shouldUseBatch,
  submitDocumentBatch,
} from './batch-embedding.js'
import { logStep, monthToDateUsage, recordTrace, recordUsage } from './observability.js'
import {
  batchInsertRows,
  deleteRows,
  insertRow,
  query,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  updateRows,
} from './store.js'
import { createHash, randomUUID } from 'node:crypto'

/** How many chunks are embedded per OpenAI request. */
const EMBED_BATCH_SIZE = 96
/** Rows per structured insert call, kept well under the Gate JSON payload comfort zone. */
const CHUNK_INSERT_BATCH = 40

export type DocumentStatus =
  | 'queued'
  | 'uploading'
  | 'ocr'
  | 'parsed'
  | 'embedding'
  | 'indexed'
  | 'failed'
  | 'deleted'

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function setDocumentStatus(
  documentId: string,
  status: DocumentStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await updateRows('documents', { status, ...extra }, [
    { column: 'id', operator: 'eq', value: documentId },
  ])
}

/** How long to wait between polls of an open OpenAI batch. */
const BATCH_POLL_INTERVAL_MS = 5 * 60 * 1000
/** How often the worker looks for batches whose poll job was lost. */
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60 * 1000
/**
 * A running job whose lock is older than this is treated as abandoned. Textract OCR
 * has its own 10-minute ceiling, so this sits comfortably above the longest real run.
 */
const STALE_LOCK_MS = 20 * 60 * 1000

/** Enqueue a pipeline job, optionally deferred. */
export async function enqueueJob(
  owner: RowOwner,
  documentId: string | null,
  kind:
    | 'parse'
    | 'ocr'
    | 'embed'
    | 'reindex'
    | 'delete'
    | 'embed_batch_poll'
    | 'insight_embed'
    | 'insight_purge'
    | 'insight_cluster'
    | 'insight_flag',
  payload: Record<string, unknown> = {},
  delayMs = 0,
): Promise<string> {
  const row = await insertRow(
    'ingest_jobs',
    {
      ...ownerColumns(owner),
      document_id: documentId,
      kind,
      status: 'queued',
      payload: JSON.stringify(payload),
      ...(delayMs > 0
        ? { next_run_at: new Date(Date.now() + delayMs).toISOString() }
        : {}),
    },
    ['id'],
  )
  if (!row) throw new Error('Failed to enqueue ingest job')
  const jobId = readString(row, 'id')
  logStep('ingest.enqueued', { jobId, kind, documentId, ...owner })
  return jobId
}

// ---------------------------------------------------------------------------
// the pipeline itself
// ---------------------------------------------------------------------------

interface DocumentRecord {
  id: string
  /**
   * The owning tenant, or null for a library document (§5B).
   *
   * Nullable rather than a sentinel, and the type is what enforces the rest: every
   * place in this pipeline that writes a derived row had to be looked at again, and
   * TypeScript refused to compile until each one said what it does without a tenant.
   */
  clientId: string | null
  /** The owning library, or null for a tenant's document. Exactly one is set. */
  libraryId: string | null
  name: string
  readUrl: string | null
  pageCount: number | null
}

async function loadDocument(documentId: string): Promise<DocumentRecord | null> {
  const row = await queryOne(
    'SELECT id, client_id, library_id, name, read_url, page_count FROM documents WHERE id = $1',
    [documentId],
  )
  if (!row) return null
  return {
    id: readString(row, 'id'),
    clientId: readOptionalString(row, 'client_id'),
    libraryId: readOptionalString(row, 'library_id'),
    name: readString(row, 'name'),
    readUrl: readOptionalString(row, 'read_url'),
    pageCount: row.page_count === null ? null : readNumber(row, 'page_count'),
  }
}

/** Remove previously extracted content so a re-index starts from a clean slate. */
/**
 * Drop everything derived from a document — chunks, paragraphs, pages — and keep the
 * document row itself.
 *
 * Exported because the source sync needs exactly this and nothing more. Reaching for
 * `purgeDocument` there was a data-destroying mistake: it deletes the `documents` row,
 * so a row vanishing from a source table for one run — a filter typo, a transient
 * empty read — permanently destroyed the document instead of hiding it, which §6.3.4
 * explicitly forbids.
 */
export async function clearExtraction(documentId: string): Promise<void> {
  const filter = [{ column: 'document_id', operator: 'eq' as const, value: documentId }]
  await deleteRows('document_chunks', filter)
  await deleteRows('document_paragraphs', filter)
  await deleteRows('document_pages', filter)
}

async function persistPages(
  document: DocumentRecord,
  pages: ExtractedPage[],
  extractedBy: 'pdf_text' | 'textract',
  confidence: Map<number, number> | null,
): Promise<void> {
  await batchInsertRows(
    'document_pages',
    pages.map((page) => ({
      document_id: document.id,
      // Denormalized so the RLS policy can scope this table directly instead of
      // reaching documents through an EXISTS that is itself evaluated under RLS.
      ...ownerColumns(document),
      page_number: page.pageNumber,
      text: page.text,
      char_count: page.charCount,
      extracted_by: extractedBy,
      ocr_confidence: confidence?.get(page.pageNumber) ?? null,
    })),
  )
}

async function persistParagraphs(
  document: DocumentRecord,
  paragraphs: ExtractedParagraph[],
): Promise<void> {
  await batchInsertRows(
    'document_paragraphs',
    paragraphs.map((paragraph) => ({
      document_id: document.id,
      ...ownerColumns(document),
      page_number: paragraph.pageNumber,
      paragraph_index: paragraph.paragraphIndex,
      paragraph_key: paragraph.paragraphKey,
      text: paragraph.text,
      bbox: JSON.stringify(paragraph.bbox),
    })),
  )
}

/**
 * Embed chunks and insert them with their vectors.
 *
 * The structured row API binds `double precision[]` and `text[]` natively (verified
 * against the live store), so the whole write path stays on `isolated_store.data.write`
 * and the backend never needs the privileged `isolated_store.execute` escape hatch.
 * Embeddings arrive unit-normalized from `createEmbeddings`.
 */
async function embedAndInsertChunks(
  document: DocumentRecord,
  chunks: Chunk[],
): Promise<{ inserted: number; embeddingInputTokens: number }> {
  let embeddingInputTokens = 0
  let inserted = 0

  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE)
    const embedding = await createEmbeddings(batch.map((chunk) => chunk.text))
    embeddingInputTokens += embedding.usage.inputTokens

    const rows = batch.map((chunk, index) => ({
      ...ownerColumns(document),
      document_id: document.id,
      chunk_index: chunk.chunkIndex,
      page_number: chunk.pageNumber,
      page_start: chunk.pageStart,
      page_end: chunk.pageEnd,
      paragraph_key: chunk.paragraphKey,
      paragraph_keys: chunk.paragraphKeys,
      section_title: chunk.sectionTitle,
      text: chunk.text,
      token_count: chunk.tokenCount,
      content_sha256: createHash('sha256').update(chunk.text).digest('hex'),
      embedding: embedding.vectors[index] ?? [],
      embedding_model: EMBEDDING_MODEL,
      embedding_dims: EMBEDDING_DIMENSIONS,
    }))

    // Each chunk row carries a 256-float vector plus its text, so keep request
    // bodies modest: the Gate JSON path is reliable around ~100-150 KB, which is
    // far more restrictive than the Postgres bind-parameter limit.
    for (let start = 0; start < rows.length; start += CHUNK_INSERT_BATCH) {
      inserted += await batchInsertRows(
        'document_chunks',
        rows.slice(start, start + CHUNK_INSERT_BATCH),
      )
    }
  }

  return { inserted, embeddingInputTokens }
}

/**
 * Record how long an ingest took, wherever it can be recorded.
 *
 * `rag_traces` stays tenant-scoped: its `client_id` is NOT NULL and 0013
 * deliberately gave it no `library_id`, because a trace records what one asker's
 * question did and that table's NOT NULL is what protects the retrieval rows. A
 * library document has no asker and no tenant, so there is no row to write — the
 * timing goes to the structured log instead, which is where the rest of the
 * pipeline's timings are already greppable.
 *
 * Both arms of the pipeline call this, so neither can quietly stop tracing.
 */
async function traceIngest(
  document: DocumentRecord,
  durationMs: number,
  detail: Record<string, unknown>,
): Promise<void> {
  if (document.clientId === null) {
    logStep('ingest.library_complete', { libraryId: document.libraryId, durationMs, ...detail })
    return
  }
  await recordTrace({ clientId: document.clientId, step: 'ingest', durationMs, detail })
}

export interface IngestResult {
  status: DocumentStatus
  pageCount: number
  chunkCount: number
  sourceKind: 'native' | 'ocr'
  ocrPages: number
}

/**
 * Run the full pipeline for one document. Idempotent: re-running clears previously
 * extracted rows first, so a retry after a partial failure cannot duplicate chunks.
 */
export async function ingestDocument(documentId: string, userId: string | null): Promise<IngestResult> {
  const document = await loadDocument(documentId)
  if (!document) throw new Error(`Document ${documentId} not found`)
  if (!document.readUrl) throw new Error(`Document ${documentId} has no stored file`)

  const settings = await getIngestSettings(document.clientId)
  const pipelineStart = Date.now()

  await clearExtraction(documentId)
  await setDocumentStatus(documentId, 'queued', { error_message: null, status_detail: 'downloading' })

  const bytes = await fetchStoredPdf(document.readUrl)

  // --- parse -------------------------------------------------------------
  await setDocumentStatus(documentId, 'queued', { status_detail: 'extracting text' })
  const native = await extractPdf(bytes)

  let pages = native.pages
  let paragraphs = native.paragraphs
  let pageCount = native.pageCount
  let sourceKind: 'native' | 'ocr' = 'native'
  let ocrPages = 0
  let confidence: Map<number, number> | null = null

  // --- OCR when there is no usable text layer -----------------------------
  if (native.needsOcr) {
    if (native.pageCount > settings.maxOcrPagesPerUpload) {
      await setDocumentStatus(documentId, 'failed', {
        needs_ocr: true,
        page_count: native.pageCount,
        error_message:
          `This document needs OCR for ${native.pageCount} pages, which exceeds the client ` +
          `limit of ${settings.maxOcrPagesPerUpload}. An admin can raise the limit in client settings.`,
      })
      throw new Error('OCR page cap exceeded')
    }

    // Only a tenant has a monthly budget to check, and only when one is set. The
    // query is inside the guard rather than before it so a library parse does not
    // pay for a lookup whose answer cannot apply to it — `monthlyOcrPageBudget` is
    // null for a library by construction (see LIBRARY_INGEST_SETTINGS), because a
    // per-tenant budget cannot be charged to a document many portals share.
    const usage =
      document.clientId !== null && settings.monthlyOcrPageBudget !== null
        ? await monthToDateUsage(document.clientId)
        : null
    if (
      usage !== null &&
      settings.monthlyOcrPageBudget !== null &&
      usage.ocrPages + native.pageCount > settings.monthlyOcrPageBudget
    ) {
      await setDocumentStatus(documentId, 'failed', {
        needs_ocr: true,
        page_count: native.pageCount,
        error_message:
          `The client monthly OCR budget (${settings.monthlyOcrPageBudget} pages) would be exceeded. ` +
          'Upload is paused until an admin raises the budget.',
      })
      throw new Error('OCR budget exceeded')
    }

    await setDocumentStatus(documentId, 'ocr', { needs_ocr: true, status_detail: 'running OCR' })

    try {
      const ocr = await ocrPdf(bytes, documentId)
      pages = ocr.pages
      paragraphs = ocr.paragraphs
      pageCount = ocr.pageCount
      confidence = ocr.pageConfidence
      ocrPages = ocr.billedPages
      sourceKind = 'ocr'

      await recordUsage({
        clientId: document.clientId,
        libraryId: document.libraryId,
        userId,
        kind: 'ocr',
        model: 'textract:detect-document-text',
        ocrPages,
        documentId,
      })
    } catch (error) {
      const message =
        error instanceof OcrNotConfiguredError
          ? error.message
          : `OCR failed: ${error instanceof Error ? error.message : String(error)}`
      await setDocumentStatus(documentId, 'failed', {
        needs_ocr: true,
        page_count: native.pageCount,
        error_message: message,
      })
      throw error
    }
  }

  await persistPages(
    document,
    pages,
    sourceKind === 'ocr' ? 'textract' : 'pdf_text',
    confidence,
  )
  await persistParagraphs(document, paragraphs)
  await setDocumentStatus(documentId, 'parsed', {
    page_count: pageCount,
    source_kind: sourceKind,
    needs_ocr: sourceKind === 'ocr',
    ocr_pages_used: ocrPages,
    status_detail:
      native.emptyPageCount > 0 && sourceKind === 'native'
        ? `${pages.length} pages, ${paragraphs.length} paragraphs ` +
          `(${native.emptyPageCount} page(s) had no text layer and were indexed as empty)`
        : `${pages.length} pages, ${paragraphs.length} paragraphs`,
  })

  // --- chunk + embed ------------------------------------------------------
  const chunks = chunkParagraphs(paragraphs)
  if (chunks.length === 0) {
    await setDocumentStatus(documentId, 'failed', {
      error_message:
        'No readable text could be extracted from this document, so there is nothing to index.',
    })
    throw new Error('No extractable text')
  }

  // --- bulk path: hand the chunks to the OpenAI Batch API and stop here ---------
  if (
    shouldUseBatch(
      settings.batchEmbeddingEnabled,
      settings.batchEmbeddingMinChunks,
      chunks.length,
    )
  ) {
    await setDocumentStatus(documentId, 'embedding', {
      status_detail: `submitting ${chunks.length} chunks for bulk embedding`,
    })

    const submitted = await submitDocumentBatch(document, documentId, chunks)

    await setDocumentStatus(documentId, 'embedding', {
      chunk_count: submitted.chunkCount,
      status_detail:
        `bulk embedding ${submitted.chunkCount} chunks (batch ${submitted.providerBatchId}) — ` +
        'this can take up to 24 hours',
    })

    // The poll job carries the batch id; the document settles when the batch ends.
    await enqueueJob(document, documentId, 'embed_batch_poll', {
      userId,
      batchId: submitted.batchId,
    })

    await traceIngest(document, Date.now() - pipelineStart, {
      documentId,
      pageCount,
      chunkCount: submitted.chunkCount,
      sourceKind,
      ocrPages,
      embedding: 'batch',
      providerBatchId: submitted.providerBatchId,
    })

    // Not `indexed`: the vectors are not in yet, so the document must not become
    // searchable or be reported as ready.
    return {
      status: 'embedding',
      pageCount,
      chunkCount: submitted.chunkCount,
      sourceKind,
      ocrPages,
    }
  }

  await setDocumentStatus(documentId, 'embedding', {
    status_detail: `embedding ${chunks.length} chunks`,
  })

  const { inserted, embeddingInputTokens } = await embedAndInsertChunks(document, chunks)

  await recordUsage({
    clientId: document.clientId,
    libraryId: document.libraryId,
    userId,
    kind: 'embedding',
    model: EMBEDDING_MODEL,
    inputTokens: embeddingInputTokens,
    documentId,
    metadata: { chunks: inserted, dimensions: EMBEDDING_DIMENSIONS },
  })

  await setDocumentStatus(documentId, 'indexed', {
    chunk_count: inserted,
    indexed_at: new Date().toISOString(),
    status_detail: null,
    error_message: null,
  })

  await traceIngest(document, Date.now() - pipelineStart, {
    documentId,
    pageCount,
    chunkCount: inserted,
    sourceKind,
    ocrPages,
    estimatedTokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
  })

  return { status: 'indexed', pageCount, chunkCount: inserted, sourceKind, ocrPages }
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`

interface ClaimedJob extends RowOwner {
  id: string
  documentId: string | null
  kind: string
  attempts: number
  maxAttempts: number
  userId: string | null
  /** Set on embed_batch_poll jobs. */
  batchId: string | null
}

/**
 * Claim one due job. The UPDATE is filtered on `status = 'queued'`, so only one
 * replica can win a given row even without an advisory lock.
 */
async function claimNextJob(): Promise<ClaimedJob | null> {
  const candidates = await query(
    `SELECT id, client_id, library_id, document_id, kind, attempts, max_attempts, payload
       FROM ingest_jobs
      WHERE status = 'queued' AND next_run_at <= now()
      ORDER BY created_at ASC
      LIMIT 5`,
  )

  for (const row of candidates) {
    const jobId = readString(row, 'id')
    const claimed = await updateRows(
      'ingest_jobs',
      { status: 'running', locked_by: WORKER_ID, locked_at: new Date().toISOString() },
      [
        { column: 'id', operator: 'eq', value: jobId },
        { column: 'status', operator: 'eq', value: 'queued' },
      ],
    )
    if (claimed === 0) continue // another replica took it

    const payload = row.payload
    let payloadUserId: string | null = null
    let payloadBatchId: string | null = null
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const fields = payload as Record<string, unknown>
      if (typeof fields.userId === 'string') payloadUserId = fields.userId
      if (typeof fields.batchId === 'string') payloadBatchId = fields.batchId
    }

    return {
      id: jobId,
      clientId: readOptionalString(row, 'client_id'),
      libraryId: readOptionalString(row, 'library_id'),
      documentId: readOptionalString(row, 'document_id'),
      kind: readString(row, 'kind'),
      attempts: readNumber(row, 'attempts'),
      maxAttempts: readNumber(row, 'max_attempts'),
      userId: payloadUserId,
      batchId: payloadBatchId,
    }
  }

  return null
}

async function finishJob(job: ClaimedJob): Promise<void> {
  await updateRows(
    'ingest_jobs',
    {
      status: 'succeeded',
      attempts: job.attempts + 1,
      finished_at: new Date().toISOString(),
      locked_by: null,
      last_error: null,
    },
    [{ column: 'id', operator: 'eq', value: job.id }],
  )
}

/**
 * Fail a job. Transient failures (OCR/embedding outage) are re-queued with
 * exponential backoff until `max_attempts`; a document is only marked failed once
 * retries are exhausted, so a temporary API outage does not look permanent.
 */
async function failJob(job: ClaimedJob, error: unknown): Promise<void> {
  const attempts = job.attempts + 1
  const message = error instanceof Error ? error.message : String(error)
  const permanent =
    error instanceof OcrNotConfiguredError ||
    (error instanceof OpenAiError && error.quotaExhausted)
  const willRetry = !permanent && attempts < job.maxAttempts

  if (willRetry) {
    const delaySeconds = Math.min(600, 30 * 2 ** (attempts - 1))
    await updateRows(
      'ingest_jobs',
      {
        status: 'queued',
        attempts,
        last_error: message.slice(0, 2000),
        locked_by: null,
        next_run_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      },
      [{ column: 'id', operator: 'eq', value: job.id }],
    )
    if (job.documentId) {
      await setDocumentStatus(job.documentId, 'queued', {
        status_detail: `retrying in ${delaySeconds}s (attempt ${attempts} of ${job.maxAttempts})`,
      })
    }
  } else {
    await updateRows(
      'ingest_jobs',
      {
        status: 'failed',
        attempts,
        last_error: message.slice(0, 2000),
        locked_by: null,
        finished_at: new Date().toISOString(),
      },
      [{ column: 'id', operator: 'eq', value: job.id }],
    )
    if (job.documentId) {
      // ingestDocument already wrote a specific message for known failures.
      await updateRows(
        'documents',
        { status: 'failed', error_message: message.slice(0, 2000), status_detail: null },
        [
          { column: 'id', operator: 'eq', value: job.documentId },
          { column: 'status', operator: 'ne', value: 'failed' },
        ],
      )
    }
  }

  logStep('ingest.job_failed', { jobId: job.id, attempts, willRetry, error: message })

  // Raised only once the job is truly done retrying (§10: a silent retry is allowed
  // while attempts remain). Alerting on the first transient OCR blip would notify
  // staff about something that fixes itself 30 seconds later, and that is how an
  // alert channel gets muted.
  if (!willRetry && job.documentId) await raiseDocumentFailure(job, message, error)
}

/**
 * Alert on a document that will not index.
 *
 * OCR and embedding are separated because the fixes have nothing in common: one is
 * the file, Textract or the page budget; the other is the OpenAI key or its credit.
 * A single "ingestion failed" alert would send whoever reads it to the wrong screen
 * half the time.
 */
async function raiseDocumentFailure(
  job: ClaimedJob,
  message: string,
  error: unknown,
): Promise<void> {
  const isEmbedding = error instanceof OpenAiError || job.kind === 'embed'
  const permanentQuota = error instanceof OpenAiError && error.quotaExhausted

  // Best-effort: the document name is what makes the alert legible, but not having it
  // must not cost us the alert.
  const row = await queryOne('SELECT name FROM documents WHERE id = $1', [job.documentId]).catch(
    () => null,
  )
  const name = (row && readOptionalString(row, 'name')) ?? job.documentId

  await raiseAlert({
    code: isEmbedding ? 'DOC_EMBED_FAILED' : 'DOC_OCR_FAILED',
    clientId: job.clientId,
    documentId: job.documentId,
    cause:
      `"${name}" failed after ${job.maxAttempts} attempts on the ${job.kind} step: ${message}` +
      (permanentQuota
        ? ' The OpenAI account is out of credit, which will not clear by retrying.'
        : ''),
    metadata: { jobId: job.id, kind: job.kind, attempts: job.maxAttempts, error: message.slice(0, 500) },
  })
}

/**
 * Return jobs abandoned mid-run to the queue.
 *
 * A job is claimed by flipping it to `running` with a `locked_at` stamp. If that
 * replica then disappears — a `fusebase deploy` rolls the backend, or the container
 * is recycled — nothing ever finishes the job, and its document sits in `queued` or
 * `embedding` forever. Reclaiming on a lock older than the longest plausible run is
 * what makes the queue survive a deploy.
 *
 * `attempts` is not incremented: the job never got a fair run, so charging it an
 * attempt would burn the retry budget on an infrastructure event.
 */
export async function reclaimStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString()

  const stale = await query(
    `SELECT id, kind, document_id, locked_by
       FROM ingest_jobs
      WHERE status = 'running' AND locked_at < $1
      ORDER BY locked_at ASC
      LIMIT 50`,
    [cutoff],
  )
  if (stale.length === 0) return 0

  let reclaimed = 0
  for (const row of stale) {
    const jobId = readString(row, 'id')
    const changed = await updateRows(
      'ingest_jobs',
      {
        status: 'queued',
        locked_by: null,
        locked_at: null,
        next_run_at: new Date().toISOString(),
        last_error: 'Reclaimed after the worker holding this job stopped responding',
      },
      [
        { column: 'id', operator: 'eq', value: jobId },
        // Guard against a race with a worker that is genuinely still alive.
        { column: 'status', operator: 'eq', value: 'running' },
      ],
    )
    if (changed === 0) continue
    reclaimed += 1

    logStep('ingest.job_reclaimed', {
      jobId,
      kind: readString(row, 'kind'),
      documentId: readOptionalString(row, 'document_id'),
      previousWorker: readOptionalString(row, 'locked_by'),
    })
  }

  return reclaimed
}

/**
 * Re-queue polls for open batches that have no poll job left.
 *
 * A batch outlives any single backend replica — it can run for 24 hours — so if the
 * replica holding its poll job is recycled mid-run the batch would otherwise sit
 * open forever and its documents would never leave `embedding`.
 */
export async function requeueOrphanedBatches(): Promise<number> {
  const open = await listOpenBatches()
  if (open.length === 0) return 0

  let requeued = 0
  for (const batch of open) {
    const pending = await queryOne(
      `SELECT 1 AS present
         FROM ingest_jobs
        WHERE kind = 'embed_batch_poll'
          AND status IN ('queued', 'running')
          AND payload->>'batchId' = $1`,
      [batch.id],
    )
    if (pending) continue

    await enqueueJob(
      batch,
      batch.documentIds[0] ?? null,
      'embed_batch_poll',
      { batchId: batch.id },
      BATCH_POLL_INTERVAL_MS,
    )
    requeued += 1
    logStep('batch.poll_requeued', { batchId: batch.id, providerBatchId: batch.providerBatchId })
  }
  return requeued
}

/** Process one job if any is due. Returns true when work was done. */
export async function drainOnce(): Promise<boolean> {
  const job = await claimNextJob()
  if (!job) return false

  logStep('ingest.job_started', { jobId: job.id, kind: job.kind, documentId: job.documentId })

  try {
    if (job.kind === 'parse' || job.kind === 'reindex' || job.kind === 'embed' || job.kind === 'ocr') {
      if (!job.documentId) throw new Error(`Job ${job.id} of kind ${job.kind} has no documentId`)
      await ingestDocument(job.documentId, job.userId)
    } else if (job.kind === 'delete') {
      if (job.documentId) await purgeDocument(job.documentId)
    } else if (job.kind === 'embed_batch_poll') {
      if (!job.batchId) throw new Error(`Job ${job.id} has no batchId`)
      const outcome = await pollBatch(job.batchId)

      // An OpenAI batch can legitimately take up to 24 hours, so a still-open batch
      // is not a failure: re-queue the poll on a slow cadence and finish this job.
      // Using a fresh job (rather than the retry path) keeps `attempts` meaningful
      // for real errors.
      if (outcome.stillOpen) {
        await enqueueJob(
          job,
          job.documentId,
          'embed_batch_poll',
          { userId: job.userId, batchId: job.batchId },
          BATCH_POLL_INTERVAL_MS,
        )
      }
    } else if (
      job.kind === 'insight_embed' ||
      job.kind === 'insight_purge' ||
      job.kind === 'insight_cluster' ||
      job.kind === 'insight_flag'
    ) {
      // Phase 8 §5: the analysis runs in this worker, because this is where the
      // queue, the cron and the OpenAI client already are. `compass-insights` reads
      // and manages queues and holds no pipeline code — that is what keeps a third
      // app from becoming a third copy of helpers that have already caused two
      // production incidents here.
      //
      // Dynamic import for the same reason as the branches above: `insights.ts`
      // reaches back into `alerts.ts`, which reaches into this module.
      const {
        runInsightEmbed,
        runInsightPurge,
        runInsightCluster,
        runInsightFlag,
        withInsightRun,
      } = await import('./insights.js')
      if (job.kind === 'insight_embed') {
        await withInsightRun('embed', runInsightEmbed)
      } else if (job.kind === 'insight_cluster') {
        await withInsightRun('cluster', runInsightCluster)
      } else if (job.kind === 'insight_flag') {
        await withInsightRun('flag', runInsightFlag)
      } else {
        await withInsightRun('purge', runInsightPurge)
      }
    } else {
      throw new Error(`Unknown job kind ${job.kind}`)
    }
    await finishJob(job)
    logStep('ingest.job_succeeded', { jobId: job.id, kind: job.kind })
  } catch (error) {
    await failJob(job, error)
  }

  return true
}

/**
 * Enqueue the daily insight jobs, at most one of each in flight.
 *
 * The guard is a query rather than a timer, and that is the whole point: a timer lives
 * in one replica's memory, and this backend runs up to three. Two replicas sweeping
 * within the same minute would each enqueue an embed run, and both would then embed
 * the same questions — the `question_embeddings` primary key would refuse the second
 * write, so the cost is a failed run and a spurious alert rather than duplicate data,
 * but a spurious alert that recurs nightly is how an alert inbox stops being read.
 *
 * "Recent" is measured against the last row of that kind in `insight_runs`, which is
 * shared state, so all three replicas agree. The cadence therefore lives in the SQL
 * interval below and nowhere else — a `const INSIGHT_INTERVAL_MS` was written here
 * first and deleted: a constant that looks like it sets the schedule while the query
 * actually sets it is the kind of thing someone later edits expecting an effect.
 *
 * Both jobs carry no owner, because they are org-wide. That needed a schema change
 * rather than an assumption: 0013's XOR check **is** on `ingest_jobs`, so a row with
 * neither a client nor a library was refused outright — checked rather than assumed,
 * after this comment first claimed the opposite. 0022 names the two kinds as the
 * exemption, and `orgOwner` is how a caller says so.
 */
async function enqueueInsightJobs(): Promise<void> {
  for (const [kind, runKind] of [
    // Order matters: clustering reads what embedding wrote. Enqueued in this order and
    // drained in it, so a cluster run never operates on a set the embed run of the same
    // sweep was about to extend — which would report a question count that was already
    // stale when it was written.
    ['insight_embed', 'embed'],
    ['insight_cluster', 'cluster'],
    // Screening is independent of the other two — it reads message text, not vectors —
    // but it goes last so a slow model call cannot delay the embedding that clustering
    // depends on.
    ['insight_flag', 'flag'],
    ['insight_purge', 'purge'],
  ] as const) {
    // Filtered on **succeeded**, which the first production sweep proved is the
    // distinction that matters. The first version looked at any recent run, so the
    // failed embed run it produced would have blocked every retry for twenty hours —
    // a broken job that reports itself once and then goes quiet until tomorrow.
    //
    // A failure is instead held off for an hour: long enough that a persistent one
    // does not churn every ten minutes with the sweep, short enough that a fix
    // deployed now is exercised within the hour rather than overnight.
    const recent = await queryOne(
      `SELECT id FROM insight_runs
        WHERE kind = $1
          AND ((status = 'succeeded' AND started_at > now() - INTERVAL '20 hours')
               OR (status <> 'succeeded' AND started_at > now() - INTERVAL '1 hour'))
        LIMIT 1`,
      [runKind],
    )
    if (recent) continue

    const queued = await queryOne(
      `SELECT id FROM ingest_jobs
        WHERE kind = $1 AND status IN ('queued', 'running')
        LIMIT 1`,
      [kind],
    )
    if (queued) continue

    await enqueueJob(orgOwner, null, kind, {})
    logStep('insight.enqueued', { kind })
  }
}

/**
 * Hard-delete a document and everything derived from it. Chunks, paragraphs and
 * pages cascade from the row, so the index cannot outlive the document.
 */
export async function purgeDocument(documentId: string): Promise<void> {
  await deleteRows('documents', [{ column: 'id', operator: 'eq', value: documentId }])
  logStep('ingest.document_purged', { documentId })
}

let workerTimer: NodeJS.Timeout | null = null
let workerRunning = false

/**
 * Start the in-process queue worker. Idle polling is cheap (one indexed query), and a
 * cron job drains anything left behind if every replica is recycled mid-job.
 */
export function startWorker(intervalMs = 3000): void {
  if (workerTimer) return

  let lastOrphanSweep = 0

  const tick = async (): Promise<void> => {
    if (workerRunning) return
    workerRunning = true
    try {
      // Keep draining while there is work, so a burst upload is not paced by the timer.
      let processed = 0
      while (processed < 10 && (await drainOnce())) processed += 1

      // Sweep for batches whose poll job vanished with a recycled replica. Far less
      // often than the drain — it is a safety net, and each sweep costs a query per
      // open batch.
      if (Date.now() - lastOrphanSweep > ORPHAN_SWEEP_INTERVAL_MS) {
        lastOrphanSweep = Date.now()
        await reclaimStaleJobs()
        await requeueOrphanedBatches()

        // Portal state alerts (§6A.4). The admin app's reconcile decides which
        // portals are missing; the alert engine lives here, so this is where the
        // raising happens. Reading state rather than reacting to an event means an
        // alert is not lost when this worker was down at the moment the reconcile
        // ran — the row is still `missing` on the next sweep.
        const { sweepPortalAlerts } = await import('./portal-alerts.js')
        await sweepPortalAlerts()

        // Phase 8 §5/§6: the two analysis jobs, enqueued rather than run inline.
        // Going through the queue rather than calling them here is deliberate — they
        // then get the same claim, retry, backoff and `ingest_jobs` visibility as
        // every other job, and a slow embed run cannot hold up this sweep.
        await enqueueInsightJobs()

        // Retry alert emails that did not go out. On the sweep rather than in the
        // raise path on purpose: a mail outage must never slow down or fail the
        // pipeline whose failure the alert is about.
        await retryFailedDeliveries()
      }
    } catch (error) {
      console.error('[ingest] worker tick failed', error)
    } finally {
      workerRunning = false
    }
  }

  workerTimer = setInterval(() => {
    void tick()
  }, intervalMs)
  // Never hold the process open just for the poll timer.
  workerTimer.unref()
  logStep('ingest.worker_started', { workerId: WORKER_ID, intervalMs })
}

export { estimateTokens }
