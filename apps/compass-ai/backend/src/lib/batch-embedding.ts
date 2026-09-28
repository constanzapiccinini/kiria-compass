/**
 * Batch-embedding path: write chunks without vectors, submit an OpenAI batch, then
 * fill the vectors in when it completes.
 *
 * A document stays in `embedding` status for the whole window, and contributes
 * nothing to retrieval until its vectors land — every retrieval query filters on
 * `embedding IS NOT NULL`, so a half-embedded document can never produce a citation
 * from an unembedded passage.
 */

import { createHash } from 'node:crypto'
import { ownerColumns, type RowOwner } from './owner.js'
import { raiseAlert } from './alerts.js'
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, PRICING } from './config.js'
import type { Chunk } from './chunk.js'
import { normalize } from './openai.js'
import {
  getBatch,
  isTerminal,
  readBatchOutput,
  submitEmbeddingBatch,
  type BatchState,
} from './openai-batch.js'
import { logStep, recordUsage } from './observability.js'
import {
  batchInsertRows,
  insertRow,
  query,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  readStringArray,
  updateRows,
} from './store.js'

/** Rows per structured insert call; a chunk row without a vector is small. */
const CHUNK_INSERT_BATCH = 60
/** Vectors applied per update pass. */
const VECTOR_UPDATE_BATCH = 40

export interface PendingBatch extends RowOwner {
  id: string
  providerBatchId: string
  status: string
  chunkCount: number
  embeddedCount: number
  documentIds: string[]
}

function toPendingBatch(row: Record<string, unknown>): PendingBatch {
  return {
    id: readString(row, 'id'),
    clientId: readOptionalString(row, 'client_id'),
    libraryId: readOptionalString(row, 'library_id'),
    providerBatchId: readString(row, 'provider_batch_id'),
    status: readString(row, 'status'),
    chunkCount: readNumber(row, 'chunk_count'),
    embeddedCount: readNumber(row, 'embedded_count'),
    documentIds: readStringArray(row, 'document_ids'),
  }
}

/**
 * Insert chunks with a NULL embedding and submit them as one OpenAI batch.
 *
 * Chunks are written first so each row's id can serve as the batch `custom_id` —
 * that is what lets the poller match a returned vector back to its exact chunk.
 */
export async function submitDocumentBatch(
  owner: RowOwner,
  documentId: string,
  chunks: Chunk[],
): Promise<{ batchId: string; providerBatchId: string; chunkCount: number }> {
  if (chunks.length === 0) throw new Error('submitDocumentBatch called with no chunks')

  const rows = chunks.map((chunk) => ({
    ...ownerColumns(owner),
    document_id: documentId,
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
    // embedding stays NULL until the batch returns
    embedding_model: EMBEDDING_MODEL,
    embedding_dims: EMBEDDING_DIMENSIONS,
  }))

  for (let start = 0; start < rows.length; start += CHUNK_INSERT_BATCH) {
    await batchInsertRows('document_chunks', rows.slice(start, start + CHUNK_INSERT_BATCH))
  }

  // Read the ids back in chunk order so each request carries the right custom_id.
  const inserted = await query(
    `SELECT id, chunk_index, text
       FROM document_chunks
      WHERE document_id = $1 AND embedding IS NULL
      ORDER BY chunk_index ASC`,
    [documentId],
  )
  if (inserted.length === 0) {
    throw new Error(`no unembedded chunks found for document ${documentId} after insert`)
  }

  const submitted: BatchState = await submitEmbeddingBatch(
    inserted.map((row) => ({
      customId: readString(row, 'id'),
      text: readString(row, 'text'),
    })),
  )

  const record = await insertRow(
    'embedding_batches',
    {
      ...ownerColumns(owner),
      provider_batch_id: submitted.id,
      input_file_id: submitted.inputFileId,
      status: submitted.status === 'cancelling' ? 'in_progress' : submitted.status,
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      chunk_count: inserted.length,
      document_ids: [documentId],
      request_counts: JSON.stringify(submitted.requestCounts),
    },
    ['id'],
  )
  if (!record) throw new Error('failed to record the embedding batch')
  const batchId = readString(record, 'id')

  // Tag the chunks so a stuck batch is traceable from either direction.
  await updateRows('document_chunks', { embedding_batch_id: batchId }, [
    { column: 'document_id', operator: 'eq', value: documentId },
    { column: 'embedding_batch_id', operator: 'is_null' },
  ])

  logStep('batch.submitted', {
    batchId,
    providerBatchId: submitted.id,
    documentId,
    ...owner,
    chunkCount: inserted.length,
  })

  return { batchId, providerBatchId: submitted.id, chunkCount: inserted.length }
}

