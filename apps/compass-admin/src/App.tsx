/**
 * Compass Admin shell.
 *
 * One screen at a time, chosen from a left rail, with a portal picker in the header
 * because most screens are per-portal. The picker lives in the shell rather than in
 * each screen so switching portal keeps you on the screen you were reading.
 *
 * There is no client picker and no client list: one portal is one client (§5A), and
 * the tenancy key is resolved from the selected portal and never shown.
 *
 * Authorization is entirely server-side (`requireAdmin` on every route). This shell
 * shows a refusal screen when the session is not staff, but that screen is a
 * courtesy — it is not what keeps a client out.
 */

import { useCallback, useEffect, useState } from 'react'
import { Box, Flex, HStack, Spinner, Stack, Text } from '@chakra-ui/react'
import {
  Activity,
  AlertTriangle,
  Library,
  LayoutGrid,
  ScrollText,
  Settings as SettingsIcon,
  Wallet,
} from 'lucide-react'
import { ApiError, api, type PortalRef, type SessionResponse } from '@/lib/client'
import { PortalsScreen } from '@/screens/PortalsScreen'
import { LibrariesScreen } from '@/screens/LibrariesScreen'
import { IndexingScreen } from '@/screens/IndexingScreen'
import { SettingsScreen } from '@/screens/SettingsScreen'
import { AlertsScreen } from '@/screens/AlertsScreen'
import { UsageScreen } from '@/screens/UsageScreen'
import { AuditScreen } from '@/screens/AuditScreen'
import { PlainButton, PlainSelect } from '@/components/ui/native'

type ScreenId =
  | 'portals'
  | 'libraries'
  | 'indexing'
  | 'settings'
  | 'alerts'
  | 'usage'
  | 'audit'

interface NavItem {
  id: ScreenId
  label: string
  icon: React.ReactNode
  /** True when the screen reads a single portal and needs the picker. */
  perPortal: boolean
}

const NAV: NavItem[] = [
  { id: 'portals', label: 'Portals', icon: <LayoutGrid size={16} />, perPortal: false },
  { id: 'libraries', label: 'Libraries', icon: <Library size={16} />, perPortal: false },
  { id: 'indexing', label: 'Indexing', icon: <Activity size={16} />, perPortal: true },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon size={16} />, perPortal: true },
  { id: 'alerts', label: 'Alerts', icon: <AlertTriangle size={16} />, perPortal: false },
  { id: 'usage', label: 'Usage', icon: <Wallet size={16} />, perPortal: false },
  { id: 'audit', label: 'Audit log', icon: <ScrollText size={16} />, perPortal: false },
]

