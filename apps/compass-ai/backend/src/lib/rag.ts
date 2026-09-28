/**
 * Retrieval, prompt assembly and the citation engine.
 *
 * Two invariants drive everything here:
 *   1. Zero hallucination — the model may only use the supplied context, and must say
 *      so explicitly when the context does not contain the answer.
 *   2. Every key statement carries a citation that resolves to a real document, page
 *      and paragraph. Citations the model invents are stripped before the answer is
 *      returned, so the UI can never link to a page that was not retrieved.
 */

import { RETRIEVAL_PRESETS } from './config.js'
import { createChatCompletion, createEmbeddings, type ChatMessage } from './openai.js'
import { estimateTokens } from './chunk.js'
import {
  query,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  readStringArray,
  toPgFloatArrayLiteral,
  toPgTextArrayLiteral,
} from './store.js'
import type { RetrievalMode, ClientSettings } from './settings.js'

/** The exact sentence returned when the documents cannot answer the question. */
export const NO_INFORMATION_ANSWER =
  'There is no information in the provided document to answer this question.'

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  documentName: string
  pageNumber: number
  pageStart: number
  pageEnd: number
  paragraphKey: string | null
  paragraphKeys: string[]
  sectionTitle: string | null
  text: string
  tokenCount: number
  score: number
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

export interface AnswerResult {
  answer: string
  citations: Citation[]
  grounded: boolean
  truncated: boolean
  retrievedChunkIds: string[]
  model: string
  inputTokens: number
  outputTokens: number
  retrieval: {
    mode: RetrievalMode
    candidateCount: number
    usedCount: number
    contextTokens: number
    topScore: number
  }
}

/**
 * Score every embedded chunk in scope with an in-database dot product and return the
 * best candidates. Vectors are unit-normalized on write, so the dot product is the
 * cosine similarity, and the two filters below keep the scan proportional to the
 * documents actually in the chat rather than the whole corpus.
 *
 * Scoped by **portal**, not client (§6.5). Two independent filters, and both are
 * load-bearing:
 *
 * - the join to `portal_visible_documents` answers "may this portal see this
 *   document at all", which a `client_id` filter cannot: a group source belongs to
 *   no single client, so filtering by client would hide exactly the documents group
 *   sources exist to share, and a document orphaned by a removed binding would stay
 *   retrievable;
 * - `document_id = ANY(...)` applies the chat's own narrower scope on top.
 *
 * Neither alone is sufficient. The spec is explicit that filtering on the chat's
 * stored document list alone leaves a removed binding readable.
 */
export async function retrieveCandidates(
  portalId: string,
  documentIds: string[],
  queryVector: number[],
  candidateK: number,
  minScore: number,
): Promise<RetrievedChunk[]> {
  if (documentIds.length === 0) return []

  const rows = await query(
    `SELECT c.id,
            c.document_id,
            d.name AS document_name,
            c.page_number,
            c.page_start,
            c.page_end,
            c.paragraph_key,
            c.paragraph_keys,
            c.section_title,
            c.text,
            c.token_count,
            public.vec_dot(c.embedding, $3::double precision[]) AS score
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN public.portal_visible_documents v ON v.document_id = d.id
      WHERE v.portal_id = $1
        AND c.document_id = ANY($2::uuid[])
        AND c.embedding IS NOT NULL
      ORDER BY score DESC
      LIMIT $4`,
    // `d.status = 'indexed'` is gone from here because the view already enforces it,
    // along with not-deleted and not-orphaned. One place decides visibility.
    [portalId, toPgTextArrayLiteral(documentIds), toPgFloatArrayLiteral(queryVector), candidateK],
  )

  return rows
    .map((row) => ({
      chunkId: readString(row, 'id'),
      documentId: readString(row, 'document_id'),
      documentName: readString(row, 'document_name'),
      pageNumber: readNumber(row, 'page_number'),
      pageStart: readNumber(row, 'page_start'),
      pageEnd: readNumber(row, 'page_end'),
      paragraphKey: readOptionalString(row, 'paragraph_key'),
      paragraphKeys: readStringArray(row, 'paragraph_keys'),
      sectionTitle: readOptionalString(row, 'section_title'),
      text: readString(row, 'text'),
      tokenCount: readOptionalNumber(row, 'token_count') ?? estimateTokens(readString(row, 'text')),
      score: readOptionalNumber(row, 'score') ?? 0,
    }))
    .filter((chunk) => chunk.score >= minScore)
}

