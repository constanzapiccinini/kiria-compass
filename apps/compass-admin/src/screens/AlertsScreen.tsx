/**
 * Screen 6 — Alerts.
 *
 * `cause` and `remediation` are both shown in full. An alert that says only what
 * broke makes the reader guess what to do, which is the failure mode §10 exists to
 * prevent — so the remediation is authored per code as numbered steps naming the
 * screen to open, and rendered with its line breaks intact.
 *
 * The occurrence count is on the row for the same reason: "failed once" and "failed
 * 400 times" need completely different responses, and a deduplicated inbox that hid
 * the difference would be worse than a noisy one.
 */

import { useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { Check, Eye } from 'lucide-react'
import { api, type AlertRow, type PortalRef } from '@/lib/client'
import { AsyncState, Button, Panel, Pill, useLoader } from '@/components/primitives'
import { PlainSelect } from '@/components/ui/native'
import { AlertChannels } from '@/components/AlertChannels'

export function AlertsScreen({ portals }: { portals: PortalRef[] }): React.ReactElement {
  const [status, setStatus] = useState('open')
  const [clientId, setClientId] = useState('')
  const { data, loading, error, reload } = useLoader(
    () => api.alerts(status, clientId || undefined),
    [status, clientId],
  )
  const [actionError, setActionError] = useState<string | null>(null)

  const alerts = data?.alerts ?? []
  const [resuming, setResuming] = useState(false)

  // Resuming is offered here and nowhere else. It is the screen that shows what the
  // pause is hiding, so it is the only place the decision can be made informed.
  const resume = async (): Promise<void> => {
    setResuming(true)
    setActionError(null)
    try {
      await api.setAlertsPaused(false)
      reload()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Could not resume alerts')
    } finally {
      setResuming(false)
    }
  }

  const setAlert = async (alert: AlertRow, next: string): Promise<void> => {
    setActionError(null)
    try {
      await api.setAlertStatus(alert.id, next)
      reload()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Action failed')
    }
  }

  return (
    <Stack gap="4">
      {data?.paused ? (
        <Box
          borderWidth="1px"
          borderColor="warn.border"
          bg="warn.subtle"
          borderRadius="card"
          p="3"
        >
          <HStack justify="space-between" gap="3" wrap="wrap">
            <Box>
              <Text fontSize="sm" fontWeight="semibold" color="warn.fg">
                Alert delivery is paused
              </Text>
              <Text fontSize="xs" color="fg.muted">
                Nothing is being sent and the rail is not badged. Alerts are still being
                recorded, and everything below is current.
                {data.raisedWhilePaused > 0
                  ? ` ${data.raisedWhilePaused} alert(s) have been raised since the pause began.`
                  : ' Nothing new has been raised since the pause began.'}
                {data.pausedAt ? ` Paused ${new Date(data.pausedAt).toLocaleString()}.` : ''}
              </Text>
            </Box>
            <Button onClick={() => void resume()} variant="primary" disabled={resuming}>
              Resume alerts
            </Button>
          </HStack>
        </Box>
      ) : null}

      {actionError ? (
        <Box borderWidth="1px" borderColor="red.400" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm" color="red.500">
            {actionError}
          </Text>
        </Box>
      ) : null}

      <AlertChannels />

      <HStack gap="3">
        <HStack gap="2">
          <Text fontSize="xs" color="fg.muted">
            Status
          </Text>
          <PlainSelect
            value={status}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setStatus(event.target.value)}
            aria-label="Filter by status"
            borderWidth="1px"
            borderRadius="md"
            px="2"
            py="1"
            fontSize="sm"
            bg="bg.canvas"
          >
            <option value="open">Open</option>
            <option value="new">New</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </PlainSelect>
        </HStack>

        <HStack gap="2">
          <Text fontSize="xs" color="fg.muted">
            Client
          </Text>
          <PlainSelect
            value={clientId}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setClientId(event.target.value)}
            aria-label="Filter by portal"
            borderWidth="1px"
            borderRadius="md"
            px="2"
            py="1"
            fontSize="sm"
            bg="bg.canvas"
          >
            <option value="">All portals</option>
            {portals.map((portal) => (
              <option key={portal.id} value={portal.clientId}>
                {portal.label}
              </option>
            ))}
          </PlainSelect>
        </HStack>
      </HStack>

      <AsyncState
        loading={loading}
        error={error}
        empty={alerts.length === 0}
        emptyMessage={
          status === 'open'
            ? 'Nothing open. Every failure the pipeline names raises a row here, so an empty inbox means nothing is broken.'
            : 'No alerts match that filter.'
        }
      >
        <Stack gap="3">
          {alerts.map((alert) => (
            <Panel
              key={alert.id}
              title={alert.title}
              actions={
                <HStack gap="2">
                  <Pill value={alert.severity} />
                  <Pill value={alert.status} />
                  {alert.status !== 'acknowledged' && alert.status !== 'resolved' ? (
                    <Button onClick={() => void setAlert(alert, 'acknowledged')} label="Acknowledge">
                      <HStack gap="1">
                        <Eye size={13} />
                        <Text>Acknowledge</Text>
                      </HStack>
                    </Button>
                  ) : null}
                  {alert.status !== 'resolved' ? (
                    <Button
                      variant="primary"
                      onClick={() => void setAlert(alert, 'resolved')}
                      label="Resolve"
                    >
                      <HStack gap="1">
                        <Check size={13} />
                        <Text>Resolve</Text>
                      </HStack>
                    </Button>
                  ) : (
                    <Button onClick={() => void setAlert(alert, 'new')} label="Reopen">
                      Reopen
                    </Button>
                  )}
                </HStack>
              }
            >
              <Stack p="4" gap="3" fontSize="sm">
                <HStack gap="4" fontSize="xs" color="fg.muted" wrap="wrap">
                  <Text>{alert.code}</Text>
                  <Text>scope: {alert.scope}</Text>
                  {alert.clientName ? <Text>client: {alert.clientName}</Text> : null}
                  {alert.sourceName ? <Text>source: {alert.sourceName}</Text> : null}
                  <Text>
                    {alert.occurrences}× · first {new Date(alert.firstSeenAt).toLocaleString()} ·
                    last {new Date(alert.lastSeenAt).toLocaleString()}
                  </Text>
                </HStack>

                <Stack gap="1">
                  <Text fontSize="xs" color="fg.muted" fontWeight="medium">
                    What went wrong
                  </Text>
                  <Text whiteSpace="pre-line">{alert.cause}</Text>
                </Stack>

                <Stack gap="1">
                  <Text fontSize="xs" color="fg.muted" fontWeight="medium">
                    How to fix it
                  </Text>
                  <Text whiteSpace="pre-line">{alert.remediation}</Text>
                </Stack>

                {alert.clientMessage ? (
                  <Stack gap="1">
                    <Text fontSize="xs" color="fg.muted" fontWeight="medium">
                      What the client sees
                    </Text>
                    {/* Shown so staff know exactly what was said to the client — and
                        can see that it leaks nothing. */}
                    <Text color="fg.muted">{alert.clientMessage}</Text>
                  </Stack>
                ) : null}
              </Stack>
            </Panel>
          ))}
        </Stack>
      </AsyncState>
    </Stack>
  )
}
