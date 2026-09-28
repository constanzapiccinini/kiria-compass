/**
 * Shared screen primitives.
 *
 * Eight screens that are mostly tables would otherwise repeat the same loading,
 * empty and error markup eight times — and drift apart as they were edited. These
 * are deliberately plain: an internal tool earns its keep by being legible and
 * consistent, not by being decorated.
 */

import { useCallback, useEffect, useState } from 'react'
import { Box, Flex, HStack, Spinner, Stack, Text } from '@chakra-ui/react'
import { ApiError } from '@/lib/client'
import { PlainButton, PlainInput } from '@/components/ui/native'

/** Loading, empty and error states in one place, so no screen invents its own. */
export function AsyncState({
  loading,
  error,
  empty,
  emptyMessage,
  children,
}: {
  loading: boolean
  error: string | null
  empty: boolean
  emptyMessage: string
  children: React.ReactNode
}): React.ReactElement {
  if (loading) {
    return (
      <HStack color="fg.muted" fontSize="sm" gap="2" p="4">
        <Spinner size="xs" />
        <Text>Loading…</Text>
      </HStack>
    )
  }
  if (error) {
    return (
      <Box borderWidth="1px" borderColor="danger.solid" borderRadius="card" p="4" bg="bg.surface">
        <Text fontSize="sm" color="danger.fg">
          {error}
        </Text>
      </Box>
    )
  }
  if (empty) {
    return (
      <Text fontSize="sm" color="fg.muted" p="4">
        {emptyMessage}
      </Text>
    )
  }
  return <>{children}</>
}

/**
 * Fetch-on-mount with a reload handle.
 *
 * Every screen needs the same four things — data, loading, error, reload — and
 * hand-rolling them per screen is how one of them ends up never clearing its error.
 */
export function useLoader<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Cleared before each attempt: a stale error next to fresh data is worse than
    // no error at all.
    setError(null)

    load()
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(
          caught instanceof ApiError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : 'Request failed',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // The dependency array is spread from the caller's `deps` plus the reload nonce.
    // `load` is intentionally excluded: callers pass an inline closure, so including
    // it would refetch on every render. The caller declares what the fetch actually
    // depends on.
  }, [...deps, nonce])

  return { data, loading, error, reload }
}

export function Panel({
  title,
  actions,
  children,
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Stack borderWidth="1px" borderRadius="card" bg="bg.surface" overflow="hidden" gap="0">
      <HStack justify="space-between" px="4" py="3" borderBottomWidth="1px">
        {/* Panel title: 700, sentence case (§1). Not the uppercase register — a panel
            title is a short phrase, not a column heading. */}
        <Text fontWeight="bold" fontSize="15px">
          {title}
        </Text>
        {actions}
      </HStack>
      <Box>{children}</Box>
    </Stack>
  )
}

export function Table({
  headers,
  children,
}: {
  headers: string[]
  children: React.ReactNode
}): React.ReactElement {
  return (
    // Horizontal scroll on the container, never the page: a wide table must not make
    // the whole screen scroll sideways.
    <Box overflowX="auto">
      <Box as="table" w="100%" fontSize="sm" style={{ borderCollapse: 'collapse' }}>
        <Box as="thead">
          <Box as="tr">
            {headers.map((header) => (
              <Box
                as="th"
                key={header}
                textAlign="left"
                px="4"
                py="2"
                // §1's tracked-uppercase register: 800 weight, ~11px, tracked. Right
                // for a column heading and wrong for anything read at length, which is
                // why it appears here and not on the cells below.
                fontSize="11px"
                color="fg.muted"
                fontWeight="extrabold"
                textTransform="uppercase"
                letterSpacing="label"
                borderBottomWidth="1px"
                whiteSpace="nowrap"
              >
                {header}
              </Box>
            ))}
          </Box>
        </Box>
        <Box as="tbody">{children}</Box>
      </Box>
    </Box>
  )
}

export function Cell({
  children,
  muted = false,
  nowrap = false,
}: {
  children: React.ReactNode
  muted?: boolean
  nowrap?: boolean
}): React.ReactElement {
  return (
    <Box
      as="td"
      px="4"
      py="2"
      borderBottomWidth="1px"
      color={muted ? 'fg.muted' : undefined}
      whiteSpace={nowrap ? 'nowrap' : undefined}
      verticalAlign="top"
    >
      {children}
    </Box>
  )
}

