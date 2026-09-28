/**
 * Scrollable PDF viewer with a thumbnail rail, zoom, and citation navigation.
 *
 * Citation targets arrive as a page number plus a `paragraphKey`. Paragraph geometry
 * is fetched per page from the backend and cached, so jumping to a citation in a
 * 400-page document does not pull the whole document's paragraph set.
 *
 * ---------------------------------------------------------------------------
 * Fit to width (§7.2)
 *
 * The scale was `useState(1.1)` — a fixed zoom, with the container left to clip
 * whatever did not fit. That is one of the three causes of *"I only see the whole
 * document if I close both sidebars"*: at 1.1 a US Letter page wants ~673px, and the
 * sidebar, the thumbnail rail, the padding and the chat panel together want ~868px
 * more than most portal iframes have.
 *
 * So the default is now **fit-to-width**, measured from the scroll container with a
 * `ResizeObserver`. The observer is the load-bearing part, not an optimisation:
 * collapsing the sidebar or docking the chat changes this container's width and fires
 * **no window resize event**, which is exactly why the old layout only recovered when
 * something was closed *and* the user happened to scroll.
 *
 * The widest page decides the scale, not page one. A document with a single landscape
 * page must not push every portrait page off-screen — and fitting to page 1 would do
 * precisely that, invisibly, for the one document where it matters.
 *
 * Zooming switches to `'manual'` and stays there until **Fit** is pressed. The mode
 * is remembered per portal, best-effort: a private window degrades to fit-to-width,
 * never to a blank viewer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Box,
  Flex,
  HStack,
  IconButton,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from 'lucide-react'
import { api, type ParagraphBox } from '@/lib/client'
import { loadDocument, type PDFDocumentProxy } from '@/lib/pdf'
import { fitScale, widestPage, MAX_SCALE, MIN_SCALE } from '@/lib/fit'
import { PdfPage, type HighlightBox } from '@/components/PdfPage'
import { PdfThumbnail } from '@/components/PdfThumbnail'

export interface CitationTarget {
  documentId: string
  page: number
  paragraphKey: string | null
  /** Changes on every click so re-clicking the same citation re-triggers the jump. */
  nonce: number
}

interface PdfViewerProps {
  documentId: string
  documentName: string
  target: CitationTarget | null
  /** Scopes the remembered fit mode, so two portals do not share one preference. */
  portalId: string
}

const SCALE_STEP = 0.2
/** Below this the 132px thumbnail rail is 15% of the screen; it hides (§7.7). */
const RAIL_BREAKPOINT = 900

type FitMode = 'width' | 'manual'

/**
 * The remembered fit mode for this portal.
 *
 * Returns `'width'` on any failure. A thrown `localStorage` — private windows,
 * blocked site data, thumbnail capture — must never decide what the viewer does, and
 * "fit" is the mode that is right when nothing is known.
 */
function readFitMode(portalId: string): FitMode {
  try {
    return window.localStorage.getItem(`compass:viewer:fit:${portalId}`) === 'manual'
      ? 'manual'
      : 'width'
  } catch {
    return 'width'
  }
}

function writeFitMode(portalId: string, mode: FitMode): void {
  try {
    window.localStorage.setItem(`compass:viewer:fit:${portalId}`, mode)
  } catch {
    // A preference that cannot be saved is not worth surfacing to the user.
  }
}

