/**
 * PDF storage via the Gate file service (§9.4).
 *
 * Document bytes NEVER go into the SQL store — only `storedFileUUID`, `readUrl` and
 * small metadata are persisted. The upload is brokered here on the backend with the
 * service token, because browser tokens are not granted `files.write`.
 *
 * ## Why this is duplicated from the client app rather than shared
 *
 * The two apps deliberately share no code and no backend: each owns its own
 * `backend/` folder, and the platform gives an app access only to its own. So this is
 * a copy of `apps/compass-ai/backend/src/lib/files.ts`, and the copy is the
 * *sanctioned* arrangement rather than a shortcut.
 *
 * Two consequences worth writing down, because they will outlive this comment:
 *
 * 1. **A fix here does not fix the other one.** The presigned-PUT details below were
 *    each learned from a real failure, and if one is ever corrected it must be
 *    corrected in both files.
 * 2. **The admin needs its own `files.write` grant.** Permissions are per app, so
 *    granting the client app was not enough:
 *    `fusebase app update 79mh8hv7ti9uvzgg --sync-gate-permissions`.
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
 * Read the ETag from a direct S3 PUT.
 *
 * S3 returns it quoted and the complete call wants the raw value, so only the
 * surrounding quotes come off — trimming anything else corrupts the part manifest and
 * the completion fails with a signature error that names nothing useful.
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
      // Bare PUT with NO custom headers. Presigned URLs sign `host` only, so any extra
      // header — Content-Type included — breaks the signature. Copying the bytes into
      // a plain ArrayBuffer keeps `fetch` from inferring one on our behalf.
      const buffer = new ArrayBuffer(body.byteLength)
      new Uint8Array(buffer).set(body)
      const response = await fetch(url, { method: 'PUT', body: buffer })
      if (!response.ok) {
        throw new Error(`Upload part ${partNumber} failed with HTTP ${response.status}`)
      }
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
    body: {
      filename: filename.slice(0, 255),
      size: bytes.byteLength,
      contentType,
      folder: 'apps',
    },
  })

  const partSize = start.partSize > 0 ? start.partSize : bytes.byteLength
  const parts: UploadedPart[] = []

  for (let index = 0; index < start.partsUrls.length; index += 1) {
    const slice = bytes.subarray(
      index * partSize,
      Math.min((index + 1) * partSize, bytes.byteLength),
    )
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