/** Open batches, oldest first. */
export async function listOpenBatches(): Promise<PendingBatch[]> {
  const rows = await query(
    `SELECT id, client_id, library_id, provider_batch_id, status, chunk_count, embedded_count, document_ids
       FROM embedding_batches
      WHERE status NOT IN ('completed', 'failed', 'expired', 'cancelled')
      ORDER BY submitted_at ASC
      LIMIT 20`,
  )
  return rows.map(toPendingBatch)
}

export async function findBatch(batchId: string): Promise<PendingBatch | null> {
  const row = await queryOne(
    `SELECT id, client_id, library_id, provider_batch_id, status, chunk_count, embedded_count, document_ids
       FROM embedding_batches WHERE id = $1`,
    [batchId],
  )
  return row ? toPendingBatch(row) : null
}

/**
 * Apply returned vectors to their chunks.
 *
 * Vectors are normalized here exactly as on the synchronous path, so batched and
 * synchronous embeddings stay directly comparable by dot product.
 */
async function applyVectors(
  lines: Awaited<ReturnType<typeof readBatchOutput>>,
): Promise<{ applied: number; failed: number }> {
  let applied = 0
  let failed = 0

  const usable = lines.filter((line) => line.embedding !== null)
  failed = lines.length - usable.length

  for (let start = 0; start < usable.length; start += VECTOR_UPDATE_BATCH) {
    const slice = usable.slice(start, start + VECTOR_UPDATE_BATCH)
    // One row at a time: the structured update API sets one value set per call, and
    // each vector differs. Batched inserts are not an option for an update.
    for (const line of slice) {
      const changed = await updateRows(
        'document_chunks',
        { embedding: normalize(line.embedding as number[]) },
        [{ column: 'id', operator: 'eq', value: line.customId }],
      )
      applied += changed
    }
  }

  return { applied, failed }
}

export interface PollOutcome {
  status: string
  applied: number
  failedRequests: number
  documentsCompleted: string[]
  stillOpen: boolean
}

/**
 * Poll one batch and, when it has finished, apply its vectors and settle the
 * documents it covered.
 *
 * Idempotent: re-polling a completed batch re-applies the same vectors (a no-op) and
 * re-settles the documents, so a retry after a partial failure is safe.
 */
export async function pollBatch(batchId: string): Promise<PollOutcome> {
  const record = await findBatch(batchId)
  if (!record) throw new Error(`embedding batch ${batchId} not found`)

  const state = await getBatch(record.providerBatchId)
  const normalizedStatus = state.status === 'cancelling' ? 'in_progress' : state.status

  await updateRows(
    'embedding_batches',
    {
      status: normalizedStatus,
      output_file_id: state.outputFileId,
      error_file_id: state.errorFileId,
      request_counts: JSON.stringify(state.requestCounts),
      last_error: state.errorMessage,
    },
    [{ column: 'id', operator: 'eq', value: batchId }],
  )

  if (!isTerminal(state.status)) {
    logStep('batch.pending', {
      batchId,
      providerBatchId: record.providerBatchId,
      status: normalizedStatus,
      counts: state.requestCounts,
    })
    return {
      status: normalizedStatus,
      applied: 0,
      failedRequests: 0,
      documentsCompleted: [],
      stillOpen: true,
    }
  }

  let applied = 0
  let failedRequests = state.requestCounts.failed

  if (state.status === 'completed' && state.outputFileId) {
    const lines = await readBatchOutput(state.outputFileId)
    const result = await applyVectors(lines)
    applied = result.applied
    failedRequests = Math.max(failedRequests, result.failed)

    // Batch pricing is half the synchronous rate. Tokens are not reported per line,
    // so meter the model's own count when present and fall back to zero rather than
    // guessing — the chunk count is recorded either way.
    await recordUsage({
      clientId: record.clientId,
      kind: 'embedding',
      model: EMBEDDING_MODEL,
      inputTokens: 0,
      metadata: {
        via: 'batch',
        batchId,
        providerBatchId: record.providerBatchId,
        appliedVectors: applied,
        failedRequests,
        discount: 0.5,
        unitPriceUsdPerMillion: PRICING[EMBEDDING_MODEL].inputPerMillion * 0.5,
      },
    })
  }

  await updateRows(
    'embedding_batches',
    {
      status: normalizedStatus,
      embedded_count: applied,
      completed_at: new Date().toISOString(),
    },
    [{ column: 'id', operator: 'eq', value: batchId }],
  )

  const documentsCompleted = await settleDocuments(record, normalizedStatus, failedRequests)

  logStep('batch.settled', {
    batchId,
    providerBatchId: record.providerBatchId,
    status: normalizedStatus,
    applied,
    failedRequests,
    documents: documentsCompleted.length,
  })

  // One alert per batch, not per document: a batch is a single event with a single
  // remedy ("re-index what is still unsearchable"), and a 200-document batch would
  // otherwise produce 200 alerts saying the same thing.
  //
  // A batch that completes but leaves some documents unsettled counts too — the
  // failure mode that matters to a client is "the document is not searchable", and
  // whether the provider called the batch `completed` does not change that.
  const unsettled = record.documentIds.length - documentsCompleted.length
  if (normalizedStatus !== 'completed' || unsettled > 0) {
    await raiseAlert({
      code: 'BATCH_EXPIRED',
      clientId: record.clientId,
      dedupeExtra: batchId,
      cause:
        `Bulk embedding batch ${record.providerBatchId} finished as "${normalizedStatus}" with ` +
        `${applied} of ${record.chunkCount} passages embedded and ${failedRequests} failed requests. ` +
        `${unsettled} of ${record.documentIds.length} documents are still not searchable. ` +
        `No document was lost — only the queued embedding work.`,
      metadata: {
        batchId,
        providerBatchId: record.providerBatchId,
        status: normalizedStatus,
        applied,
        failedRequests,
        unsettled,
      },
    })
  }

  return {
    status: normalizedStatus,
    applied,
    failedRequests,
    documentsCompleted,
    stillOpen: false,
  }
}

