/**
 * Compass Insights shell.
 *
 * The third app, and the one whose whole content is other people's conversations. It
 * reads; it writes nothing but a review decision (8D). §5 keeps the analysis itself in
 * the Compass AI worker, so there is no pipeline here to go wrong.
 *
 * ## Why the same visual language as Compass Admin
 *
 * The scaffold ships Tailwind and shadcn; this app uses Chakra and the admin's
 * `primitives.tsx` instead. Staff move between Admin and Insights in the same sitting
 * — a portal in one tab, its questions in the other — and a second visual vocabulary
 * for the same audience is a cost with no upside. The primitives are copied and, like
 * the backend helpers, held byte-identical by a drift test.
 *
 * ## Authorization
 *
 * Three independent layers, because of what is behind them:
 *
 *   1. `--access=orgRole:member` at the platform edge (§7);
 *   2. `requireAdmin` on every route, checked against Gate per request;
 *   3. RLS policies that refuse any request carrying `app.req_client_id` at all.
 *
 * This shell renders a refusal when the session is not staff, and that screen is a
 * courtesy — it is not what keeps anyone out.
 *
 * ## No client picker in the header
 *
 * Unlike Admin, where most screens are per-portal, three of the four screens here are
 * org-wide. The account picker lives inside the Accounts screen, where choosing one is
 * the act rather than a mode the whole app is in — and it keeps the org-scoped screens
 * visibly org-scoped, which is the §2 boundary.
 */

import { useCallback, useEffect, useState } from 'react'
import { Box, Flex, Spinner, Stack, Text } from '@chakra-ui/react'
import { Activity, FileText, Flag, LayoutGrid, Target, Users } from 'lucide-react'
import { ApiError, api } from '@/lib/client'
import { OverviewScreen } from '@/screens/OverviewScreen'
import { ClientsScreen } from '@/screens/ClientsScreen'
import { ContentScreen } from '@/screens/ContentScreen'
import { GapsScreen } from '@/screens/GapsScreen'
import { RunsScreen } from '@/screens/RunsScreen'
import { ReviewScreen } from '@/screens/ReviewScreen'
import { PlainButton } from '@/components/ui/native'

type ScreenId = 'overview' | 'gaps' | 'accounts' | 'content' | 'review' | 'runs'

interface NavItem {
  id: ScreenId
  label: string
  icon: React.ReactNode
  /** One line under the title, so a screen says what it answers. */
  question: string
}

/**
 * The rail, ordered by §1's four questions rather than by how the data is stored.
 *
 * "Content gaps" is the screen §7 calls the one that pays for the phase, and it is
 * second in the rail for that reason. It groups by theme within each account; the
 * cross-account form is gated on §2's contracts question, which the screen says on
 * itself rather than leaving to be inferred from an absence.
 */
const NAV: NavItem[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: <LayoutGrid size={16} />,
    question: 'How much are we being asked, and how often do we have no answer?',
  },
  {
    id: 'gaps',
    label: 'Content gaps',
    icon: <Target size={16} />,
    question: 'What are clients asking that our material does not answer?',
  },
  {
    id: 'accounts',
    label: 'Accounts',
    icon: <Users size={16} />,
    question: 'What does one client ask that our material does not answer?',
  },
  {
    id: 'content',
    label: 'Content',
    icon: <FileText size={16} />,
    question: 'Which parts of what we produce get read, and what does nobody open?',
  },
  {
    id: 'review',
    label: 'Review',
    icon: <Flag size={16} />,
    question: 'What did somebody ask that a person here should have seen?',
  },
  {
    id: 'runs',
    label: 'Runs',
    icon: <Activity size={16} />,
    question: 'What ran, what it did, and what failed.',
  },
]

