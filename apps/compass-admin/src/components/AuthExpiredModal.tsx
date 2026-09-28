import { useMemo } from 'react'
import { Flex, HStack, Stack, Text } from '@chakra-ui/react'
import { authUiForAppTokenReason, type AuthTokenExpiredError } from '../lib/api'
import { Button } from './primitives'

interface AuthExpiredModalProps {
  onClose: () => void
  authError: AuthTokenExpiredError
}

/**
 * Auth failure modal — shown when AppTokenValidationError is mapped to
 * AuthTokenExpiredError. Copy depends on the server `reason` (e.g.
 * `missing_gate_service_token` is not a session timeout).
 *
 * ---------------------------------------------------------------------------
 * Rewritten in Chakra for Phase 9
 *
 * This was the last Tailwind in the app — `bg-white`, `text-gray-600`,
 * `bg-blue-600` — which meant the one screen a person sees when something has gone
 * wrong was the one screen with no brand on it at all, in a palette that ignored dark
 * mode entirely. §4: "empty and error states are where a product feels cheap or
 * considered."
 *
 * It also kept `@import "tailwindcss"` load-bearing in an app whose UI is Chakra, so
 * converting it is what allowed `globals.css` to become the same four rules the client
 * app has instead of a second, competing design system's variables.
 */
export function AuthExpiredModal({ onClose, authError }: AuthExpiredModalProps) {
  const { title, body } = useMemo(
    () => authUiForAppTokenReason(authError.appTokenReason, authError.serverHint),
    [authError.appTokenReason, authError.serverHint],
  )

  return (
    <Flex
      position="fixed"
      inset="0"
      align="center"
      justify="center"
      zIndex="modal"
      // Ink at 60% rather than pure black: the scrim is the brand's own darkest value,
      // so the page behind it dims toward the palette instead of toward grey.
      bg="rgba(1, 1, 4, 0.6)"
      p="4"
    >
      <Stack
        bg="bg.surface"
        borderWidth="1px"
        borderColor="border.default"
        borderRadius="card"
        boxShadow="xl"
        p="6"
        maxW="md"
        w="100%"
        gap="2"
      >
        <Text fontSize="lg" fontWeight="semibold">
          {title}
        </Text>
        <Text fontSize="sm" color="fg.muted" lineHeight="relaxed">
          {body}
        </Text>
        {authError.appTokenReason ? (
          // The machine-readable reason, kept and kept quiet. It is what makes a
          // support conversation short, and it is not what the reader is here for.
          <Text fontFamily="mono" fontSize="xs" color="fg.muted">
            reason: {authError.appTokenReason}
          </Text>
        ) : null}
        <HStack justify="flex-end" gap="3" pt="4">
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => window.location.reload()} variant="primary">
            Refresh page
          </Button>
        </HStack>
      </Stack>
    </Flex>
  )
}

