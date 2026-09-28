/**
 * Native PDF text extraction with page structure preserved.
 *
 * Uses pdfjs-dist's legacy (Node) build, which extracts the text layer without any
 * canvas/native dependency. Paragraphs are reconstructed from text-item geometry so
 * a citation can name an exact page and paragraph, and the viewer can highlight a
 * normalized bounding box.
 */

export interface ExtractedParagraph {
  pageNumber: number
  paragraphIndex: number
  paragraphKey: string
  text: string
  /** Normalized to the page box: x/y/width/height in the 0..1 range, origin top-left. */
  bbox: { x: number; y: number; width: number; height: number }
}

export interface ExtractedPage {
  pageNumber: number
  text: string
  charCount: number
}

export interface ExtractedPdf {
  pageCount: number
  pages: ExtractedPage[]
  paragraphs: ExtractedParagraph[]
  /** True when the text layer is absent — i.e. a scanned PDF. */
  needsOcr: boolean
  /** Pages with effectively no text layer, for the ingestion status detail. */
  emptyPageCount: number
}

/**
 * A page with fewer than this many characters has effectively no text layer.
 *
 * Set low deliberately. A scanned page yields ~0 extractable characters, while a
 * legitimately short page — a conclusion, a signature block, a section divider —
 * yields a few dozen. An earlier 80-character threshold sent a perfectly readable
 * two-page report to OCR because its 63-character conclusion page looked "sparse",
 * and with OCR unconfigured that rejected the document outright.
 */
const EMPTY_PAGE_CHARS = 24

/** Most pages must look empty before the document is treated as a scan. */
const OCR_PAGE_RATIO = 0.6

/**
 * A document with at least this much text overall has a real text layer, whatever
 * the per-page distribution looks like. Guards against a short document with one
 * empty page tipping the ratio.
 */
const MIN_TOTAL_CHARS = 200

interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

interface PdfLine {
  text: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * pdfjs returns a union of text items and marked-content markers. Read the fields we
 * need and skip anything that is not a real text run.
 */
function readTextItem(value: unknown): PdfTextItem | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  if (typeof item.str !== 'string' || !Array.isArray(item.transform)) return null

  const transform = item.transform.filter((n): n is number => typeof n === 'number')
  if (transform.length < 6) return null

  return {
    str: item.str,
    transform,
    width: typeof item.width === 'number' ? item.width : 0,
    height: typeof item.height === 'number' ? item.height : 0,
  }
}

/**
 * Group text items into visual lines by their baseline y, then merge adjacent lines
 * into paragraphs when the vertical gap stays close to the line height.
 */
function itemsToLines(items: PdfTextItem[]): PdfLine[] {
  const lines: PdfLine[] = []

  for (const item of items) {
    const text = item.str
    if (text.trim().length === 0) continue

    const x = item.transform[4]
    const y = item.transform[5]
    const height = Math.abs(item.height) || Math.abs(item.transform[3]) || 10
    const width = Math.abs(item.width) || text.length * height * 0.5

    const current = lines[lines.length - 1]
    // Same line when baselines are within a third of the line height.
    if (current && Math.abs(current.y - y) <= Math.max(2, height / 3)) {
      const gap = x - (current.x + current.width)
      const needsSpace = gap > height * 0.2 && !current.text.endsWith(' ') && !text.startsWith(' ')
      current.text += (needsSpace ? ' ' : '') + text
      current.width = Math.max(current.x + current.width, x + width) - current.x
      current.x = Math.min(current.x, x)
      current.height = Math.max(current.height, height)
    } else {
      lines.push({ text, x, y, width, height })
    }
  }

  return lines
}

/**
 * A line that reads as a section heading — numbered, or a short all-caps/title-case
 * line with no terminal period. Headings are split into their own paragraph so the
 * chunker can attach a section title to the passages that follow them, even in
 * documents whose leading gives headings no extra vertical space.
 */
