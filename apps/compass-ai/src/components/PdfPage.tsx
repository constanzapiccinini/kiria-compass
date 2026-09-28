/**
 * One rendered PDF page, with the citation highlight overlay.
 *
 * Pages render only when they come near the viewport. A long document otherwise
 * rasterizes every page up front, which is both slow and pointless. The placeholder
 * reserves the page's real aspect ratio so scroll position never jumps as pages
 * finish rendering.
 */

import { useEffect, useRef, useState } from 'react'
import { Box, Spinner, Text } from '@chakra-ui/react'
import type { PDFDocumentProxy, PDFPageProxy } from '@/lib/pdf'
import { createLinkLayer, createLinkService, linkAnnotations } from '@/lib/pdf-links'

export interface HighlightBox {
  paragraphKey: string
  x: number
  y: number
  width: number
  height: number
}

interface PdfPageProps {
  doc: PDFDocumentProxy
  pageNumber: number
  scale: number
  /** Highlights for this page, in normalized (0..1) top-left-origin coordinates. */
  highlights: HighlightBox[]
  /** The paragraph to pulse, when a citation was just clicked. */
  focusedParagraphKey: string | null
  onVisible: (pageNumber: number) => void
  registerRef: (pageNumber: number, element: HTMLDivElement | null) => void
  /** Where an internal link in the document should take the reader. */
  onNavigateToPage: (pageNumber: number) => void
}

