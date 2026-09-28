/**
 * PDF storage via the Gate file service.
 *
 * Document bytes NEVER go into the SQL store — only `storedFileUUID`, `readUrl` and
 * small metadata are persisted. Uploads are brokered here on the backend with the
 * service token, because visitor/app browser tokens are not granted `files.write`.
 */

import { createFilesApi } from './gate.js'
import { orgId, serviceGateAuth } from './config.js'

export interface StoredPdf {
  storedFileUUID: string
  readUrl: string
  size: number
  contentType: string
  filename: string
}

interface UploadedPart {
  etag: string
  partNumber: number
}

/**
 * Read the ETag from a direct S3 PUT. S3 returns it quoted; the complete call wants
 * the value as-is from the response, so only strip surrounding quotes.
 */
function readEtag(response: Response, partNumber: number): UploadedPart {
  const raw = response.headers.get('etag')
  if (!raw) throw new Error(`Upload part ${partNumber} returned no ETag`)
  return { etag: raw.replace(/^"|"$/g, ''), partNumber }
}

async function putPart(url: string, body: Uint8Array, partNumber: number): Promise<UploadedPart> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // Bare PUT with no custom headers — presigned URLs sign `host` only, and any
      // extra header (including Content-Type) breaks the signature. A plain
      // ArrayBuffer body keeps fetch from inferring one.
      const buffer = new ArrayBuffer(body.byteLength)
      new Uint8Array(buffer).set(body)
      const response = await fetch(url, { method: 'PUT', body: buffer })
      if (!response.ok) throw new Error(`Upload part ${partNumber} failed with HTTP ${response.status}`)
      return readEtag(response, partNumber)
    } catch (error) {
      lastError = error
      if (attempt === 3) break
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Upload part ${partNumber} failed`)
}

/** Upload PDF bytes and return the persistable file reference. */
export async function storePdf(
  filename: string,
  bytes: Uint8Array,
  contentType = 'application/pdf',
): Promise<StoredPdf> {
  const auth = serviceGateAuth()
  const api = createFilesApi(auth)
  const org = orgId()

  const start = await api.startMultipartFileUpload({
    path: { orgId: org },
    body: { filename: filename.slice(0, 255), size: bytes.byteLength, contentType, folder: 'apps' },
  })

  const partSize = start.partSize > 0 ? start.partSize : bytes.byteLength
  const parts: UploadedPart[] = []

  for (let index = 0; index < start.partsUrls.length; index += 1) {
    const slice = bytes.subarray(index * partSize, Math.min((index + 1) * partSize, bytes.byteLength))
    parts.push(await putPart(start.partsUrls[index], slice, index + 1))
  }

  const completed = await api.completeMultipartFileUpload({
    path: { orgId: org, uploadId: start.uploadId },
    body: {
      tempStoredfileName: start.tempStoredfileName,
      parts,
      contentType,
      folder: 'apps',
    },
  })

  return {
    storedFileUUID: completed.storedFileUUID,
    readUrl: completed.readUrl,
    size: completed.size,
    contentType: completed.contentType,
    filename: completed.filename,
  }
}

/**
 * Largest file this app will pull into memory, matching the upload path's own cap.
 *
 * Not a guess at what is reasonable: it is the same limit a person uploading by hand
 * hits, and a document arriving by any other route must not be a way around it.
 */
export const MAX_FETCH_BYTES = 100 * 1024 * 1024

/**
 * Fetch previously stored PDF bytes (used by parse, OCR and re-index).
 *
 * **Capped, and checked before the body is read.** The whole file is buffered into
 * one `Uint8Array` and handed to the parser, so an oversized document is not a slow
 * request — it is memory pressure on a replica that is serving every other tenant at
 * the same time. The cap used to live in the dashboard-view reader, which checked a
 * size column before importing; that reader is gone (§5D.1) and a `sql_table` source
 * never had the check at all, so a 200 MB PDF behind a URL column would have been
 * downloaded whole. Enforcing it here covers every path into the pipeline, including
 * any added later.
 *
 * `Content-Length` is a hint, not a guarantee, so the buffered length is checked too:
 * a server that omits or understates the header must not get a free pass.
 */
export async function fetchStoredPdf(readUrl: string): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const response = await fetch(readUrl, { signal: controller.signal })
    if (!response.ok) throw new Error(`Could not read stored document (HTTP ${response.status})`)

    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
      throw new Error(
        `This document is ${(declared / 1024 / 1024).toFixed(0)} MB; the limit is ` +
          `${MAX_FETCH_BYTES / 1024 / 1024} MB. Split it or reduce its size.`,
      )
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_FETCH_BYTES) {
      throw new Error(
        `This document is ${(bytes.byteLength / 1024 / 1024).toFixed(0)} MB; the limit is ` +
          `${MAX_FETCH_BYTES / 1024 / 1024} MB. Split it or reduce its size.`,
      )
    }
    return bytes
  } finally {
    clearTimeout(timer)
  }
}
