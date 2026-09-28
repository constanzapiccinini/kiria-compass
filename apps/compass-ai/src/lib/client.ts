/**
 * Typed client for the Compass AI backend.
 *
 * Calls are same-origin and relative, so the `fbsfeaturetoken` cookie rides along and
 * no platform host is ever baked into the bundle.
 */

import { REQUEST_TIMEOUT_MS } from './api'
import { portalHeaders } from './portal'

export type Actor = 'employee' | 'client'

export interface CurrentUser {
  id: string
  email: string | null
}

export interface ClientRef {
  id: string
  name: string
}

/**
 * What this actor may do, as decided by the backend.
 *
 * Used to choose what to RENDER, never to decide access — every one of these is
 * re-checked server-side. A capability that is false means the control is absent
 * from the DOM, not disabled.
 */
export interface Capabilities {
  viewDocuments: boolean
  chat: boolean
  exportAnswers: boolean
}

export interface SessionResponse {
  actor: Actor
  user: CurrentUser
  portalId: string
  client: ClientRef
  capabilities: Capabilities
  /**
   * The three values that shape the experience.
   *
   * No longer the full settings object with provenance for staff (§5C): where a
   * value was set is a question for Compass Admin, which is the only place it can
   * be changed.
   */
  settings: Pick<ClientSettings, 'maxAnswerTokens' | 'maxRetrievedTokens'>
}

export type DocumentStatus =
  | 'queued'
  | 'uploading'
  | 'ocr'
  | 'parsed'
  | 'embedding'
  | 'indexed'
  | 'failed'
  | 'deleted'

export interface FolderNode {
  id: string
  parentId: string | null
  name: string
  position: number
  depth: number
}

/**
 * One library this portal receives, with its own tree (§6A.2).
 *
 * The nesting is the contract, not a convenience. Two libraries may each contain a
 * folder called *Compass*, so the library is what tells those apart — which is why
 * it is a node in the sidebar and never collapsed away, even when a portal receives
 * exactly one library.
 */
export interface PortalLibrary {
  id: string
  name: string
  folders: FolderNode[]
}

export interface FolderListResponse {
  libraries: PortalLibrary[]
}

export interface DocumentSummary {
  id: string
  name: string
  status: DocumentStatus
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
  /** Null means Unfiled — a virtual node in the tree, not a folder row. */
  folderId: string | null
  /** The library this document hangs under in the sidebar. */
  libraryId: string | null
}

export interface DocumentListResponse {
  documents: DocumentSummary[]
  ocrConfigured: boolean
}

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ParagraphBox {
  pageNumber: number
  paragraphIndex: number
  paragraphKey: string
  text: string
  /** Normalized 0..1, top-left origin. Null when geometry was unavailable. */
  bbox: BoundingBox | null
}

export interface UploadOutcome {
  name: string
  documentId?: string
  status: 'queued' | 'duplicate' | 'rejected'
  message?: string
}

export interface Citation {
  documentId: string
  documentName: string
  page: number
  paragraphKey: string | null
  chunkId: string
  sectionTitle: string | null
  snippet: string
}

export interface ChatMessageView {
  id: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  citations: Citation[]
  grounded: boolean | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  latencyMs?: number | null
  truncated?: boolean
  createdAt?: string
  /**
   * This viewer's own rating of the answer: 1, -1, or null when unrated.
   *
   * Per person, never an aggregate. The backend joins on a hash of the caller, so one
   * reader never sees another's rating — and there is no count a client is entitled
   * to, because "three of your colleagues disliked this answer" is a different
   * product with different consent behind it.
   */
  rating?: number | null
}

export interface RetrievalInfo {
  candidateCount: number
  usedCount: number
  contextTokens: number
  topScore: number
}

export interface AskResponse {
  message: ChatMessageView
  retrieval: RetrievalInfo
  notice?: string
}

export interface ChatRef {
  id: string
  title: string
  createdByUserId: string
  lastMessageAt: string | null
  createdAt: string
}

export interface ChatDetail {
  chat: { id: string; title: string; clientId: string }
  messages: ChatMessageView[]
  documents: { id: string; name: string; status: DocumentStatus; active: boolean }[]
}