/**
 * Select the chunks that fit the retrieved-token budget.
 *
 * Selection is round-robin across documents so a single verbose document cannot
 * crowd every other active document out of a multi-document answer.
 */
export function selectWithinBudget(
  candidates: RetrievedChunk[],
  topK: number,
  maxRetrievedTokens: number,
): { selected: RetrievedChunk[]; contextTokens: number } {
  const byDocument = new Map<string, RetrievedChunk[]>()
  for (const chunk of candidates) {
    const list = byDocument.get(chunk.documentId) ?? []
    list.push(chunk)
    byDocument.set(chunk.documentId, list)
  }

  const queues = [...byDocument.values()]
  const selected: RetrievedChunk[] = []
  let contextTokens = 0
  let exhausted = false

  while (selected.length < topK && !exhausted) {
    exhausted = true
    for (const queue of queues) {
      if (selected.length >= topK) break
      const chunk = queue.shift()
      if (!chunk) continue
      exhausted = false
      if (contextTokens + chunk.tokenCount > maxRetrievedTokens) {
        // Budget spent for this document; keep trying the others (a later chunk may
        // be small enough to fit).
        continue
      }
      selected.push(chunk)
      contextTokens += chunk.tokenCount
    }
  }

  // Present the highest-scoring evidence first.
  selected.sort((a, b) => b.score - a.score)
  return { selected, contextTokens }
}

const SYSTEM_PROMPT = `You are Compass AI, a document analysis assistant.

ABSOLUTE RULES:
1. Answer ONLY from the numbered CONTEXT passages provided in the user message. You have no other knowledge and must not use any.
2. If the CONTEXT does not contain the information needed, reply with EXACTLY this sentence and nothing else: "${NO_INFORMATION_ANSWER}"
3. Never guess, infer beyond the text, or fill gaps with general knowledge. Do not speculate.
4. Every key factual statement MUST end with an inline citation naming the source passage, in the form [^N] where N is the passage number it came from. A statement supported by several passages cites each one, e.g. [^1][^3].
5. Never cite a passage number that does not appear in the CONTEXT.
6. If the CONTEXT partially answers the question, answer only the part it supports and state plainly which part is not covered by the documents.

STYLE:
- Default to a short bulleted list; use prose only for a one-sentence answer.
- Bold the key terms and the conclusion.
- Be concise. Do not restate the question or describe your process.
- Quote exact figures, names and dates from the CONTEXT rather than paraphrasing them.`

/** Build the CONTEXT block. Passage numbers are 1-based and map to `chunks`. */
function buildContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const pageLabel =
        chunk.pageStart === chunk.pageEnd
          ? `Page ${chunk.pageNumber}`
          : `Pages ${chunk.pageStart}-${chunk.pageEnd}`
      const section = chunk.sectionTitle ? ` | Section: ${chunk.sectionTitle}` : ''
      return `[Passage ${index + 1}] Document: ${chunk.documentName} | ${pageLabel}${section}\n${chunk.text}`
    })
    .join('\n\n---\n\n')
}

/**
 * Replace the model's `[^N]` markers with human-readable citations, and drop any
 * marker that points at a passage which was not in the context. This is what makes
 * "mandatory citations" enforceable rather than merely requested.
 */