export function PdfPage({
  doc,
  pageNumber,
  scale,
  highlights,
  focusedParagraphKey,
  onVisible,
  registerRef,
  onNavigateToPage,
}: PdfPageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const linkLayerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [shouldRender, setShouldRender] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read the page's intrinsic size first so the placeholder is the right shape.
  useEffect(() => {
    let cancelled = false
    doc
      .getPage(pageNumber)
      .then((page: PDFPageProxy) => {
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        setSize({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not read page')
      })
    return () => {
      cancelled = true
    }
  }, [doc, pageNumber, scale])

  // Render when near the viewport; report visibility for the page indicator.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShouldRender(true)
            // Only treat a page as "current" once a real slice of it is showing.
            if (entry.intersectionRatio > 0.5) onVisible(pageNumber)
          }
        }
      },
      // Pre-render one screen ahead so scrolling rarely hits a placeholder.
      { root: null, rootMargin: '800px 0px', threshold: [0, 0.5] },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [pageNumber, onVisible])

  // Rasterize.
  useEffect(() => {
    if (!shouldRender) return
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null

    void (async () => {
      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return

        const canvas = canvasRef.current
        if (!canvas) return
        const context = canvas.getContext('2d')
        if (!context) return

        // Render at device pixel ratio so text stays crisp on HiDPI screens.
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const viewport = page.getViewport({ scale: scale * ratio })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)

        const task = page.render({ canvas, canvasContext: context, viewport })
        renderTask = task
        await task.promise
        if (!cancelled) setRendered(true)
      } catch (cause: unknown) {
        // A cancelled render is expected when scale changes mid-flight.
        const message = cause instanceof Error ? cause.message : String(cause)
        if (!cancelled && !/cancel/i.test(message)) setError(message)
      }
    })()

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNumber, scale, shouldRender])

  // ---------------------------------------------------------------------------
  // Link annotations
  //
  // A canvas has no links in it: until this layer existed, a URL printed in the
  // document was a picture of a URL. PDF.js's annotation layer puts real anchors over
  // the raster, positioned from the page's own annotation table.
  //
  // Two details that silently produce an invisible layer if missed:
  //
  //   * **The viewport is the CSS one**, `scale`, not `scale * devicePixelRatio`.
  //     The canvas is rasterized at device pixels and then displayed at 100% width;
  //     the layer sits in CSS pixels on top of it. Using the device viewport here puts
  //     every link at twice its correct offset on a HiDPI screen.
  //   * **`--total-scale-factor` has to be set on the div.** `setLayerDimensions`
  //     sizes the layer with `round(down, var(--total-scale-factor) * Npx, …)`, so
  //     without the variable the layer computes to zero and the links are simply not
  //     there — no error, nothing in the console.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!shouldRender) return
    let cancelled = false

    void (async () => {
      const container = linkLayerRef.current
      if (!container) return

      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return

        const annotations = await linkAnnotations(page)
        if (cancelled) return

        container.replaceChildren()
        if (annotations.length === 0) return

        const viewport = page.getViewport({ scale })
        container.style.setProperty('--scale-factor', String(scale))
        container.style.setProperty('--total-scale-factor', String(scale))
        container.style.setProperty('--scale-round-x', '1px')
        container.style.setProperty('--scale-round-y', '1px')

        const layer = createLinkLayer({
          div: container,
          page,
          viewport: viewport.clone({ dontFlip: true }),
          linkService: createLinkService(doc, onNavigateToPage),
        })

        await layer.render({ annotations, renderForms: false })
      } catch {
        // A document with a broken annotation table still renders its pages; it just
        // has no clickable links. Silent on purpose — an error banner here would
        // report a degraded extra as a failure of the thing the reader came for.
      }
    })()

    return () => {
      cancelled = true
      linkLayerRef.current?.replaceChildren()
    }
  }, [doc, pageNumber, scale, shouldRender, onNavigateToPage])

  return (
    <Box
      ref={(element: HTMLDivElement | null) => {
        containerRef.current = element
        registerRef(pageNumber, element)
      }}
      position="relative"
      width={size ? `${size.width}px` : '100%'}
      height={size ? `${size.height}px` : '60vh'}
      bg="white"
      boxShadow="sm"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="4px"
      overflow="hidden"
      flexShrink="0"
      data-page={pageNumber}
      // Lets e2e tests wait for a completed raster instead of guessing at timing.
      data-rendered={rendered ? "true" : "false"}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
        aria-label={`Page ${pageNumber}`}
      />

      {/* Links sit above the raster and below the citation highlights. The highlights
          set `pointer-events: none`, so a link that happens to fall under one is
          still clickable — which matters, because a cited passage is exactly where a
          reference link tends to be. */}
      <div ref={linkLayerRef} className="annotationLayer" />

      {!rendered && !error && (
        <Box position="absolute" inset="0" display="flex" alignItems="center" justifyContent="center">
          <Spinner size="sm" color="accent.solid" />
        </Box>
      )}

      {error && (
        <Box position="absolute" inset="0" display="flex" alignItems="center" justifyContent="center" p="4">
          <Text fontSize="xs" color="red.500" textAlign="center">
            Page {pageNumber} could not be rendered: {error}
          </Text>
        </Box>
      )}

      {highlights.map((highlight) => {
        const focused = highlight.paragraphKey === focusedParagraphKey
        return (
          <Box
            key={highlight.paragraphKey}
            position="absolute"
            // Bounding boxes are normalized, so they hold at any zoom level.
            left={`${highlight.x * 100}%`}
            top={`${highlight.y * 100}%`}
            width={`${highlight.width * 100}%`}
            height={`${highlight.height * 100}%`}
            // Pad the box slightly — text sits inside its own line box.
            // The highlighter, and the KIRIA device this whole product borrows: a
            // swipe of brand yellow over the phrase that carries the insight.
            //
            // `mix-blend-mode: multiply` rather than an alpha fill. Both keep the words
            // legible, but multiply behaves like actual highlighter ink — the darkness
            // of the glyph survives and only the paper behind it takes the colour. An
            // alpha fill washes the text toward the highlight instead, which is what
            // §1 warns will be the first thing anyone notices.
            //
            // The ring is blue, not a darker yellow: the swipe says *this is the
            // passage*, the ring says *this is the one you jumped to*.
            outline={focused ? '2px solid' : undefined}
            outlineColor="citation.ring"
            outlineOffset="2px"
            bg="citation.bg"
            mixBlendMode="multiply"
            opacity={focused ? 1 : 0.55}
            borderRadius="2px"
            pointerEvents="none"
            // Stable hook for e2e assertions on which paragraph is highlighted.
            data-highlight-key={highlight.paragraphKey}
            transition="opacity 200ms, outline-color 200ms"
            animation={focused ? 'compass-pulse 1.4s ease-out 2' : undefined}
          />
        )
      })}
    </Box>
  )
}