export interface ClientSettings {
  clientId: string
  maxAnswerTokens: number
  maxRetrievedTokens: number
  maxOcrPagesPerUpload: number
  monthlyTokenBudget: number | null
  monthlyOcrPageBudget: number | null
  ocrTablesEnabled: boolean
  ocrFormsEnabled: boolean
  ocrQueriesEnabled: boolean
  batchEmbeddingEnabled: boolean
  batchEmbeddingMinChunks: number
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  ocrPages: number
  costUsd: number
}

export interface SettingsResponse {
  settings: ClientSettings
  usageMonthToDate: UsageTotals
}

/** An error carrying the backend's HTTP status, so callers can branch on 401 vs 5xx. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = 'ERROR') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Errors arrive as { error: { code, message } }; older shapes used a bare string. */
function readError(payload: unknown, fallback: string): { code: string; message: string } {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as { error?: unknown }).error
    if (typeof error === 'string' && error.length > 0) return { code: 'ERROR', message: error }
    if (typeof error === 'object' && error !== null) {
      const shaped = error as { code?: unknown; message?: unknown }
      return {
        code: typeof shaped.code === 'string' ? shaped.code : 'ERROR',
        message: typeof shaped.message === 'string' ? shaped.message : fallback,
      }
    }
  }
  return { code: 'ERROR', message: fallback }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(path, {
      ...init,
      headers: { ...portalHeaders(), ...(init.headers ?? {}) },
      credentials: 'include',
      signal: controller.signal,
    })

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null)
      const shaped = readError(payload, `Request failed with status ${response.status}`)
      throw new ApiError(response.status, shaped.message, shaped.code)
    }
    return (await response.json()) as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(0, 'The server took too long to respond. Please try again.')
    }
    throw new ApiError(0, error instanceof Error ? error.message : 'Network error')
  } finally {
    clearTimeout(timer)
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const api = {
  session: (): Promise<SessionResponse> => request<SessionResponse>('/api/session'),

  listDocuments: (): Promise<DocumentListResponse> => request<DocumentListResponse>('/api/documents'),

  listFolders: (): Promise<FolderListResponse> => request<FolderListResponse>('/api/folders'),

  listChats: (): Promise<{ chats: ChatRef[] }> => request<{ chats: ChatRef[] }>('/api/chats'),

  /**
   * Rate one answer (Phase 8 §3).
   *
   * A PUT rather than a POST because it is idempotent per person per message:
   * changing one's mind is the normal case, and the backend updates rather than
   * refusing a second submit.
   */
  rateAnswer: (
    chatId: string,
    messageId: string,
    rating: 1 | -1,
    comment?: string,
  ): Promise<{ rating: number; comment: string | null }> =>
    request(
      `/api/chats/${chatId}/messages/${messageId}/feedback`,
      jsonInit('PUT', comment === undefined ? { rating } : { rating, comment }),
    ),

  createChat: (documentIds: string[]): Promise<ChatRef> =>
    request<ChatRef>('/api/chats', jsonInit('POST', { documentIds })),

  getChat: (chatId: string): Promise<ChatDetail> => request<ChatDetail>(`/api/chats/${chatId}`),

  deleteChat: (chatId: string): Promise<{ deleted: boolean }> =>
    request<{ deleted: boolean }>(`/api/chats/${chatId}`, { method: 'DELETE' }),

  ask: (
    chatId: string,
    question: string,
    documentIds: string[],
  ): Promise<AskResponse> =>
    request<AskResponse>(
      `/api/chats/${chatId}/messages`,
      jsonInit('POST', { question, documentIds }),
      // Retrieval plus generation legitimately takes longer than a plain read; stay
      // under the platform's 30s proxy ceiling.
      28000,
    ),

  listParagraphs: (documentId: string, page?: number): Promise<{ paragraphs: ParagraphBox[] }> =>
    request<{ paragraphs: ParagraphBox[] }>(
      page === undefined
        ? `/api/documents/${documentId}/paragraphs`
        : `/api/documents/${documentId}/paragraphs?page=${page}`,
    ),

}
