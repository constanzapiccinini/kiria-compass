/**
 * PDF.js setup for the browser.
 *
 * The worker is imported with Vite's `?url` so it is emitted as a real asset and
 * versioned with the bundle — a CDN worker would break the app on any CSP that
 * restricts script sources, and could drift out of sync with the library version.
 */

import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { portalHeaders } from './portal'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type { PDFDocumentProxy, PDFPageProxy }

/**
 * Load a document through the app backend rather than the file service's public URL,
 * so the tenancy check applies to the bytes and the request stays same-origin.
 *
 * `httpHeaders` is what makes this work at all, and it is easy to lose: pdf.js issues
 * its own XHR instead of going through the app's fetch wrapper, so it does not pick up
 * `portalHeaders()` the way every other backend call does. Without it the request
 * arrives with no `x-portal-context` and the backend correctly refuses it with
 * `PORTAL_CONTEXT_MISSING` — which surfaces to the user as pdf.js's opaque
 * "unexpected server response (400)".
 *
 * The token goes in a header and never in the query string. The backend accepts
 * `?portalFeatureContextToken=` as well, but a token in a URL ends up in access logs,
 * referrers and browser history.
 */
export function loadDocument(documentId: string): {
  promise: Promise<PDFDocumentProxy>
  cancel: () => void
} {
  const task = pdfjs.getDocument({
    url: `/api/documents/${documentId}/file`,
    withCredentials: true,
    httpHeaders: portalHeaders(),
    // Served from public/ by scripts/copy-pdfjs-assets.mjs: same-origin, versioned
    // with the deploy, and no CDN dependency. Missing cmaps render CJK text blank;
    // missing standard fonts break base-14 font metrics.
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
  })

  return {
    promise: task.promise,
    cancel: () => {
      void task.destroy()
    },
  }
}

/** Rendered size of a page at a given scale, rounded to whole device pixels. */
export function pageViewport(page: PDFPageProxy, scale: number): { width: number; height: number } {
  const viewport = page.getViewport({ scale })
  return { width: Math.floor(viewport.width), height: Math.floor(viewport.height) }
}