export default function App(): React.ReactElement {
  const [screen, setScreen] = useState<ScreenId>('overview')
  const [ready, setReady] = useState(false)
  const [denied, setDenied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * One probe before rendering anything, so a non-staff visitor gets a sentence
   * instead of four screens of failed requests.
   *
   * A 401 or 403 is a refusal and is final. Anything else — a 5xx, a network error
   * mid-deploy — is not, and must not be reported as "you are not allowed": that is
   * the distinction the `handling-authentication-errors` skill exists to make, and
   * getting it backwards trains people to ignore a real refusal.
   */
  const probe = useCallback(async () => {
    try {
      await api.overview(1)
      setDenied(null)
      setError(null)
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
        setDenied(caught.message)
      } else {
        setError(caught instanceof Error ? caught.message : 'Could not reach the backend')
      }
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void probe()
  }, [probe])

  if (!ready) {
    return (
      <Flex h={['100vh', '100dvh']} align="center" justify="center">
        <Spinner color="accent.solid" />
      </Flex>
    )
  }

  if (denied) {
    return (
      <Flex h={['100vh', '100dvh']} align="center" justify="center" p="6">
        <Box maxW="md" textAlign="center">
          <Text fontSize="lg" fontWeight="semibold">
            Compass Insights is for the KIRIA team
          </Text>
          <Text fontSize="sm" color="fg.muted" mt="2">
            {denied}
          </Text>
        </Box>
      </Flex>
    )
  }

  const active = NAV.find((item) => item.id === screen) ?? NAV[0]

  return (
    <Flex h={['100vh', '100dvh']} minH="480px" overflow="hidden">
      <Stack w="220px" flexShrink="0" borderRightWidth="1px" bg="bg.surface" p="3" gap="1">
        <Box px="2" pb="3">
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
          <Text fontSize="sm" fontWeight="semibold" mt="2">
            Compass Insights
          </Text>
          <Text fontSize="10px" color="fg.muted">
            What clients ask, and what we have not written
          </Text>
        </Box>

        {NAV.map((item) => (
          <PlainButton
            key={item.id}
            onClick={() => setScreen(item.id)}
            aria-current={item.id === screen ? 'page' : undefined}
            display="flex"
            alignItems="center"
            gap="2"
            px="2"
            py="2"
            borderRadius="md"
            // §1: blue is "primary buttons, active nav, focus ring". The active
            // item was Chakra's default grey until Phase 9's screenshot review, and
            // a rail where nothing is the brand colour is a rail that says the
            // rebrand did not happen. The left marker is what carries it at a
            // glance; the tint alone is too quiet at this size.
            bg={item.id === screen ? 'accent.subtle' : undefined}
            color={item.id === screen ? 'accent.onSubtle' : undefined}
            borderLeftWidth="3px"
            borderLeftColor={item.id === screen ? 'accent.solid' : 'transparent'}
            fontWeight={item.id === screen ? 'semibold' : 'normal'}
            fontSize="sm"
            cursor="pointer"
            textAlign="left"
            // Hover must not erase the active state. It did: after clicking a rail
            // item the cursor stays on it, so the selected screen rendered as an
            // ordinary hovered one — which is how the Usage capture came back with a
            // grey nav item on a screen that was, in fact, selected.
            _hover={{ bg: item.id === screen ? 'accent.subtle' : 'bg.subtle' }}
          >
            {item.icon}
            <Text>{item.label}</Text>
          </PlainButton>
        ))}
      </Stack>

      <Flex direction="column" flex="1" minW="0" overflow="hidden">
        <Box borderBottomWidth="1px" bg="bg.surface" px="5" py="3" flexShrink="0">
          <Text fontSize="md" fontWeight="semibold">
            {active.label}
          </Text>
          {/* The question the screen answers, not a description of its contents. §1 is
              emphatic that the four questions are the deliverable. */}
          <Text fontSize="xs" color="fg.muted">
            {active.question}
          </Text>
        </Box>

        {error ? (
          <Box mx="5" mt="3" borderWidth="1px" borderColor="red.400" borderRadius="card" p="3">
            <Text fontSize="sm" color="red.600" _dark={{ color: 'red.300' }}>
              {error}
            </Text>
          </Box>
        ) : null}

        <Box flex="1" overflowY="auto" p="5">
          {screen === 'overview' ? <OverviewScreen /> : null}
          {screen === 'gaps' ? <GapsScreen /> : null}
          {screen === 'accounts' ? <ClientsScreen /> : null}
          {screen === 'content' ? <ContentScreen /> : null}
          {screen === 'review' ? <ReviewScreen /> : null}
          {screen === 'runs' ? <RunsScreen /> : null}
        </Box>
      </Flex>
    </Flex>
  )
}