export function looksLikeHeadingLine(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 120) return false

  const isNumbered = /^(\d+(\.\d+)*|[IVXLC]+|[A-Z])[.)]\s+\S/.test(trimmed)
  if (isNumbered) return true
  // Beyond numbering, require no sentence-ending period and a short line.
  if (trimmed.endsWith('.')) return false

  const words = trimmed.split(/\s+/)
  if (words.length > 12) return false
  const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)
  const capitalized = words.filter((word) => /^[A-Z0-9]/.test(word)).length
  return isAllCaps || capitalized >= Math.ceil(words.length * 0.6)
}

function linesToParagraphs(
  lines: PdfLine[],
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
): ExtractedParagraph[] {
  const groups: PdfLine[][] = []

  for (const line of lines) {
    const group = groups[groups.length - 1]
    if (group === undefined) {
      groups.push([line])
      continue
    }
    const previous = group[group.length - 1]
    const verticalGap = previous.y - line.y
    const lineHeight = Math.max(previous.height, line.height)
    // A gap noticeably larger than one line, or a jump back up (new column), breaks
    // the paragraph. Very short previous lines usually end a paragraph too.
    const isNewParagraph =
      verticalGap > lineHeight * 1.8 ||
      verticalGap < -lineHeight ||
      (previous.text.trim().endsWith('.') === false && verticalGap > lineHeight * 1.5) ||
      // Split a heading away from the body text that follows it, and start a new
      // paragraph at a heading even when the leading is perfectly uniform.
      looksLikeHeadingLine(previous.text) ||
      looksLikeHeadingLine(line.text)

    if (isNewParagraph) groups.push([line])
    else group.push(line)
  }

  const paragraphs: ExtractedParagraph[] = []
  let index = 0

  for (const group of groups) {
    const text = group
      .map((line) => line.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length === 0) continue

    const left = Math.min(...group.map((line) => line.x))
    const right = Math.max(...group.map((line) => line.x + line.width))
    const bottom = Math.min(...group.map((line) => line.y))
    const top = Math.max(...group.map((line) => line.y + line.height))

    paragraphs.push({
      pageNumber,
      paragraphIndex: index,
      paragraphKey: `p${pageNumber}-${index}`,
      text,
      bbox: {
        x: clamp01(left / pageWidth),
        // PDF origin is bottom-left; the viewer wants top-left.
        y: clamp01(1 - top / pageHeight),
        width: clamp01((right - left) / pageWidth),
        height: clamp01((top - bottom) / pageHeight),
      },
    })
    index += 1
  }

  return paragraphs
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Extract pages and paragraphs from PDF bytes.
 * Returns `needsOcr: true` when the text layer is absent or too sparse.
 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  // The legacy build is the Node-safe entrypoint; the default build assumes a DOM.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  // No DOM in Node: skip the font work we do not need for a text-only extraction.
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
  })
  const doc = await loadingTask.promise

  const pages: ExtractedPage[] = []
  const paragraphs: ExtractedParagraph[] = []
  const pageCount = doc.numPages
  let emptyPages = 0

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        const items = content.items.flatMap((entry) => {
          const item = readTextItem(entry)
          return item ? [item] : []
        })

        const lines = itemsToLines(items)
        const pageParagraphs = linesToParagraphs(lines, pageNumber, viewport.width, viewport.height)
        const text = pageParagraphs.map((paragraph) => paragraph.text).join('\n\n')

        pages.push({ pageNumber, text, charCount: text.length })
        paragraphs.push(...pageParagraphs)
        if (text.trim().length < EMPTY_PAGE_CHARS) emptyPages += 1
      } finally {
        page.cleanup()
      }
    }
  } finally {
    await loadingTask.destroy()
  }

  const totalChars = pages.reduce((sum, page) => sum + page.text.trim().length, 0)
  // A scan has almost no text on almost every page. Both conditions must hold, so a
  // short document with one empty page is still indexed from its text layer.
  const needsOcr =
    pages.length === 0 ||
    (emptyPages / pages.length >= OCR_PAGE_RATIO && totalChars < MIN_TOTAL_CHARS)

  return { pageCount, pages, paragraphs, needsOcr, emptyPageCount: emptyPages }
}
