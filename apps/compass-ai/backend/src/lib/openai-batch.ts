/**
 * OpenAI Batch API for bulk embedding.
 *
 * Roughly half the price of the synchronous endpoint, with a completion window of up
 * to 24 hours. That trade only makes sense for bulk ingest, so it is opt-in per
 * client and gated on a minimum chunk count — a small upload should be searchable
 * in seconds.
 *
 * Flow: upload a JSONL file of embedding requests -> create a batch -> poll ->
 * download the output JSONL and match each line back to its chunk by `custom_id`.
 */

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, openAiApiKey } from './config.js'

const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Mirrors OpenAI's batch lifecycle values. */
export type BatchStatus =
  | 'validating'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'cancelling'

export interface BatchRequestCounts {
  total: number
  completed: number
  failed: number
}

export interface BatchState {
  id: string
  status: BatchStatus
  inputFileId: string | null
  outputFileId: string | null
  errorFileId: string | null
  requestCounts: BatchRequestCounts
  errorMessage: string | null
}

/** One embedding to request; `customId` is the chunk id the vector belongs to. */
export interface BatchInput {
  customId: string
  text: string
}

export interface BatchOutputLine {
  customId: string
  embedding: number[] | null
  error: string | null
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${openAiApiKey()}` }
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text.slice(0, 500)
}

// ---------------------------------------------------------------------------
// response narrowing
// ---------------------------------------------------------------------------

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readBatchStatus(value: unknown): BatchStatus {
  const allowed: BatchStatus[] = [
    'validating',
    'in_progress',
    'finalizing',
    'completed',
    'failed',
    'expired',
    'cancelled',
    'cancelling',
  ]
  return allowed.find((status) => status === value) ?? 'in_progress'
}

function readRequestCounts(value: unknown): BatchRequestCounts {
  if (typeof value !== 'object' || value === null) {
    return { total: 0, completed: 0, failed: 0 }
  }
  const counts = value as Record<string, unknown>
  const read = (key: string): number =>
    typeof counts[key] === 'number' ? (counts[key] as number) : 0
  return { total: read('total'), completed: read('completed'), failed: read('failed') }
}

/** OpenAI reports batch-level problems in an `errors.data[]` array. */
function readBatchError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const errors = (value as Record<string, unknown>).errors
  if (typeof errors !== 'object' || errors === null) return null
  const data = (errors as Record<string, unknown>).data
  if (!Array.isArray(data) || data.length === 0) return null

  const messages: string[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const message = (entry as Record<string, unknown>).message
    if (typeof message === 'string') messages.push(message)
  }
  return messages.length > 0 ? messages.join('; ').slice(0, 1000) : null
}

function toBatchState(payload: unknown): BatchState {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('OpenAI batch response is not an object')
  }
  const body = payload as Record<string, unknown>
  const id = readString(body, 'id')
  if (!id) throw new Error('OpenAI batch response has no id')

  return {
    id,
    status: readBatchStatus(body.status),
    inputFileId: readString(body, 'input_file_id'),
    outputFileId: readString(body, 'output_file_id'),
    errorFileId: readString(body, 'error_file_id'),
    requestCounts: readRequestCounts(body.request_counts),
    errorMessage: readBatchError(body),
  }
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

/**
 * Upload the JSONL request file.
 *
 * Each line is one `/v1/embeddings` request. `dimensions` must match the synchronous
 * path exactly, or batched vectors would be incomparable with existing ones.
 */
async function uploadBatchInput(inputs: BatchInput[]): Promise<string> {
  const jsonl = inputs
    .map((input) =>
      JSON.stringify({
        custom_id: input.customId,
        method: 'POST',
        url: '/v1/embeddings',
        body: {
          model: EMBEDDING_MODEL,
          input: input.text,
          dimensions: EMBEDDING_DIMENSIONS,
          encoding_format: 'float',
        },
      }),
    )
    .join('\n')

  const form = new FormData()
  form.append('purpose', 'batch')
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'embeddings.jsonl')

  const response = await fetch(`${OPENAI_BASE_URL}/files`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
    signal: AbortSignal.timeout(180000),
  })
  if (!response.ok) {
    throw new Error(`Batch input upload failed (${response.status}): ${await readErrorBody(response)}`)
  }

  const payload: unknown = await response.json()
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('OpenAI file upload response is not an object')
  }
  const fileId = readString(payload as Record<string, unknown>, 'id')
  if (!fileId) throw new Error('OpenAI file upload returned no id')
  return fileId
}

/** Submit a bulk embedding batch. Returns the batch as OpenAI first reports it. */
export async function submitEmbeddingBatch(inputs: BatchInput[]): Promise<BatchState> {
  if (inputs.length === 0) throw new Error('submitEmbeddingBatch called with no inputs')

  const inputFileId = await uploadBatchInput(inputs)

  const response = await fetch(`${OPENAI_BASE_URL}/batches`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: '/v1/embeddings',
      completion_window: '24h',
      metadata: { app: 'compass-ai', purpose: 'bulk-embedding' },
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) {
    throw new Error(`Batch create failed (${response.status}): ${await readErrorBody(response)}`)
  }

  const state = toBatchState(await response.json())
  // OpenAI echoes the input file id, but keep ours if the echo is missing.
  return { ...state, inputFileId: state.inputFileId ?? inputFileId }
}

export async function getBatch(providerBatchId: string): Promise<BatchState> {
  const response = await fetch(`${OPENAI_BASE_URL}/batches/${providerBatchId}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) {
    throw new Error(`Batch fetch failed (${response.status}): ${await readErrorBody(response)}`)
  }
  return toBatchState(await response.json())
}

