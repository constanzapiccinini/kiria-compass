/**
 * Chunking with overlap, built on paragraphs so every chunk keeps an exact page and
 * paragraph provenance. Citations are only as trustworthy as this mapping.
 */

import { CHUNK_MIN_TOKENS, CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS } from './config.js'
import { looksLikeHeadingLine, type ExtractedParagraph } from './pdf.js'

export interface Chunk {
  chunkIndex: number
  /** Page used for the citation — the page the chunk starts on. */
  pageNumber: number
  pageStart: number
  pageEnd: number
  /** Primary paragraph for highlight; the first paragraph in the chunk. */
  paragraphKey: string | null
  paragraphKeys: string[]
  sectionTitle: string | null
  text: string
  tokenCount: number
}

/**
 * Token estimate. Deliberately an approximation: it drives chunk sizing and the
 * retrieval budget only. Billing and usage metering use the token counts OpenAI
 * returns, never this function.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  // ~4 characters per token for English prose, with a word-count floor so that
  // dense technical text with long tokens is not badly underestimated.
  const byChars = text.length / 4
  const byWords = text.split(/\s+/).length * 0.75
  return Math.max(1, Math.round(Math.max(byChars, byWords)))
}

/**
 * A short, title-cased or numbered paragraph is treated as a section heading and
 * carried onto following chunks so answers can cite `[Section Y]`.
 */
function detectHeading(paragraph: ExtractedParagraph): string | null {
  const text = paragraph.text.trim()
  return looksLikeHeadingLine(text) ? text : null
}

/**
 * Pack paragraphs into ~CHUNK_TARGET_TOKENS chunks with ~CHUNK_OVERLAP_TOKENS of
 * trailing overlap, never splitting a paragraph across chunks unless the paragraph
 * alone exceeds the target.
 *
 * A chunk never spans a page boundary. That costs a little context coherence at page
 * breaks, but it is what makes `[Document, Page X]` exactly right for every sentence
 * in the chunk — a chunk covering pages 4 and 5 could only ever cite one of them, and
 * would silently mis-attribute the other half.
 *
 * A section title, by contrast, does carry across pages, because a section genuinely
 * continues past a page break.
 */
export function chunkParagraphs(paragraphs: ExtractedParagraph[]): Chunk[] {
  // Pre-pass: resolve the section heading in effect at each paragraph, so a chunk
  // reports the section it STARTS in rather than the last heading it happens to
  // contain. A paragraph that is itself a heading belongs to its own section.
  const sections = new Map<string, string | null>()
  let running: string | null = null
  for (const paragraph of paragraphs) {
    const heading = detectHeading(paragraph)
    if (heading) running = heading
    sections.set(paragraph.paragraphKey, running)
  }
  const sectionOf = (paragraph: ExtractedParagraph): string | null =>
    sections.get(paragraph.paragraphKey) ?? null

  const chunks: Chunk[] = []
  let buffer: ExtractedParagraph[] = []
  let bufferTokens = 0
  let chunkIndex = 0
  let currentPage: number | null = null
  // Section in effect where the OPEN chunk began — not the latest heading seen.
  let bufferSection: string | null = null

  const flush = (): void => {
    if (buffer.length === 0) return

    const text = buffer.map((paragraph) => paragraph.text).join('\n\n').trim()
    const tokenCount = estimateTokens(text)
    const previous = chunks[chunks.length - 1]
    const bufferPage = buffer[0].pageNumber

    // Too small to stand alone — fold it into the previous chunk, but only when that
    // chunk is on the same page, or the merge would break the page-exact citation.
    if (tokenCount < CHUNK_MIN_TOKENS && previous !== undefined && previous.pageNumber === bufferPage) {
      previous.text = `${previous.text}\n\n${text}`.trim()
      previous.tokenCount = estimateTokens(previous.text)
      previous.paragraphKeys = [...previous.paragraphKeys, ...buffer.map((p) => p.paragraphKey)]
      buffer = []
      bufferTokens = 0
      return
    }

    const pageNumbers = buffer.map((paragraph) => paragraph.pageNumber)
    chunks.push({
      chunkIndex,
      pageNumber: pageNumbers[0],
      pageStart: Math.min(...pageNumbers),
      pageEnd: Math.max(...pageNumbers),
      paragraphKey: buffer[0].paragraphKey,
      paragraphKeys: buffer.map((paragraph) => paragraph.paragraphKey),
      sectionTitle: bufferSection,
      text,
      tokenCount,
    })
    chunkIndex += 1

    // Carry the tail of this chunk into the next one so a fact split across the
    // boundary still appears whole in at least one chunk.
    const overlap: ExtractedParagraph[] = []
    let overlapTokens = 0
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      const tokens = estimateTokens(buffer[i].text)
      if (overlapTokens + tokens > CHUNK_OVERLAP_TOKENS) break
      overlap.unshift(buffer[i])
      overlapTokens += tokens
    }
    // Never let overlap alone fill a whole chunk, or packing cannot make progress.
    buffer = overlap.length < buffer.length ? overlap : []
    bufferTokens = buffer.reduce((sum, paragraph) => sum + estimateTokens(paragraph.text), 0)
    bufferSection = buffer.length > 0 ? sectionOf(buffer[0]) : null
  }

  for (const paragraph of paragraphs) {
    // Close the open chunk at every page boundary so no chunk spans two pages.
    if (currentPage !== null && paragraph.pageNumber !== currentPage) {
      flush()
      buffer = [] // overlap must not leak across a page boundary either
      bufferTokens = 0
    }
    currentPage = paragraph.pageNumber

    const tokens = estimateTokens(paragraph.text)

    if (tokens > CHUNK_TARGET_TOKENS) {
      // A single oversized paragraph: emit what we have, then split it on sentences.
      flush()
      for (const piece of splitLongParagraph(paragraph)) {
        buffer = [piece]
        bufferTokens = estimateTokens(piece.text)
        bufferSection = sectionOf(paragraph)
        flush()
      }
      continue
    }

    if (bufferTokens + tokens > CHUNK_TARGET_TOKENS) flush()

    if (buffer.length === 0) bufferSection = sectionOf(paragraph)
    buffer.push(paragraph)
    bufferTokens += tokens
  }

  flush()
  // The final flush may leave an overlap-only remainder; emit nothing for it.
  return chunks
}

/** Split an oversized paragraph on sentence boundaries, keeping its page identity. */
function splitLongParagraph(paragraph: ExtractedParagraph): ExtractedParagraph[] {
  const sentences = paragraph.text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [paragraph.text]
  const pieces: ExtractedParagraph[] = []
  let current = ''

  for (const sentence of sentences) {
    const candidate = current.length === 0 ? sentence : `${current}${sentence}`
    if (estimateTokens(candidate) > CHUNK_TARGET_TOKENS && current.length > 0) {
      pieces.push({ ...paragraph, text: current.trim() })
      current = sentence
    } else {
      current = candidate
    }
  }
  if (current.trim().length > 0) pieces.push({ ...paragraph, text: current.trim() })

  return pieces
}