export function resolveCitations(
  rawAnswer: string,
  chunks: RetrievedChunk[],
): { answer: string; citations: Citation[] } {
  const used = new Map<number, Citation>()

  const answer = rawAnswer.replace(/\[\^(\d+)\]/g, (_match, group: string) => {
    const passageNumber = Number(group)
    const chunk = chunks[passageNumber - 1]
    if (!chunk) return '' // hallucinated passage number — remove it

    if (!used.has(passageNumber)) {
      used.set(passageNumber, {
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        page: chunk.pageNumber,
        paragraphKey: chunk.paragraphKey,
        chunkId: chunk.chunkId,
        sectionTitle: chunk.sectionTitle,
        snippet: chunk.text.slice(0, 320),
      })
    }

    const label = chunk.sectionTitle
      ? `[${chunk.documentName}, Page ${chunk.pageNumber} — ${chunk.sectionTitle}]`
      : `[${chunk.documentName}, Page ${chunk.pageNumber}]`
    return label
  })

  return {
    // Removing a marker can leave a double space before punctuation.
    answer: answer.replace(/[ \t]+([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim(),
    citations: [...used.values()],
  }
}

export interface AskOptions {
  /** Portal, not client: retrieval scope is decided by the portal (§6.5). */
  portalId: string
  documentIds: string[]
  question: string
  history: ChatMessage[]
  settings: ClientSettings
  mode: RetrievalMode
}

export interface AskTimings {
  embedQueryMs: number
  retrieveMs: number
  generateMs: number
}

export interface AskOutcome {
  result: AnswerResult
  timings: AskTimings
  embeddingInputTokens: number
}

/**
 * Full question-answering pass: embed the question, retrieve, generate, resolve
 * citations. Returns the `NO_INFORMATION_ANSWER` without calling the model at all
 * when nothing relevant was retrieved — that saves a round trip and removes any
 * chance of an ungrounded answer.
 */
export async function askQuestion(options: AskOptions): Promise<AskOutcome> {
  const preset = RETRIEVAL_PRESETS[options.mode]

  const embedStart = Date.now()
  const embedding = await createEmbeddings([options.question])
  const embedQueryMs = Date.now() - embedStart
  const queryVector = embedding.vectors[0] ?? []

  const retrieveStart = Date.now()
  const candidates = await retrieveCandidates(
    options.portalId,
    options.documentIds,
    queryVector,
    preset.candidateK,
    preset.minScore,
  )
  const { selected, contextTokens } = selectWithinBudget(
    candidates,
    preset.topK,
    options.settings.maxRetrievedTokens,
  )
  const retrieveMs = Date.now() - retrieveStart

  if (selected.length === 0) {
    return {
      result: {
        answer: NO_INFORMATION_ANSWER,
        citations: [],
        grounded: false,
        truncated: false,
        retrievedChunkIds: [],
        model: 'none',
        inputTokens: 0,
        outputTokens: 0,
        retrieval: {
          mode: options.mode,
          candidateCount: candidates.length,
          usedCount: 0,
          contextTokens: 0,
          topScore: candidates[0]?.score ?? 0,
        },
      },
      timings: { embedQueryMs, retrieveMs, generateMs: 0 },
      embeddingInputTokens: embedding.usage.inputTokens,
    }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...options.history,
    {
      role: 'user',
      content: `CONTEXT:\n\n${buildContextBlock(selected)}\n\n---\n\nQUESTION: ${options.question}`,
    },
  ]

  const generateStart = Date.now()
  const completion = await createChatCompletion(messages, options.settings.maxAnswerTokens)
  const generateMs = Date.now() - generateStart

  const { answer, citations } = resolveCitations(completion.text, selected)
  const isRefusal = answer.trim().startsWith(NO_INFORMATION_ANSWER.slice(0, 40))

  return {
    result: {
      answer: answer.length > 0 ? answer : NO_INFORMATION_ANSWER,
      citations,
      grounded: !isRefusal && citations.length > 0,
      truncated: completion.truncated,
      retrievedChunkIds: selected.map((chunk) => chunk.chunkId),
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      retrieval: {
        mode: options.mode,
        candidateCount: candidates.length,
        usedCount: selected.length,
        contextTokens,
        topScore: selected[0]?.score ?? 0,
      },
    },
    timings: { embedQueryMs, retrieveMs, generateMs },
    embeddingInputTokens: embedding.usage.inputTokens,
  }
}