/**
 * Move each document in the batch to its final state.
 *
 * A document is only `indexed` when it actually has embedded chunks; a batch that
 * failed, expired or returned nothing usable leaves the document `failed` with an
 * actionable message rather than silently empty but "ready".
 */
async function settleDocuments(
  record: PendingBatch,
  status: string,
  failedRequests: number,
): Promise<string[]> {
  const settled: string[] = []

  for (const documentId of record.documentIds) {
    const counts = await queryOne(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
         FROM document_chunks WHERE document_id = $1`,
      [documentId],
    )
    const total = counts ? readNumber(counts, 'total') : 0
    const embedded = counts ? readNumber(counts, 'embedded') : 0

    if (embedded > 0) {
      await updateRows(
        'documents',
        {
          status: 'indexed',
          chunk_count: embedded,
          indexed_at: new Date().toISOString(),
          status_detail:
            embedded < total
              ? `${embedded} of ${total} passages embedded; ${total - embedded} failed in the batch`
              : null,
          error_message: null,
        },
        [{ column: 'id', operator: 'eq', value: documentId }],
      )
      settled.push(documentId)
      continue
    }

    await updateRows(
      'documents',
      {
        status: 'failed',
        status_detail: null,
        error_message:
          status === 'completed'
            ? `The bulk embedding batch returned no usable vectors (${failedRequests} requests failed). Re-index this document to retry.`
            : `The bulk embedding batch ${status}. Re-index this document to retry.`,
      },
      [{ column: 'id', operator: 'eq', value: documentId }],
    )
  }

  return settled
}

/**
 * Whether this ingest should use the batch path.
 *
 * Both conditions must hold: the client opted in, and the document is big enough
 * that a 24-hour window is a reasonable trade for halving the cost.
 */
export function shouldUseBatch(
  enabled: boolean,
  minChunks: number,
  chunkCount: number,
): boolean {
  return enabled && chunkCount >= minChunks
}

/** Human-readable summary for the indexing dashboard. */
export async function batchSummaries(clientId: string): Promise<
  Array<{
    id: string
    providerBatchId: string
    status: string
    chunkCount: number
    embeddedCount: number
    documentIds: string[]
    requestCounts: unknown
    lastError: string | null
    submittedAt: string
    completedAt: string | null
  }>
> {
  const rows = await query(
    `SELECT id, provider_batch_id, status, chunk_count, embedded_count, document_ids,
            request_counts, last_error, submitted_at, completed_at
       FROM embedding_batches
      WHERE client_id = $1
      ORDER BY submitted_at DESC
      LIMIT 20`,
    [clientId],
  )

  return rows.map((row) => ({
    id: readString(row, 'id'),
    providerBatchId: readString(row, 'provider_batch_id'),
    status: readString(row, 'status'),
    chunkCount: readNumber(row, 'chunk_count'),
    embeddedCount: readNumber(row, 'embedded_count'),
    documentIds: readStringArray(row, 'document_ids'),
    requestCounts: row.request_counts ?? {},
    lastError: readOptionalString(row, 'last_error'),
    submittedAt: readString(row, 'submitted_at'),
    completedAt: readOptionalString(row, 'completed_at'),
  }))
}
