/**
 * Clickable links inside a rendered PDF.
 *
 * The viewer rasterizes each page to a canvas, and a canvas has no links in it — a URL
 * printed in the source document was, until now, a picture of a URL. This module adds
 * PDF.js's annotation layer over the canvas so the link annotations the document
 * actually carries become real anchors.
 *
 * Only link annotations are wanted. Form widgets, popups and file attachments are
 * deliberately not rendered: this is a read-only viewer for documents KIRIA published,
 * and an editable form field or an attachment download in a client portal is a surface
 * nobody asked for.
 *
 * ---------------------------------------------------------------------------
 * The security boundary, because the input is a client-supplied file
 *
 * A PDF is untrusted content. Its annotations can name any URI the author liked,
 * `javascript:` included, so rendering them naively would be a script-injection surface
 * in a pharmaceutical client portal.
 *
 * Two things stop that, and it is worth being precise about which does what:
 *
 *   1. **PDF.js itself rejects the dangerous schemes.** `createValidAbsoluteUrl`
 *      allow-lists `http:`, `https:`, `ftp:`, `mailto:` and `tel:` and returns null for
 *      everything else, so a `javascript:` annotation never reaches this code with a
 *      URL at all. That is the library's guarantee, not ours, which is why it is named
 *      here — if it ever changes, this comment is wrong and the tests below are what
 *      would say so.
 *   2. **Every anchor is forced into a new tab**, by `addLinkAttributes`. PDF.js would
 *      otherwise honour the document's own `newWindow` flag, and this app runs inside
 *      a portal iframe: a same-frame navigation would replace the product with whatever
 *      the PDF pointed at, which looks to the client like Compass took them somewhere.
 *      `rel="noopener noreferrer"` goes with it so the opened page gets neither a
 *      handle on our window nor a referrer naming the portal.
 *
 * The forcing is unconditional. Honouring `newWindow === false` for "trusted" documents
 * was considered and rejected: there is no trust signal on a PDF that survives being
 * re-uploaded, and the failure mode of getting it wrong is a client's viewer being
 * navigated away by a file.
 */

import { AnnotationLayer } from 'pdfjs-dist'
import type { PDFPageProxy } from 'pdfjs-dist'

/**
 * The subset of PDF.js's link-service contract the annotation layer actually calls.
 *
 * Written out rather than imported: `PDFLinkService` lives in `pdfjs-dist/web`, which
 * is the full viewer bundle — toolbars, sidebars, an event bus and a find controller —
 * and pulling it in to get five methods would add far more than it explains. The
 * members below were taken from the call sites in `pdf.mjs` rather than guessed.
 */
export interface LinkLayerService {
  externalLinkTarget: number | null
  externalLinkRel: string | null
  externalLinkEnabled: boolean
  getDestinationHash(dest: unknown): string
  getAnchorUrl(hash: string): string
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void
  goToDestination(dest: unknown): Promise<void>
  executeNamedAction(action: string): void
  executeSetOCGState(): void
  getAttachmentContent?(): Promise<unknown>
}

/**
 * Resolve a PDF destination to a 1-based page number.
 *
 * A destination is either a named string that has to be looked up, or an explicit
 * array whose first element is a page reference. Both end at `getPageIndex`.
 *
 * Returns null rather than throwing on anything unexpected. A malformed destination in
 * a client's document should make one link inert, not break the page it is on.
 */
async function destinationToPage(
  doc: { getDestination(id: string): Promise<unknown>; getPageIndex(ref: unknown): Promise<number> },
  dest: unknown,
): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || explicit.length === 0) return null
    const index = await doc.getPageIndex(explicit[0])
    return index + 1
  } catch {
    return null
  }
}

/**
 * Build the link service for one document.
 *
 * `onNavigate` receives a 1-based page number for an internal link — a table of
 * contents entry, a cross-reference — and is expected to scroll the viewer there. The
 * viewer already has `scrollToPage` for citations, so internal links land on the same
 * behaviour a citation click does, which is the point: two ways of arriving at a page
 * should not feel like two different products.
 */
export function createLinkService(
  doc: { getDestination(id: string): Promise<unknown>; getPageIndex(ref: unknown): Promise<number> },
  onNavigate: (pageNumber: number) => void,
): LinkLayerService {
  return {
    // 2 is pdf.js's `LinkTarget.BLANK`. Set here as well as forced in
    // `addLinkAttributes` because the layer consults it for some element types before
    // ever calling us.
    externalLinkTarget: 2,
    externalLinkRel: 'noopener noreferrer',
    externalLinkEnabled: true,

    // Internal navigation is handled by `goToDestination`, so there is no URL hash for
    // the layer to build. Returning an empty string keeps the anchor inert until our
    // click handler runs, rather than letting the browser follow a `#` and scroll the
    // portal iframe to its own top.
    getDestinationHash: () => '',
    getAnchorUrl: () => '',

    addLinkAttributes(link, url, newWindow) {
      link.href = url
      // Unconditional: see the docblock. `newWindow` is the PDF's own preference and
      // it does not get one here.
      void newWindow
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      // The URL, visible before clicking. A link in a client portal that does not say
      // where it goes is one a careful reader is right not to trust.
      link.title = url
    },

    async goToDestination(dest) {
      const pageNumber = await destinationToPage(doc, dest)
      if (pageNumber !== null) onNavigate(pageNumber)
    },

    // Named actions are viewer chrome — NextPage, Print, Find. This viewer has its own
    // controls and a document should not be able to drive them.
    executeNamedAction: () => {},
    executeSetOCGState: () => {},
  }
}

/**
 * Just enough of the layer instance to render links.
 *
 * `pdfjs-dist` generates its types from JSDoc, and the generated `render` signature
 * demands the full `AnnotationLayerParameters` — viewport, div, page, linkService,
 * renderForms — while the running code reads only `annotations` and
 * `optionalContentConfig` from it. Declaring what we actually call, and letting
 * TypeScript's bivariant method checking match the wider signature to it, keeps this
 * honest without a cast: nothing here claims the object is something it is not.
 */
interface LinkLayer {
  render(params: { annotations: unknown[]; renderForms: boolean }): Promise<void>
}

/**
 * Construct the annotation layer for one page.
 *
 * Every constructor key is passed explicitly, including the six this viewer has no use
 * for. The generated type marks them all required, and spelling them out as `null` is
 * both what satisfies it and a readable statement of what is deliberately absent —
 * there is no accessibility manager, no editor, no comment manager and no annotation
 * storage here, because this is a read-only viewer.
 */
export function createLinkLayer(params: {
  div: HTMLDivElement
  page: PDFPageProxy
  viewport: unknown
  linkService: LinkLayerService
}): LinkLayer {
  return new AnnotationLayer({
    div: params.div,
    page: params.page,
    viewport: params.viewport,
    linkService: params.linkService,
    accessibilityManager: null,
    annotationCanvasMap: null,
    annotationEditorUIManager: null,
    structTreeLayer: null,
    commentManager: null,
    annotationStorage: null,
  })
}

/**
 * Link annotations for a page, or an empty list.
 *
 * `intent: 'display'` is what filters out the annotation types a print pipeline would
 * want, and the explicit subtype filter is what keeps this to links: `getAnnotations`
 * still returns widgets, popups and text notes, and the annotation layer would happily
 * render all of them.
 */
export async function linkAnnotations(page: PDFPageProxy): Promise<unknown[]> {
  try {
    const all = await page.getAnnotations({ intent: 'display' })
    return all.filter((annotation: { subtype?: string }) => annotation.subtype === 'Link')
  } catch {
    // A document with a broken annotation table should still render its pages.
    return []
  }
}
