import { useMemo } from 'react'
import { Box, Button, Code, Flex, Heading, Stack, Text } from '@chakra-ui/react'
import { authUiForAppTokenReason, type AuthTokenExpiredError } from '../lib/api'

interface AuthExpiredModalProps {
  /** Present when the failure came from a platform AppTokenValidationError. */
  authError?: AuthTokenExpiredError
  onClose?: () => void
}

/**
 * Auth failure screen. Copy is driven by the platform `reason`, because
 * `missing_gate_service_token` is a permission problem, not a session timeout, and
 * telling the user to "sign in again" would send them down the wrong path.
 */
export function AuthExpiredModal({ authError, onClose }: AuthExpiredModalProps) {
  const { title, body } = useMemo(
    () => authUiForAppTokenReason(authError?.appTokenReason, authError?.serverHint),
    [authError?.appTokenReason, authError?.serverHint],
  )

  return (
    <Flex position="fixed" inset="0" align="center" justify="center" bg="rgba(1, 1, 4, 0.6)" zIndex="modal" p="4">
      <Box bg="bg.surface" borderRadius="card" p="6" maxW="md" w="full" boxShadow="lg">
        <Stack gap="3">
          <Heading size="md">{title}</Heading>
          <Text fontSize="sm" color="fg.muted" lineHeight="1.6">
            {body}
          </Text>
          {authError?.appTokenReason && (
            <Code fontSize="xs" variant="surface">
              reason: {authError.appTokenReason}
            </Code>
          )}
          <Flex gap="2" justify="flex-end" pt="2">
            {onClose && (
              <Button size="sm" variant="ghost" onClick={onClose}>
                Dismiss
              </Button>
            )}
            {/* Brand blue, not yellow. §1 reserves yellow for the citation highlight, and a
                refresh button is the plainest possible counter-example to "the one thing
                on screen that carries meaning". */}
            <Button
              size="sm"
              bg="accent.solid"
              color="accent.contrast"
              _hover={{ opacity: 0.85 }}
              onClick={() => window.location.reload()}
            >
              Refresh page
            </Button>
          </Flex>
        </Stack>
      </Box>
    </Flex>
  )
}
