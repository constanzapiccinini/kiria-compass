/**
 * One page thumbnail. Rendered lazily so a long document does not rasterize every
 * page into the rail on open.
 */

import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'
import type { PDFDocumentProxy } from '@/lib/pdf'
import { PlainButton } from '@/components/ui/PlainButton'

const THUMB_WIDTH = 96

interface PdfThumbnailProps {
  doc: PDFDocumentProxy
  pageNumber: number
  active: boolean
  onSelect: () => void
}

export function PdfThumbnail({ doc, pageNumber, active, onSelect }: PdfThumbnailProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [height, setHeight] = useState(124)

  useEffect(() => {
    const element = wrapperRef.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: '300px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null

    void (async () => {
      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const scale = THUMB_WIDTH / base.width
        const viewport = page.getViewport({ scale })
        setHeight(Math.floor(viewport.height))

        const canvas = canvasRef.current
        if (!canvas) return
        const context = canvas.getContext('2d')
        if (!context) return
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)

        const task = page.render({ canvas, canvasContext: context, viewport })
        renderTask = task
        await task.promise
      } catch {
        // A thumbnail that fails to render is not worth surfacing; the page number
        // button still works.
      }
    })()

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNumber, visible])

  return (
    <Box ref={wrapperRef} textAlign="center">
      <PlainButton
        type="button"
        onClick={onSelect}
        aria-label={`Go to page ${pageNumber}`}
        aria-current={active ? 'page' : undefined}
        display="block"
        width={`${THUMB_WIDTH}px`}
        height={`${height}px`}
        bg="white"
        borderWidth="2px"
        borderColor={active ? 'accent.solid' : 'border.default'}
        borderRadius="3px"
        overflow="hidden"
        cursor="pointer"
        transition="border-color 120ms"
        _hover={{ borderColor: 'accent.solid' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid', outlineOffset: '2px' }}
      >
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      </PlainButton>
      <Text fontSize="10px" color={active ? 'accent.fg' : 'fg.muted'} mt="0.5" fontWeight={active ? 'semibold' : 'normal'}>
        {pageNumber}
      </Text>
    </Box>
  )
}