export default function App(): React.ReactElement {
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [portals, setPortals] = useState<PortalRef[]>([])
  const [portalRowId, setPortalRowId] = useState<string | null>(null)
  const [screen, setScreen] = useState<ScreenId>('portals')
  const [error, setError] = useState<{ message: string; code: string } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sessionResponse, portalResponse] = await Promise.all([
        api.session(),
        api.sessionPortals(),
      ])
      setSession(sessionResponse)
      setPortals(portalResponse.portals)
      // Default to the first active portal so a per-portal screen is never blank on
      // arrival for no reason.
      setPortalRowId(
        (current) =>
          current ?? portalResponse.portals.find((p) => p.status === 'active')?.id ?? null,
      )
      setError(null)
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? { message: caught.message, code: caught.code }
          : { message: caught instanceof Error ? caught.message : 'Something went wrong', code: 'ERROR' },
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <Flex h="100vh" align="center" justify="center" gap="3">
        <Spinner size="sm" color="accent.solid" />
        <Text color="fg.muted">Loading…</Text>
      </Flex>
    )
  }

  if (error) {
    // A refusal and a fault read very differently to the person holding them, so they
    // are worded differently: one is "you cannot be here", the other "we broke".
    const refused = error.code === 'NOT_EMPLOYEE' || error.code === 'NOT_ORG_MEMBER'
    return (
      <Flex h="100vh" align="center" justify="center" p="6">
        <Box maxW="md" borderWidth="1px" borderRadius="card" p="6" bg="bg.surface">
          <Text fontWeight="semibold" mb="2">
            {refused ? 'Compass Admin is for KIRIA staff' : 'Compass Admin could not start'}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {error.message}
          </Text>
        </Box>
      </Flex>
    )
  }

  const activeNav = NAV.find((item) => item.id === screen) ?? NAV[0]
  const selectedPortal = portals.find((portal) => portal.id === portalRowId) ?? null
  // The tenancy key the per-portal screens read. Their APIs are per-tenant and always
  // were; what changed in §5A is that nobody has to know the word "client" to use
  // them. Never rendered.
  const clientId = selectedPortal?.clientId ?? null

  return (
    <Flex h="100vh" overflow="hidden">
      {/* rail */}
      <Stack
        w="220px"
        flexShrink={0}
        borderRightWidth="1px"
        bg="bg.surface"
        py="3"
        px="2"
        gap="1"
      >
        <Stack px="2" pb="2" gap="2">
          {/* The wordmark (§2), swapped by colour mode rather than by two toggled
              <img> tags. Sized from the compact lockup's trimmed aspect, so the height is
              the mark's height and not the height of its padding. */}
          <Box
            role="img"
            aria-label="KIRIA Advisory Partners"
            css={{
              height: '22px',
              width: '60px',
              flexShrink: 0,
              backgroundImage: 'url(/brand/wordmark.png)',
              backgroundSize: 'contain',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'left center',
              _dark: { backgroundImage: 'url(/brand/wordmark-white.png)' },
            }}
          />
          <Text fontWeight="semibold" fontSize="sm">
            Compass Admin
          </Text>
        </Stack>

        {NAV.map((item) => {
          const isActive = item.id === screen
          return (
            <PlainButton
              key={item.id}
              onClick={() => setScreen(item.id)}
              display="flex"
              alignItems="center"
              gap="2"
              px="2"
              py="2"
              borderRadius="md"
              textAlign="left"
              w="100%"
              // §1: blue is "primary buttons, active nav, focus ring". The active
              // item was Chakra's default grey until Phase 9's screenshot review, and
              // a rail where nothing is the brand colour is a rail that says the
              // rebrand did not happen. The left marker is what carries it at a
              // glance; the tint alone is too quiet at this size.
              bg={isActive ? 'accent.subtle' : undefined}
              color={isActive ? 'accent.onSubtle' : undefined}
              borderLeftWidth="3px"
              borderLeftColor={isActive ? 'accent.solid' : 'transparent'}
              fontWeight={isActive ? 'semibold' : 'normal'}
              fontSize="sm"
              cursor="pointer"
              // Hover must not erase the active state. It did: after clicking a rail
              // item the cursor stays on it, so the selected screen rendered as an
              // ordinary hovered one — which is how the Usage capture came back with a
              // grey nav item on a screen that was, in fact, selected.
              _hover={{ bg: isActive ? 'accent.subtle' : 'bg.subtle' }}
              _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid' }}
              aria-current={isActive ? 'page' : undefined}
            >
              {item.icon}
              <Text flex="1">{item.label}</Text>
              {/* Only counts that mean "someone must act" are badged — and while
                  delivery is paused, nothing does: the badge is a notification like
                  any other. The Alerts screen still lists every open alert and says
                  the pause is on, so this hides the nagging and not the evidence. */}
              {item.id === 'alerts' &&
              session &&
              !session.alertsPaused &&
              session.counts.openAlerts > 0 ? (
                <Box
                  fontSize="xs"
                  px="1.5"
                  borderRadius="full"
                  bg="red.500"
                  color="white"
                  aria-label={`${session.counts.openAlerts} open alerts`}
                >
                  {session.counts.openAlerts}
                </Box>
              ) : null}
            </PlainButton>
          )
        })}

        <Box flex="1" />
        {session ? (
          <Stack px="2" gap="0" fontSize="xs" color="fg.muted">
            <Text>{session.actor.email ?? `User ${session.actor.userId}`}</Text>
            <Text>{session.actor.orgRole}</Text>
          </Stack>
        ) : null}
      </Stack>

      {/* content */}
      <Flex direction="column" flex="1" overflow="hidden">
        <HStack
          borderBottomWidth="1px"
          px="4"
          py="3"
          gap="4"
          bg="bg.surface"
          justify="space-between"
        >
          <Text fontWeight="semibold">{activeNav.label}</Text>

          {activeNav.perPortal ? (
            <HStack gap="2">
              <Text fontSize="xs" color="fg.muted">
                Portal
              </Text>
              <PlainSelect
                value={portalRowId ?? ''}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                  setPortalRowId(event.target.value || null)
                }
                aria-label="Select a portal"
                borderWidth="1px"
                borderRadius="md"
                px="2"
                py="1"
                fontSize="sm"
                bg="bg.canvas"
              >
                <option value="">Select a portal…</option>
                {portals.map((portal) => (
                  <option key={portal.id} value={portal.id}>
                    {portal.label}
                    {portal.status !== 'active' ? ` (${portal.status})` : ''}
                  </option>
                ))}
              </PlainSelect>
            </HStack>
          ) : null}
        </HStack>

        <Box flex="1" overflowY="auto" p="4">
          {screen === 'portals' ? <PortalsScreen onChanged={load} /> : null}
          {screen === 'libraries' ? <LibrariesScreen portals={portals} /> : null}
          {screen === 'indexing' ? (
            <IndexingScreen
              portalRowId={portalRowId}
              portalLabel={selectedPortal?.label ?? null}
            />
          ) : null}
          {screen === 'settings' ? <SettingsScreen clientId={clientId} /> : null}
          {screen === 'alerts' ? <AlertsScreen portals={portals} /> : null}
          {screen === 'usage' ? <UsageScreen /> : null}
          {screen === 'audit' ? <AuditScreen portals={portals} /> : null}
        </Box>
      </Flex>
    </Flex>
  )
}
