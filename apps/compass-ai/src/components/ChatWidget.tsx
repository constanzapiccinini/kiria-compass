/**
 * The chat: a pill when collapsed, and when expanded a **column in the layout** on a
 * wide screen or a **bottom sheet** on a narrow one.
 *
 * ---------------------------------------------------------------------------
 * Why it no longer floats over the document (§7.3)
 *
 * It was `position: fixed`, which meant the viewer did not know it existed and could
 * not shrink for it. Combined with a width clamped to `min(width, viewport − 32)`,
 * a narrow portal iframe resolved that to nearly the whole viewport — which is the
 * "the chat is full width and the content is cut off" in the bug report, exactly.
 *
 * Docked, it reserves space instead. The viewer's `ResizeObserver` sees its own
 * container narrow and re-fits the page, so expanding the chat now makes the document
 * smaller rather than hidden.
 *
 * ## Drag-to-move is gone, deliberately
 *
 * **This reverses the "draggable within safe bounds" requirement of the Phase 4
 * design.** It is not a regression to be restored: a docked panel has nowhere to go,
 * and the persisted `right`/`bottom` geometry is what produced the off-screen and
 * full-width states this phase exists to fix — a panel remembered from a wide monitor
 * opening on a laptop, clamped to a viewport that then changed. Only the width
 * persists now, and only within a range the layout can honour.
 *
 * ## Docked, it is not a dialog
 *
 * `Ctrl/Cmd+J` and `Escape` still work. But a docked panel sits *beside* the document
 * rather than over it, so it is a labelled region rather than a `role="dialog"`, and
 * focus is deliberately **not** trapped — the viewer next to it has to stay reachable
 * by keyboard. As a bottom sheet it is over the content, so it keeps the dialog role
 * there.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, HStack, IconButton, Text } from '@chakra-ui/react'
import { MessageSquare, Minus, Sparkles } from 'lucide-react'
import { PlainButton } from '@/components/ui/PlainButton'

const STORAGE_KEY = 'compass-ai.chat-widget'

/** The docked column's range. §9.2 asks for these to be checked against a real brick. */
const MIN_WIDTH = 320
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 380
/** At or above this the panel docks; below it, it is a bottom sheet. */
const DOCK_BREAKPOINT = 1024
const MARGIN = 16

/**
 * The remembered width. Anything outside the range the layout can honour is
 * discarded rather than clamped — a stored 720 from the floating era is not a
 * preference for 480, it is a value from a different layout.
 */
function loadWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_WIDTH
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_WIDTH
    const value = (parsed as { width?: unknown }).width
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WIDTH
    return value >= MIN_WIDTH && value <= MAX_WIDTH ? value : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function saveWidth(width: number): void {
  try {
    // Written as an object so the key keeps one shape across versions, and so a
    // reader that still expects the old geometry gets a miss rather than a number.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ width }))
  } catch {
    // Private browsing or blocked site data — the width simply will not persist.
  }
}

interface ChatWidgetProps {
  /** Short label for the current document scope, shown in the header. */
  scopeLabel: string
  children: React.ReactNode
}