export async function cancelBatch(providerBatchId: string): Promise<BatchState> {
  const response = await fetch(`${OPENAI_BASE_URL}/batches/${providerBatchId}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) {
    throw new Error(`Batch cancel failed (${response.status}): ${await readErrorBody(response)}`)
  }
  return toBatchState(await response.json())
}

/** Read one line of the batch output file into a chunk id + vector. */
function parseOutputLine(line: string): BatchOutputLine | null {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const body = payload as Record<string, unknown>

  const customId = readString(body, 'custom_id')
  if (!customId) return null

  // A per-request failure is reported on the line itself, not the batch.
  const lineError = body.error
  if (typeof lineError === 'object' && lineError !== null) {
    const message = (lineError as Record<string, unknown>).message
    return {
      customId,
      embedding: null,
      error: typeof message === 'string' ? message : 'unknown request error',
    }
  }

  const response = body.response
  if (typeof response !== 'object' || response === null) {
    return { customId, embedding: null, error: 'no response on output line' }
  }
  const responseBody = (response as Record<string, unknown>).body
  if (typeof responseBody !== 'object' || responseBody === null) {
    const statusCode = (response as Record<string, unknown>).status_code
    return { customId, embedding: null, error: `no body (status ${String(statusCode)})` }
  }

  const data = (responseBody as Record<string, unknown>).data
  if (!Array.isArray(data) || data.length === 0) {
    return { customId, embedding: null, error: 'response had no embedding data' }
  }
  const first = data[0]
  if (typeof first !== 'object' || first === null) {
    return { customId, embedding: null, error: 'embedding entry is not an object' }
  }
  const embedding = (first as Record<string, unknown>).embedding
  if (!Array.isArray(embedding)) {
    return { customId, embedding: null, error: 'embedding is not an array' }
  }
  const vector = embedding.filter((value): value is number => typeof value === 'number')
  if (vector.length !== embedding.length) {
    return { customId, embedding: null, error: 'embedding contained non-numeric values' }
  }
  return { customId, embedding: vector, error: null }
}

/**
 * Download and parse a batch output (or error) file.
 *
 * The file is JSONL and can be large, so it is streamed line by line rather than
 * parsed as one document.
 */
export async function readBatchOutput(fileId: string): Promise<BatchOutputLine[]> {
  const response = await fetch(`${OPENAI_BASE_URL}/files/${fileId}/content`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(300000),
  })
  if (!response.ok) {
    throw new Error(
      `Batch output download failed (${response.status}): ${await readErrorBody(response)}`,
    )
  }
  if (!response.body) throw new Error('Batch output download returned no body')

  const decoder = new TextDecoder()
  const lines: BatchOutputLine[] = []
  let buffer = ''

  for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(rawChunk, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line.length > 0) {
        const parsed = parseOutputLine(line)
        if (parsed) lines.push(parsed)
      }
      newlineIndex = buffer.indexOf('\n')
    }
  }

  const tail = buffer.trim()
  if (tail.length > 0) {
    const parsed = parseOutputLine(tail)
    if (parsed) lines.push(parsed)
  }

  return lines
}

/** True once the batch will never change again. */
export function isTerminal(status: BatchStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'expired' || status === 'cancelled'
}
