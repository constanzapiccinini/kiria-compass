/**
 * Typed client for the insights backend.
 *
 * Same-origin relative paths only, so the platform routes the call and the
 * `fbsfeaturetoken` cookie rides along — no host is baked into the bundle, which is
 * what makes one build safe to deploy against any environment.
 *
 * No portal context header exists here, and that is stronger than in the admin app:
 * the routes behind this hold every client's verbatim questions, and the RLS policies
 * refuse any request that carries a client scope at all.
 *
 * The error plumbing is deliberately identical to the other two apps — one shape,
 * `{ error: { code, message } }`, so a reader moving between the three codebases is
 * not learning a third convention.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface ErrorShape {
  error?: { code?: unknown; message?: unknown }
}

function readError(payload: unknown, fallback: string): { code: string; message: string } {
  if (typeof payload === 'object' && payload !== null) {
    const shaped = payload as ErrorShape
    const message = typeof shaped.error?.message === 'string' ? shaped.error.message : fallback
    const code = typeof shaped.error?.code === 'string' ? shaped.error.code : 'ERROR'
    return { code, message }
  }
  return { code: 'ERROR', message: fallback }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { ...(init.headers ?? {}) },
  })

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null)
    const shaped = readError(payload, `Request failed with ${response.status}`)
    throw new ApiError(response.status, shaped.message, shaped.code)
  }

  return (await response.json()) as T
}

// --- types -----------------------------------------------------------------

export interface OverviewWeek {
  week: string
  questions: number
  gaps: number
  clientsActive: number
}

export interface Overview {
  windowDays: number
  totals: {
    questions: number
    answers: number
    gaps: number
    clientsActive: number
    chats: number
  }
  series: OverviewWeek[]
  /**
   * How much of the book a number covers.
   *
   * Carried so the screen can qualify a rate instead of presenting it bare: a gap
   * rate over two of seven accounts is a fact about those two.
   */
  coverage: {
    clients: number
    optedOut: number
    withRetention: number
    questionsEmbedded: number
    questionsEmbeddable: number
  }
  /** What has not shipped yet, so an empty panel does not read as "none found". */
  pending: { themes: string; flags: string }
}

export interface CitedDocument {
  documentId: string
  documentName: string
  citations: number
  answers: number
  clients: number
  lastCitedAt: string | null
}

export interface NeverCitedDocument {
  documentId: string
  documentName: string
  /** Shown because two libraries can hold documents of the same name. */
  library: string | null
  indexedAt: string | null
  daysLive: number
  chunkCount: number
}

export interface DocumentMetrics {
  windowDays: number
  neverCitedMinDays: number
  cited: CitedDocument[]
  neverCited: NeverCitedDocument[]
}

export interface ClientRow {
  clientId: string
  name: string
  optedOut: boolean
  retentionDays: number | null
  questions: number
  answers: number
  gaps: number
  lastQuestionAt: string | null
}

export interface UnansweredQuestion {
  messageId: string | null
  question: string | null
  answer: string | null
  askedAt: string | null
}

export interface ClientLibrary {
  libraryId: string
  name: string
  isPrivate: boolean
  grantedAt: string
  daysSinceGrant: number
  documents: number
  questionsSinceGrant: number
}

export interface ClientDetail {
  clientId: string
  name: string
  optedOut: boolean
  retentionDays?: number | null
  windowDays?: number
  unanswered: UnansweredQuestion[]
  libraries: ClientLibrary[]
  note?: string
}

export interface GapTheme {
  themeId: string
  label: string
  summary: string
  clientId: string
  clientName: string
  questionCount: number
  clientCount: number
  unansweredShare: number | null
  periodStart: string
  periodEnd: string
  /** Which prompt, model and threshold produced this row (§5). */
  promptVersion: string
  /**
   * The questions behind the theme.
   *
   * Empty when retention has removed them and the aggregate survived (§6) — which the
   * screen says explicitly rather than showing a theme with nothing under it.
   */
  sampleQuestions: string[]
}

export interface Gaps {
  /** Always 'client' in 8C — cross-account themes are gated on §2. */
  scope: string
  scopeNote: string
  themes: GapTheme[]
}

export interface InsightRun {
  id: string
  kind: string
  status: string
  counts: Record<string, unknown>
  lastError: string | null
  startedAt: string
  finishedAt: string | null
}

export interface ReviewFlag {
  flagId: string
  code: string
  confidence: number | null
  status: string
  notes: string | null
  /** Which classifier produced it — two prompt versions are not the same evidence. */
  model: string
  promptVersion: string
  createdAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  clientId: string
  clientName: string
  chatId: string
  /**
   * The question in full (§7 screen 5).
   *
   * Allowed here because a flag is client-scoped by construction — §2 restricts
   * verbatim text by scope, not by sensitivity — and because a reviewer cannot judge
   * an adverse-event mention from a summary.
   */
  question: string
  askedAt: string
  /** The reply the client received. Null when the answer has not been written yet. */
  answer: string | null
  answerGrounded: boolean | null
}

export interface FlagQueue {
  status: string
  byStatus: Record<string, number>
  /** How much of the eligible history the screen has looked at, from 0025's marker. */
  screening: { screened: number; eligible: number }
  flags: ReviewFlag[]
}

// --- api -------------------------------------------------------------------

export const api = {
  overview: (days?: number): Promise<Overview> =>
    request<Overview>(`/api/metrics/overview${days === undefined ? '' : `?days=${days}`}`),

  documents: (options: { days?: number; clientId?: string } = {}): Promise<DocumentMetrics> => {
    const params = new URLSearchParams()
    if (options.days !== undefined) params.set('days', String(options.days))
    if (options.clientId !== undefined) params.set('clientId', options.clientId)
    const suffix = params.toString()
    return request<DocumentMetrics>(`/api/metrics/documents${suffix ? `?${suffix}` : ''}`)
  },

  clients: (): Promise<{ clients: ClientRow[] }> =>
    request<{ clients: ClientRow[] }>('/api/metrics/clients'),

  client: (clientId: string, days?: number): Promise<ClientDetail> =>
    request<ClientDetail>(
      `/api/metrics/clients/${clientId}${days === undefined ? '' : `?days=${days}`}`,
    ),

  gaps: (): Promise<Gaps> => request<Gaps>('/api/metrics/gaps'),

  runs: (): Promise<{ runs: InsightRun[] }> => request<{ runs: InsightRun[] }>('/api/metrics/runs'),

  flags: (status?: string): Promise<FlagQueue> =>
    request<FlagQueue>(`/api/flags${status === undefined ? '' : `?status=${status}`}`),

  decideFlag: (
    flagId: string,
    status: 'reviewed' | 'dismissed' | 'escalated',
    notes: string | null,
  ): Promise<{ flagId: string; status: string }> =>
    request<{ flagId: string; status: string }>(`/api/flags/${flagId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, notes }),
    }),
}
