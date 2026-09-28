/**
 * Screen 8 — Audit log.
 *
 * Paged by keyset (`before` = the last row's timestamp) rather than by offset, so
 * entries arriving mid-read cannot make a page skip or repeat rows. In an audit trail
 * that gap is not cosmetic: a skipped row is a missing record.
 *
 * Denials are highlighted. A log where `tenancy_probe_denied` renders like a routine
 * event is a log nobody spots an attack in.
 */

import { useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { api, type PortalRef } from '@/lib/client'
import { AsyncState, Button, Cell, Panel, Table, useLoader } from '@/components/primitives'
import { PlainSelect } from '@/components/ui/native'

function isDenial(action: string): boolean {
  return action.includes('denied') || action.includes('probe')
}

export function AuditScreen({ portals }: { portals: PortalRef[] }): React.ReactElement {
  const [clientId, setClientId] = useState('')
  const [action, setAction] = useState('')
  const [before, setBefore] = useState<string | undefined>(undefined)

  const actions = useLoader(() => api.auditActions(), [])
  const { data, loading, error } = useLoader(
    () => api.audit({ clientId: clientId || undefined, action: action || undefined, before }),
    [clientId, action, before],
  )

  const entries = data?.entries ?? []

  return (
    <Stack gap="4">
      <HStack gap="3" wrap="wrap">
        <HStack gap="2">
          <Text fontSize="xs" color="fg.muted">
            Client
          </Text>
          <PlainSelect
            value={clientId}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
              setClientId(event.target.value)
              // Changing a filter restarts paging. Keeping the cursor would show a
              // page from the middle of a different result set.
              setBefore(undefined)
            }}
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

        <HStack gap="2">
          <Text fontSize="xs" color="fg.muted">
            Action
          </Text>
          <PlainSelect
            value={action}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
              setAction(event.target.value)
              setBefore(undefined)
            }}
            aria-label="Filter by action"
            borderWidth="1px"
            borderRadius="md"
            px="2"
            py="1"
            fontSize="sm"
            bg="bg.canvas"
          >
            <option value="">All actions</option>
            {(actions.data?.actions ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </PlainSelect>
        </HStack>

        {before ? (
          <Button onClick={() => setBefore(undefined)} label="Back to the most recent entries">
            Newest first
          </Button>
        ) : null}
      </HStack>

      <Panel
        title="Audit entries"
        actions={
          data?.nextBefore ? (
            <Button
              onClick={() => setBefore(data.nextBefore ?? undefined)}
              label="Load older entries"
            >
              Older
            </Button>
          ) : undefined
        }
      >
        <AsyncState
          loading={loading}
          error={error}
          empty={entries.length === 0}
          emptyMessage="No audit entries match that filter."
        >
          <Table headers={['When', 'Action', 'Client', 'Actor', 'Target', 'Detail']}>
            {entries.map((entry) => (
              <Box as="tr" key={entry.id} bg={isDenial(entry.action) ? 'red.50' : undefined}>
                <Cell muted nowrap>
                  {new Date(entry.createdAt).toLocaleString()}
                </Cell>
                <Cell>
                  <Text
                    fontWeight={isDenial(entry.action) ? 'semibold' : 'normal'}
                    color={isDenial(entry.action) ? 'red.700' : undefined}
                  >
                    {entry.action}
                  </Text>
                </Cell>
                <Cell muted>{entry.clientName ?? '—'}</Cell>
                <Cell muted nowrap>
                  {entry.actorUserId ?? '—'}
                </Cell>
                <Cell muted>
                  {entry.targetType ? `${entry.targetType} ${entry.targetId ?? ''}` : '—'}
                </Cell>
                <Cell muted>
                  <Text fontSize="xs" fontFamily="mono">
                    {entry.metadata ? JSON.stringify(entry.metadata) : '—'}
                  </Text>
                </Cell>
              </Box>
            ))}
          </Table>
        </AsyncState>
      </Panel>
    </Stack>
  )
}