export function PdfViewer({ documentId, documentName, target, portalId }: PdfViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  const [fitMode, setFitMode] = useState<FitMode>(() => readFitMode(portalId))
  const [currentPage, setCurrentPage] = useState(1)
  /** The widest page at scale 1, in CSS px. Null until the document is measured. */
  const [widestPageWidth, setWidestPageWidth] = useState<number | null>(null)
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const [railOpen, setRailOpen] = useState(true)

  /** page number -> paragraph boxes, fetched lazily. */
  const [paragraphsByPage, setParagraphsByPage] = useState<Map<number, ParagraphBox[]>>(new Map())
  const [focusedParagraphKey, setFocusedParagraphKey] = useState<string | null>(null)

  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const requestedPages = useRef(new Set<number>())

  // --- load the document -------------------------------------------------
  useEffect(() => {
    setDoc(null)
    setLoadError(null)
    setCurrentPage(1)
    setParagraphsByPage(new Map())
    setFocusedParagraphKey(null)
    // Cleared so the fit recomputes for the new document rather than briefly using
    // the previous one's widest page — which is a visible jump, and wrong.
    setWidestPageWidth(null)
    pageRefs.current.clear()
    requestedPages.current.clear()

    const { promise, cancel } = loadDocument(documentId)
    let cancelled = false

    promise.then(
      (loaded) => {
        if (cancelled) return
        setDoc(loaded)
      },
      (cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof Error ? cause.message : 'The document could not be opened.',
        )
      },
    )

    // Destroying the loading task is what frees the worker and its page cache — the
    // document proxy itself has no destroy in pdfjs 6. This covers both unmount and
    // switching to another document.
    return () => {
      cancelled = true
      cancel()
    }
  }, [documentId])

  // --- measure the document: the WIDEST page, not the first --------------
  useEffect(() => {
    if (!doc) return
    let cancelled = false

    void (async () => {
      const widths: number[] = []
      // Capped: a 400-page document does not need 400 viewport reads to know its
      // widest page, and the pages that differ in size are essentially always near
      // the front (a cover, a fold-out schedule). The cap is a deliberate trade —
      // stated here so a clipped page in a very long, very irregular document is a
      // known limitation rather than a mystery.
      const sampled = Math.min(doc.numPages, 20)
      for (let pageNumber = 1; pageNumber <= sampled; pageNumber += 1) {
        try {
          const page = await doc.getPage(pageNumber)
          if (cancelled) return
          widths.push(page.getViewport({ scale: 1 }).width)
        } catch {
          // One unreadable page must not leave the viewer with no scale at all.
        }
      }
      const widest = widestPage(widths)
      if (!cancelled && widest !== null) setWidestPageWidth(widest)
    })()

    return () => {
      cancelled = true
    }
  }, [doc])

  // --- observe the container, not the window ----------------------------
  //
  // `window.resize` does not fire when the sidebar collapses or the chat docks, and
  // those are the two events that change how much room the page has. Observing the
  // element is the whole fix.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const measure = (): void => setContainerWidth(element.clientWidth)
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [doc])

  // The fitted scale, rounded to two decimals so a one-pixel container change does
  // not produce a re-render — and, worse, a re-render of every canvas in the document.
  const fittedScale = useMemo(
    () => fitScale(containerWidth, widestPageWidth),
    [widestPageWidth, containerWidth],
  )

  useEffect(() => {
    if (fitMode !== 'width' || fittedScale === null) return
    setScale((current) => (current === fittedScale ? current : fittedScale))
  }, [fitMode, fittedScale])

  /** Zooming is a decision to stop fitting; it holds until Fit is pressed. */
  const zoomTo = useCallback(
    (next: number) => {
      setFitMode('manual')
      writeFitMode(portalId, 'manual')
      setScale(Number(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)).toFixed(2)))
    },
    [portalId],
  )

  const fitToWidth = useCallback(() => {
    setFitMode('width')
    writeFitMode(portalId, 'width')
    if (fittedScale !== null) setScale(fittedScale)
  }, [portalId, fittedScale])

  // The rail costs a permanent 132px, which is 15% of a 900px screen for something a
  // reader rarely uses. Hidden below that width, with the control below to bring it
  // back — removed entirely was the other option, and it is still on the table (§9.3).
  const railFits = containerWidth === null || containerWidth + 132 >= RAIL_BREAKPOINT
  const showRail = railOpen && railFits

  // --- paragraph geometry, fetched per page ------------------------------
  const ensureParagraphs = useCallback(
    async (pageNumber: number) => {
      if (requestedPages.current.has(pageNumber)) return
      requestedPages.current.add(pageNumber)
      try {
        const response = await api.listParagraphs(documentId, pageNumber)
        setParagraphsByPage((current) => {
          const next = new Map(current)
          next.set(pageNumber, response.paragraphs)
          return next
        })
      } catch {
        // Geometry is an enhancement: without it the page still renders, the
        // citation just cannot draw a box. Allow a later retry.
        requestedPages.current.delete(pageNumber)
      }
    },
    [documentId],
  )

  const registerRef = useCallback((pageNumber: number, element: HTMLDivElement | null) => {
    if (element) pageRefs.current.set(pageNumber, element)
    else pageRefs.current.delete(pageNumber)
  }, [])

  const handleVisible = useCallback(
    (pageNumber: number) => {
      setCurrentPage(pageNumber)
      void ensureParagraphs(pageNumber)
    },
    [ensureParagraphs],
  )

  const scrollToPage = useCallback((pageNumber: number) => {
    const element = pageRefs.current.get(pageNumber)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return true
    }
    return false
  }, [])

  // --- citation navigation ----------------------------------------------
  useEffect(() => {
    if (!target || !doc || target.documentId !== documentId) return

    const page = Math.min(Math.max(1, target.page), doc.numPages)
    setCurrentPage(page)
    void ensureParagraphs(page)
    setFocusedParagraphKey(target.paragraphKey)

    // The target page may not be mounted yet on a fresh document; retry briefly.
    let attempts = 0
    const tryScroll = (): void => {
      if (scrollToPage(page) || attempts > 20) return
      attempts += 1
      window.setTimeout(tryScroll, 100)
    }
    tryScroll()

    // Drop the pulse after it has played so later renders are calm.
    const clear = window.setTimeout(() => setFocusedParagraphKey(null), 3200)
    return () => window.clearTimeout(clear)
  }, [target, doc, documentId, ensureParagraphs, scrollToPage])

  const highlightsFor = useCallback(
    (pageNumber: number): HighlightBox[] => {
      if (!focusedParagraphKey) return []
      const boxes = paragraphsByPage.get(pageNumber)
      if (!boxes) return []
      return boxes
        .filter((box) => box.paragraphKey === focusedParagraphKey && box.bbox !== null)
        .map((box) => ({
          paragraphKey: box.paragraphKey,
          x: box.bbox?.x ?? 0,
          y: box.bbox?.y ?? 0,
          width: box.bbox?.width ?? 0,
          height: box.bbox?.height ?? 0,
        }))
    },
    [paragraphsByPage, focusedParagraphKey],
  )

  const pageNumbers = useMemo(
    () => (doc ? Array.from({ length: doc.numPages }, (_, index) => index + 1) : []),
    [doc],
  )

  if (loadError) {
    return (
      <Flex direction="column" align="center" justify="center" h="full" p="8" gap="2">
        <Box color="danger.fg">
          <AlertTriangle size={20} />
        </Box>
        <Text fontSize="sm" fontWeight="medium">
          Could not open {documentName}
        </Text>
        <Text fontSize="xs" color="fg.muted" maxW="sm" textAlign="center">
          {loadError}
        </Text>
      </Flex>
    )
  }

  if (!doc) {
    return (
      <Flex direction="column" align="center" justify="center" h="full" gap="3">
        <Spinner color="accent.solid" />
        <Text fontSize="sm" color="fg.muted">
          Opening {documentName}…
        </Text>
      </Flex>
    )
  }

  return (
    <Flex direction="column" h="full" overflow="hidden">
      {/* toolbar */}
      <Flex
        align="center"
        justify="space-between"
        px="3"
        py="2"
        borderBottomWidth="1px"
        borderColor="border.default"
        bg="bg.surface"
        gap="3"
      >
        {/* `minW="0"` is what makes `truncate` actually truncate (§7.7). A flex item
            defaults to `min-width: auto`, so it will not shrink below its content's
            intrinsic width — `text-overflow: ellipsis` never engages, and a long
            document name pushes the page and zoom controls off the right of the row
            instead. `flex="1"` lets it take the space that is left rather than only
            the space it wants; the controls beside it are already `flexShrink="0"`. */}
        <Text
          fontSize="sm"
          fontWeight="medium"
          truncate
          flex="1"
          minW="0"
          title={documentName}
          data-viewer-title={documentName}
          data-viewer-doc-id={documentId}
        >
          {documentName}
        </Text>

        <HStack gap="1" flexShrink="0">
          <IconButton
            aria-label="Previous page"
            size="xs"
            variant="ghost"
            disabled={currentPage <= 1}
            onClick={() => scrollToPage(currentPage - 1)}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <Badge size="sm" variant="subtle" minW="16" justifyContent="center">
            {currentPage} / {doc.numPages}
          </Badge>
          <IconButton
            aria-label="Next page"
            size="xs"
            variant="ghost"
            disabled={currentPage >= doc.numPages}
            onClick={() => scrollToPage(currentPage + 1)}
          >
            <ChevronRight size={15} />
          </IconButton>

          <Box w="1" />

          <IconButton
            aria-label={railOpen ? 'Hide page thumbnails' : 'Show page thumbnails'}
            aria-pressed={showRail}
            title={railFits ? undefined : 'The window is too narrow for the thumbnails'}
            size="xs"
            variant="ghost"
            disabled={!railFits}
            onClick={() => setRailOpen((open) => !open)}
          >
            {showRail ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </IconButton>

          <Box w="1" />

          <IconButton
            aria-label="Zoom out"
            size="xs"
            variant="ghost"
            disabled={scale <= MIN_SCALE}
            onClick={() => zoomTo(scale - SCALE_STEP)}
          >
            <Minus size={15} />
          </IconButton>
          <Text fontSize="xs" color="fg.muted" minW="10" textAlign="center" data-viewer-scale={scale}>
            {Math.round(scale * 100)}%
          </Text>
          <IconButton
            aria-label="Zoom in"
            size="xs"
            variant="ghost"
            disabled={scale >= MAX_SCALE}
            onClick={() => zoomTo(scale + SCALE_STEP)}
          >
            <Plus size={15} />
          </IconButton>

          {/* Shown as active while fitting, so "why does zoom keep resetting" and
              "why is the page cut off" are both answerable from the toolbar. */}
          <IconButton
            aria-label="Fit the page to the width of the window"
            aria-pressed={fitMode === 'width'}
            size="xs"
            variant={fitMode === 'width' ? 'subtle' : 'ghost'}
            onClick={fitToWidth}
            data-viewer-fit={fitMode}
          >
            <Maximize2 size={15} />
          </IconButton>
        </HStack>
      </Flex>

      <Flex flex="1" overflow="hidden">
        {/* thumbnail rail */}
        {/* Hidden rather than narrowed below the breakpoint: a 60px rail of unreadable
            thumbnails costs the same space and answers nothing. The page indicator in
            the toolbar already tells the reader where they are. */}
        <Box
          w="132px"
          flexShrink="0"
          borderRightWidth="1px"
          borderColor="border.default"
          overflowY="auto"
          bg="bg.canvas"
          py="2"
          hidden={!showRail}
        >
          <Stack gap="2" align="center">
            {pageNumbers.map((pageNumber) => (
              <PdfThumbnail
                key={pageNumber}
                doc={doc}
                pageNumber={pageNumber}
                active={pageNumber === currentPage}
                onSelect={() => scrollToPage(pageNumber)}
              />
            ))}
          </Stack>
        </Box>

        {/* pages */}
        <Box
          ref={scrollRef}
          flex="1"
          overflow="auto"
          bg="bg.canvas"
          p="4"
          data-viewer-scroll="true"
        >
          <Stack gap="4" align="center">
            {pageNumbers.map((pageNumber) => (
              <PdfPage
                key={pageNumber}
                doc={doc}
                pageNumber={pageNumber}
                scale={scale}
                highlights={highlightsFor(pageNumber)}
                focusedParagraphKey={focusedParagraphKey}
                onVisible={handleVisible}
                registerRef={registerRef}
                onNavigateToPage={scrollToPage}
              />
            ))}
          </Stack>
        </Box>
      </Flex>
    </Flex>
  )
}