/** Status pill. Colour carries meaning, and the text repeats it for anyone who cannot see colour. */
export function Pill({ value }: { value: string }): React.ReactElement {
  const tone =
    value === 'active' || value === 'indexed' || value === 'idle' || value === 'succeeded'
      ? { bg: 'ok.subtle', color: 'ok.fg' }
      : value === 'error' || value === 'failed' || value === 'critical'
        ? { bg: 'danger.subtle', color: 'danger.fg' }
        : value === 'orphaned' || value === 'archived' || value === 'paused' || value === 'disabled'
          ? { bg: 'bg.raised', color: 'fg.muted' }
          : { bg: 'warn.subtle', color: 'warn.fg' }

  return (
    <Box
      as="span"
      display="inline-block"
      px="2"
      py="0.5"
      borderRadius="full"
      fontSize="xs"
      fontWeight="medium"
      bg={tone.bg}
      color={tone.color}
    >
      {value}
    </Box>
  )
}

/**
 * A number, and at most one per screen may be the emphasis (§5).
 *
 * > one emphasis per view … the one number that matters on each screen is the one in
 * > brand blue at 800 weight; the rest of the table is ink.
 *
 * `primary` is that one. It is deliberately not a variant name like "large" — the
 * property being expressed is *importance on this screen*, and naming it after its
 * appearance is how a second one gets added.
 *
 * `tone` is separate from `primary` on purpose. Emphasis says **look here**; tone says
 * **what kind of thing this is**. A headline number that needs attention is both, and
 * collapsing them would force a choice between "this is the number" and "this number is
 * a problem" — which are not alternatives.
 */
export function Stat({
  value,
  label,
  primary = false,
  tone = 'default',
}: {
  value: string | number
  label: string
  primary?: boolean
  tone?: 'default' | 'warn'
}): React.ReactElement {
  return (
    <Stack gap="0" minW="0">
      <Text
        fontSize={primary ? '30px' : 'lg'}
        fontWeight="extrabold"
        lineHeight="1.15"
        color={tone === 'warn' ? 'warn.fg' : primary ? 'accent.solid' : 'fg.default'}
      >
        {value}
      </Text>
      <Text
        fontSize="11px"
        color="fg.muted"
        textTransform="uppercase"
        fontWeight="extrabold"
        letterSpacing="label"
      >
        {label}
      </Text>
    </Stack>
  )
}

export function Button({
  onClick,
  children,
  variant = 'default',
  disabled = false,
  label,
}: {
  onClick: () => void
  children: React.ReactNode
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  label?: string
}): React.ReactElement {
  const tone =
    variant === 'primary'
      ? { bg: 'accent.solid', color: 'accent.contrast', borderColor: 'accent.solid' }
      : variant === 'danger'
        ? { bg: 'transparent', color: 'danger.fg', borderColor: 'danger.solid' }
        : { bg: 'bg.canvas', color: 'fg.default', borderColor: 'border.strong' }

  return (
    <PlainButton
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      px="3"
      py="1.5"
      fontSize="sm"
      borderWidth="1px"
      borderRadius="md"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.5 : 1}
      {...tone}
      _hover={disabled ? undefined : { opacity: 0.85 }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid', outlineOffset: '1px' }}
    >
      {children}
    </PlainButton>
  )
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}): React.ReactElement {
  return (
    <Stack gap="1">
      <Text fontSize="xs" color="fg.muted" fontWeight="medium">
        {label}
      </Text>
      {children}
      {hint ? (
        <Text fontSize="xs" color="fg.muted">
          {hint}
        </Text>
      ) : null}
    </Stack>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
}): React.ReactElement {
  return (
    <PlainInput
      value={value}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      borderWidth="1px"
      borderRadius="md"
      px="2"
      py="1.5"
      fontSize="sm"
      bg="bg.canvas"
      w="100%"
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid' }}
    />
  )
}

/** "Pick a client first" — shown by every per-client screen, worded once. */
export function NeedsClient(): React.ReactElement {
  return (
    <Flex align="center" justify="center" p="8">
      <Text fontSize="sm" color="fg.muted">
        Choose a client in the header to see this screen.
      </Text>
    </Flex>
  )
}
