/**
 * Who gets told when something breaks (§10.3).
 *
 * Kept collapsed by default. It is configured rarely and read never, so it should
 * not push the actual alerts below the fold — but it belongs on this screen, because
 * the question "why didn't anyone hear about this?" is asked while looking at the
 * alert that nobody heard about.
 */

import { useEffect, useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { ChevronDown, ChevronRight, Save } from 'lucide-react'
import { api, type AlertSettingsResponse } from '@/lib/client'
import { AsyncState, Button, Panel, useLoader } from '@/components/primitives'
import { PlainButton, PlainTextarea } from '@/components/ui/native'

/** One recipient per line — the shape people already expect from a recipient box. */
function toText(recipients: AlertSettingsResponse['recipients']): string {
  return recipients.map((entry) => entry.email ?? entry.userId ?? '').join('\n')
}

export function AlertChannels(): React.ReactElement {
  const [open, setOpen] = useState(false)
  const { data, loading, error, reload } = useLoader(() => api.alertSettings(), [])

  const [email, setEmail] = useState(false)
  const [monday, setMonday] = useState(false)
  const [recipients, setRecipients] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!data) return
    setEmail(data.channels.email)
    setMonday(data.channels.monday)
    setRecipients(toText(data.recipients))
  }, [data])

  const save = async (): Promise<void> => {
    setBusy(true)
    setSaveError(null)
    setSaved(false)
    try {
      const list = recipients
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      await api.saveAlertSettings({ inApp: true, email, monday }, list)
      setSaved(true)
      reload()
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="Notification channels"
      actions={
        <PlainButton
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? 'Hide notification channels' : 'Show notification channels'}
          display="flex"
          alignItems="center"
          gap="1"
          fontSize="sm"
          px="2"
          py="1"
          borderRadius="md"
          cursor="pointer"
          _hover={{ bg: 'bg.subtle' }}
          _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid' }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Text>{open ? 'Hide' : 'Configure'}</Text>
        </PlainButton>
      }
    >
      {!open ? (
        <Text fontSize="sm" color="fg.muted" px="4" py="3">
          {data
            ? `In-app always on. Email ${data.channels.email ? `on, ${data.recipients.length} recipient${data.recipients.length === 1 ? '' : 's'}` : 'off'}.`
            : 'In-app always on.'}
        </Text>
      ) : (
        <AsyncState loading={loading} error={error} empty={false} emptyMessage="">
          <Stack p="4" gap="4" fontSize="sm">
            <Stack gap="2">
              <HStack gap="2">
                <input type="checkbox" checked disabled aria-label="In-app alerts" />
                <Text>In-app</Text>
                <Text fontSize="xs" color="fg.muted">
                  Always on — this screen reads the alert table directly.
                </Text>
              </HStack>

              <HStack gap="2">
                <input
                  type="checkbox"
                  checked={email}
                  aria-label="Email alerts"
                  onChange={(event) => setEmail(event.target.checked)}
                />
                <Text>Email</Text>
              </HStack>

              <HStack gap="2">
                <input
                  type="checkbox"
                  checked={monday}
                  aria-label="monday.com alerts"
                  onChange={(event) => setMonday(event.target.checked)}
                />
                <Text>monday.com</Text>
                <Text fontSize="xs" color="fg.muted">
                  {/* Stated rather than hidden: an operator who ticks this and hears
                      nothing would otherwise assume the alerting itself is broken. */}
                  {data?.notes.mondayStatus ?? 'Not implemented yet.'}
                </Text>
              </HStack>
            </Stack>

            <Stack gap="1">
              <Text fontSize="xs" color="fg.muted" fontWeight="medium">
                Recipients — one per line
              </Text>
              <PlainTextarea
                rows={4}
                value={recipients}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setRecipients(event.target.value)
                }
                aria-label="Alert recipients"
                placeholder={'ops@example.com\n3700332'}
                borderWidth="1px"
                borderRadius="md"
                px="2"
                py="1.5"
                fontSize="sm"
                fontFamily="mono"
                bg="bg.canvas"
                w="100%"
                _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid' }}
              />
              <Text fontSize="xs" color="fg.muted">
                {data?.notes.recipientRule ??
                  'Each recipient must already be a member of this organization.'}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                A repeated failure is emailed at most once every 30 minutes; the alert’s
                occurrence count keeps rising either way.
              </Text>
            </Stack>

            {saveError ? (
              <Text fontSize="sm" color="red.500">
                {saveError}
              </Text>
            ) : null}
            {saved ? (
              <Text fontSize="sm" color="fg.muted">
                Saved.
              </Text>
            ) : null}

            <Box>
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={busy}
                label="Save notification channels"
              >
                <HStack gap="1">
                  <Save size={14} />
                  <Text>Save channels</Text>
                </HStack>
              </Button>
            </Box>
          </Stack>
        </AsyncState>
      )}
    </Panel>
  )
}