export function ChatWidget({ scopeLabel, children }: ChatWidgetProps) {
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [docked, setDocked] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DOCK_BREAKPOINT,
  )
  const [resizing, setResizing] = useState(false)

  // Hydrate after mount, so the first render does not depend on storage being
  // readable at all.
  useEffect(() => {
    setWidth(loadWidth())
  }, [])

  useEffect(() => {
    const onResize = (): void => setDocked(window.innerWidth >= DOCK_BREAKPOINT)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Cmd/Ctrl+J toggles; Escape closes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setOpen((value) => !value)
      }
      if (event.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  // --- resize, by dragging the panel's left edge -------------------------
  const resizeState = useRef<{ startX: number; base: number } | null>(null)

  useEffect(() => {
    if (!resizing) return

    const onMove = (event: MouseEvent): void => {
      const state = resizeState.current
      if (!state) return
      // The panel is on the right, so dragging its left edge leftwards grows it.
      const next = state.base - (event.clientX - state.startX)
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
    }
    const onUp = (): void => {
      resizeState.current = null
      setResizing(false)
      // Persisted once at the end rather than on every mousemove.
      setWidth((current) => {
        saveWidth(current)
        return current
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  const beginResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      resizeState.current = { startX: event.clientX, base: width }
      setResizing(true)
    },
    [width],
  )

  const header = (
    <Flex
      align="center"
      justify="space-between"
      px="2"
      py="2"
      pl="3"
      borderBottomWidth="1px"
      borderColor="border.default"
      bg="bg.raised"
      flexShrink="0"
    >
      <HStack gap="2" minW="0">
        <Box color="accent.solid" flexShrink="0">
          <MessageSquare size={14} />
        </Box>
        <Box minW="0">
          <Text fontSize="sm" fontWeight="semibold" lineHeight="1.2">
            Compass AI
          </Text>
          <Text fontSize="10px" color="fg.muted" truncate title={scopeLabel}>
            {scopeLabel}
          </Text>
        </Box>
      </HStack>

      <IconButton
        aria-label="Collapse chat"
        title="Collapse  ·  Ctrl+J"
        size="xs"
        variant="ghost"
        onClick={() => setOpen(false)}
      >
        <Minus size={14} />
      </IconButton>
    </Flex>
  )

  if (!open) {
    return (
      <PlainButton
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open Compass AI chat (Ctrl+J)"
        title="Ask Compass AI  ·  Ctrl+J"
        position="fixed"
        right={`${MARGIN}px`}
        bottom={`${MARGIN}px`}
        zIndex="1400"
        display="flex"
        alignItems="center"
        gap="2"
        px="4"
        py="3"
        borderRadius="full"
        bg="accent.solid"
        color="accent.contrast"
        fontWeight="semibold"
        fontSize="sm"
        boxShadow="lg"
        cursor="pointer"
        transition="transform 120ms, box-shadow 120ms"
        _hover={{ transform: 'translateY(-1px)', boxShadow: 'xl' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.fg', outlineOffset: '3px' }}
      >
        <Sparkles size={16} />
        Ask Compass
      </PlainButton>
    )
  }

  // --- narrow: a bottom sheet ---------------------------------------------
  //
  // Still an overlay, because there is no room to dock — but anchored to the bottom
  // at ~60% height rather than centred, so it never sits on top of the text being
  // read. That is the difference between "the chat is in the way" and "the chat is
  // below what I am reading".
  if (!docked) {
    return (
      <Flex
        direction="column"
        position="fixed"
        left="0"
        right="0"
        bottom="0"
        h="60dvh"
        maxH="60vh"
        zIndex="1400"
        bg="bg.surface"
        borderTopWidth="1px"
        borderColor="border.default"
        borderTopRadius="card"
        boxShadow="2xl"
        overflow="hidden"
        role="dialog"
        aria-label="Compass AI chat"
        data-chat-panel="sheet"
      >
        {header}
        <Box flex="1" overflow="hidden">
          {children}
        </Box>
      </Flex>
    )
  }

  // --- wide: a column in the layout row -----------------------------------
  return (
    <Flex
      flexShrink="0"
      w={`${width}px`}
      h="100%"
      borderLeftWidth="1px"
      borderColor="border.default"
      bg="bg.surface"
      position="relative"
      // Suppress selection while dragging so the gesture feels solid.
      userSelect={resizing ? 'none' : undefined}
      data-chat-panel="docked"
    >
      {/* The left edge, as a resizer. `separator` with an orientation and a value
          range is what makes it legible to a screen reader, and the arrow keys mean
          the width is adjustable without a pointer at all. */}
      <Box
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the chat panel"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onMouseDown={beginResize}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 32 : 8
          if (event.key === 'ArrowLeft') {
            setWidth((current) => {
              const next = Math.min(MAX_WIDTH, current + step)
              saveWidth(next)
              return next
            })
          } else if (event.key === 'ArrowRight') {
            setWidth((current) => {
              const next = Math.max(MIN_WIDTH, current - step)
              saveWidth(next)
              return next
            })
          }
        }}
        position="absolute"
        left="-2px"
        top="0"
        bottom="0"
        w="4px"
        cursor="col-resize"
        zIndex="1"
        _hover={{ bg: 'border.emphasized' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.fg' }}
      />

      {/* A region, not a dialog: it is beside the document rather than over it, so
          focus must stay free to move into the viewer. */}
      <Flex direction="column" as="aside" aria-label="Compass AI chat" w="100%" h="100%">
        {header}
        <Box flex="1" overflow="hidden">
          {children}
        </Box>
      </Flex>
    </Flex>
  )
}
