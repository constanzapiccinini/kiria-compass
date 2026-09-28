/**
 * OpenAI client for embeddings and deterministic chat completions.
 *
 * Written against the documented HTTP API with narrowed response parsing rather
 * than a heavy SDK dependency. The API key is a real credential and comes from
 * `process.env.OPENAI_API_KEY` (registered via `fusebase secret create`).
 */

import {
  CHAT_MODEL,
  CHAT_TEMPERATURE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  openAiApiKey,
} from './config.js'

const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Requests are retried on 429/5xx with jittered backoff. */
const MAX_ATTEMPTS = 3

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * A 429 that means "out of credits" rather than "slow down".
 *
 * OpenAI returns both under 429. Retrying a quota exhaustion is pointless — it will
 * still be exhausted in 60 seconds — and it costs the caller its whole retry budget
 * before the actionable message reaches the user, so it is treated as permanent.
 */
function isQuotaExhausted(status: number, body: string): boolean {
  if (status !== 429) return false
  return /insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached/i.test(body)
}

export class OpenAiError extends Error {
  readonly status: number
  readonly retryable: boolean
  /** True when the account is out of credits or over a billing limit. */
  readonly quotaExhausted: boolean

  constructor(status: number, message: string) {
    super(message)
    this.name = 'OpenAiError'
    this.status = status
    this.quotaExhausted = isQuotaExhausted(status, message)
    this.retryable = !this.quotaExhausted && (status === 429 || status >= 500)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postJson(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${openAiApiKey()}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const error = new OpenAiError(response.status, `OpenAI ${path} failed (${response.status}): ${text.slice(0, 500)}`)
        if (!error.retryable || attempt === MAX_ATTEMPTS) throw error
        lastError = error
        await sleep(400 * attempt + Math.random() * 250)
        continue
      }

      return await response.json()
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      const isRetryable = isAbort || (error instanceof OpenAiError && error.retryable)
      if (!isRetryable || attempt === MAX_ATTEMPTS) throw error
      lastError = error
      await sleep(400 * attempt + Math.random() * 250)
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError instanceof Error ? lastError : new Error('OpenAI request failed')
}

// ---------------------------------------------------------------------------
// response narrowing
// ---------------------------------------------------------------------------

function readUsage(value: unknown): TokenUsage {
  if (typeof value !== 'object' || value === null) return { inputTokens: 0, outputTokens: 0 }
  const usage = value as Record<string, unknown>
  const prompt = usage.prompt_tokens
  const completion = usage.completion_tokens
  return {
    inputTokens: typeof prompt === 'number' ? prompt : 0,
    outputTokens: typeof completion === 'number' ? completion : 0,
  }
}

function readEmbeddingVectors(payload: unknown, expected: number): number[][] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('OpenAI embeddings response is not an object')
  }
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) throw new Error('OpenAI embeddings response has no data array')

  const vectors: number[][] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('OpenAI embeddings response contains a non-object entry')
    }
    const embedding = (item as Record<string, unknown>).embedding
    if (!Array.isArray(embedding)) throw new Error('OpenAI embeddings entry has no embedding array')
    const vector = embedding.filter((n): n is number => typeof n === 'number')
    if (vector.length !== embedding.length) {
      throw new Error('OpenAI embeddings entry contains non-numeric values')
    }
    vectors.push(vector)
  }

  if (vectors.length !== expected) {
    throw new Error(`OpenAI returned ${vectors.length} embeddings for ${expected} inputs`)
  }
  return vectors
}

function readCompletionText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('OpenAI chat response is not an object')
  }
  const choices = (payload as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('OpenAI chat response has no choices')
  }
  const first = choices[0]
  if (typeof first !== 'object' || first === null) throw new Error('OpenAI chat choice is not an object')
  const message = (first as Record<string, unknown>).message
  if (typeof message !== 'object' || message === null) throw new Error('OpenAI chat choice has no message')
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
}

function readFinishReason(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const reason = (first as Record<string, unknown>).finish_reason
  return typeof reason === 'string' ? reason : null
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** Scale a vector to unit length so a dot product equals cosine similarity. */
export function normalize(vector: number[]): number[] {
  let sumSquares = 0
  for (const value of vector) sumSquares += value * value
  const magnitude = Math.sqrt(sumSquares)
  if (magnitude === 0) return vector.slice()
  return vector.map((value) => value / magnitude)
}

export interface EmbeddingResult {
  vectors: number[][]
  usage: TokenUsage
  model: string
  dimensions: number
}

/**
 * Embed a batch of texts. `dimensions` shortens text-embedding-3-large via its
 * Matryoshka support, which is what makes an in-database dot-product scan viable
 * on a host without pgvector.
 */
export async function createEmbeddings(inputs: string[]): Promise<EmbeddingResult> {
  if (inputs.length === 0) {
    return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 }, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS }
  }

  const payload = await postJson(
    '/embeddings',
    { model: EMBEDDING_MODEL, input: inputs, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' },
    60000,
  )

  const vectors = readEmbeddingVectors(payload, inputs.length).map(normalize)
  return {
    vectors,
    usage: readUsage((payload as Record<string, unknown>).usage),
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  text: string
  usage: TokenUsage
  model: string
  truncated: boolean
}

/** Deterministic completion. Temperature stays inside the configured 0.0-0.2 band. */
export async function createChatCompletion(
  messages: ChatMessage[],
  maxOutputTokens: number,
): Promise<ChatResult> {
  const payload = await postJson(
    '/chat/completions',
    {
      model: CHAT_MODEL,
      temperature: CHAT_TEMPERATURE,
      top_p: 1,
      max_tokens: maxOutputTokens,
      messages,
    },
    60000,
  )

  return {
    text: readCompletionText(payload),
    usage: readUsage((payload as Record<string, unknown>).usage),
    model: CHAT_MODEL,
    truncated: readFinishReason(payload) === 'length',
  }
}
