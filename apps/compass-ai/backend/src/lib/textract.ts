/**
 * AWS Textract OCR for scanned PDFs.
 *
 * Multi-page PDFs require Textract's *asynchronous* API, which reads the document
 * from S3 — so the PDF is staged to the configured bucket, processed, then removed.
 * That avoids rasterizing pages in-process (which would need a native canvas build).
 *
 * Only `DetectDocumentText` (raw OCR) is used. Tables/Forms/Queries are cost-bearing
 * ANALYZE features and stay behind per-client flags for a later phase.
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import {
  TextractClient,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
  type Block,
} from '@aws-sdk/client-textract'
import { awsOcrConfig, type AwsOcrConfig } from './config.js'
import type { ExtractedPage, ExtractedParagraph } from './pdf.js'

export interface OcrResult {
  pageCount: number
  pages: ExtractedPage[]
  paragraphs: ExtractedParagraph[]
  /** Mean Textract confidence per page (0-100), for the pipeline log. */
  pageConfidence: Map<number, number>
  /** Billable pages, used for OCR metering and budget enforcement. */
  billedPages: number
}

export class OcrNotConfiguredError extends Error {
  constructor() {
    super(
      'This document needs OCR, but AWS Textract is not configured. Register AWS_REGION, ' +
        'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and TEXTRACT_S3_BUCKET as app secrets.',
    )
    this.name = 'OcrNotConfiguredError'
  }
}

function clients(config: AwsOcrConfig): { s3: S3Client; textract: TextractClient } {
  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  }
  return {
    s3: new S3Client({ region: config.region, credentials }),
    textract: new TextractClient({ region: config.region, credentials }),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Group Textract LINE blocks into paragraphs, mirroring the native-PDF heuristics. */
function blocksToPages(blocks: Block[]): {
  pages: ExtractedPage[]
  paragraphs: ExtractedParagraph[]
  pageConfidence: Map<number, number>
} {
  interface OcrLine {
    text: string
    top: number
    left: number
    right: number
    bottom: number
    height: number
    confidence: number
  }

  const linesByPage = new Map<number, OcrLine[]>()

  for (const block of blocks) {
    if (block.BlockType !== 'LINE') continue
    const text = block.Text?.trim()
    const box = block.Geometry?.BoundingBox
    if (!text || !box) continue
    const pageNumber = block.Page ?? 1
    const top = box.Top ?? 0
    const left = box.Left ?? 0
    const height = box.Height ?? 0
    const width = box.Width ?? 0

    const list = linesByPage.get(pageNumber) ?? []
    list.push({
      text,
      top,
      left,
      right: left + width,
      bottom: top + height,
      height,
      confidence: block.Confidence ?? 0,
    })
    linesByPage.set(pageNumber, list)
  }

  const pages: ExtractedPage[] = []
  const paragraphs: ExtractedParagraph[] = []
  const pageConfidence = new Map<number, number>()

  for (const pageNumber of [...linesByPage.keys()].sort((a, b) => a - b)) {
    const lines = (linesByPage.get(pageNumber) ?? []).sort((a, b) => a.top - b.top || a.left - b.left)

    const groups: OcrLine[][] = []
    for (const line of lines) {
      const group = groups[groups.length - 1]
      if (!group) {
        groups.push([line])
        continue
      }
      const previous = group[group.length - 1]
      const gap = line.top - previous.bottom
      const lineHeight = Math.max(previous.height, line.height, 0.001)
      if (gap > lineHeight * 0.9) groups.push([line])
      else group.push(line)
    }

    let index = 0
    const pageParagraphs: ExtractedParagraph[] = []
    for (const group of groups) {
      const text = group.map((line) => line.text).join(' ').replace(/\s+/g, ' ').trim()
      if (text.length === 0) continue
      const left = Math.min(...group.map((line) => line.left))
      const right = Math.max(...group.map((line) => line.right))
      const top = Math.min(...group.map((line) => line.top))
      const bottom = Math.max(...group.map((line) => line.bottom))

      pageParagraphs.push({
        pageNumber,
        paragraphIndex: index,
        paragraphKey: `p${pageNumber}-${index}`,
        text,
        // Textract geometry is already normalized with a top-left origin.
        bbox: { x: left, y: top, width: right - left, height: bottom - top },
      })
      index += 1
    }

    const text = pageParagraphs.map((paragraph) => paragraph.text).join('\n\n')
    pages.push({ pageNumber, text, charCount: text.length })
    paragraphs.push(...pageParagraphs)

    if (lines.length > 0) {
      const mean = lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
      pageConfidence.set(pageNumber, mean)
    }
  }

  return { pages, paragraphs, pageConfidence }
}

/**
 * OCR a PDF end to end. Throws `OcrNotConfiguredError` when AWS is not configured,
 * so the caller can mark the document with an actionable status instead of failing
 * opaquely.
 */
export async function ocrPdf(bytes: Uint8Array, documentId: string): Promise<OcrResult> {
  const config = awsOcrConfig()
  if (!config) throw new OcrNotConfiguredError()

  const { s3, textract } = clients(config)
  const key = `compass-ai/ocr-staging/${documentId}.pdf`

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'application/pdf',
      }),
    )

    const start = await textract.send(
      new StartDocumentTextDetectionCommand({
        DocumentLocation: { S3Object: { Bucket: config.bucket, Name: key } },
      }),
    )
    const jobId = start.JobId
    if (!jobId) throw new Error('Textract did not return a JobId')

    const blocks: Block[] = []
    let pageCount = 0
    let nextToken: string | undefined
    let status = 'IN_PROGRESS'
    const deadline = Date.now() + 10 * 60 * 1000

    // Poll for completion, then page through every result page.
    while (Date.now() < deadline) {
      const response = await textract.send(
        new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }),
      )
      status = response.JobStatus ?? 'IN_PROGRESS'

      if (status === 'IN_PROGRESS') {
        await sleep(3000)
        continue
      }
      if (status === 'FAILED') {
        throw new Error(`Textract job failed: ${response.StatusMessage ?? 'unknown reason'}`)
      }

      blocks.push(...(response.Blocks ?? []))
      pageCount = Math.max(pageCount, response.DocumentMetadata?.Pages ?? 0)
      nextToken = response.NextToken
      if (!nextToken) break
    }

    if (status === 'IN_PROGRESS') throw new Error('Textract job timed out after 10 minutes')

    const { pages, paragraphs, pageConfidence } = blocksToPages(blocks)
    return {
      pageCount: pageCount || pages.length,
      pages,
      paragraphs,
      pageConfidence,
      billedPages: pageCount || pages.length,
    }
  } finally {
    // Staging copy is transient; never leave customer documents in the OCR bucket.
    await s3
      .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      .catch((error: unknown) => {
        console.error('[textract] failed to clean up staging object', key, error)
      })
  }
}
