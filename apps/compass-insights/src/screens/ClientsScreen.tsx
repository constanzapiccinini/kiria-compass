/**
 * Clients — §7 screen 2: the picker, then one account's detail.
 *
 * **This is the only screen where verbatim question text appears**, which §2 permits
 * explicitly: "Client-scoped screens may show questions in full to KIRIA staff."
 *
 * The unanswered questions are the point of the screen. A gap rate says there is a
 * hole; the questions say what to write. Each is paired with the answer that failed,
 * because the question alone does not distinguish "we have never covered this" from
 * "we cover it and retrieval missed it" — and those are different pieces of work.
 *
 * ## An opted-out account shows its status and nothing else
 *
 * Not hidden from the list — an account silently missing looks like it does not exist.
 * It appears, marked, and opening it returns the backend's own note instead of any
 * question. §2's flag is honoured in the query, so there is nothing to display even if
 * this screen asked.
 */

import { useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { ArrowLeft } from 'lucide-react'
import { AsyncState, Button, Cell, Panel, Pill, Table, useLoader } from '@/components/primitives'
import { api, type ClientRow } from '@/lib/client'

function formatWhen(value: string | null | undefined): string {
  if (!value) return 'never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function ClientsScreen(): React.ReactElement {
  const { data, loading, error } = useLoader(() => api.clients(), [])
  const [openId, setOpenId] = useState<string | null>(null)

  const clients = data?.clients ?? []
  const open = clients.find((client) => client.clientId === openId) ?? null

  if (open) {
    return <ClientDetail client={open} onBack={() => setOpenId(null)} />
  }

  return (
    <Panel title={`Accounts (${clients.length})`}>
      <AsyncState
        loading={loading}
        error={error}
        empty={clients.length === 0}
        emptyMessage="No accounts yet."
      >
        <Table headers={['Account', 'Questions', 'Answers', 'Gaps', 'Last asked', 'Retention', '']}>
          {clients.map((client) => (
            <Box as="tr" key={client.clientId} opacity={client.optedOut ? 0.6 : 1}>
              <Cell>
                <Stack gap="0">
                  <Text fontWeight="medium">{client.name}</Text>
                  {client.optedOut ? (
                    <Text fontSize="xs" color="warn.fg">
                      opted out of analysis
                    </Text>
                  ) : null}
                </Stack>
              </Cell>
              <Cell muted>{client.questions}</Cell>
              <Cell muted>{client.answers}</Cell>
              <Cell>
                {/* The number worth opening the row for. */}
                {client.gaps > 0 ? (
                  <Text color="warn.fg" fontWeight="medium">
                    {client.gaps}
                  </Text>
                ) : (
                  <Text color="fg.muted">0</Text>
                )}
              </Cell>
              <Cell muted nowrap>
                {formatWhen(client.lastQuestionAt)}
              </Cell>
              <Cell muted nowrap>
                {client.retentionDays === null ? 'kept' : `${client.retentionDays}d`}
              </Cell>
              <Cell nowrap>
                <Button
                  onClick={() => setOpenId(client.clientId)}
                  label={`Open ${client.name}`}
                  disabled={client.questions === 0 && !client.optedOut}
                >
                  Open
                </Button>
              </Cell>
            </Box>
          ))}
        </Table>
      </AsyncState>
    </Panel>
  )
}

function ClientDetail({
  client,
  onBack,
}: {
  client: ClientRow
  onBack: () => void
}): React.ReactElement {
  const detail = useLoader(() => api.client(client.clientId), [client.clientId])
  const documents = useLoader(
    () => api.documents({ clientId: client.clientId }),
    [client.clientId],
  )

  const data = detail.data

  return (
    <Stack gap="4">
      <HStack>
        <Button onClick={onBack} label="Back to all accounts">
          <HStack gap="1">
            <ArrowLeft size={13} />
            <Text>All accounts</Text>
          </HStack>
        </Button>
        <Text fontWeight="semibold">{client.name}</Text>
      </HStack>

      <AsyncState
        loading={detail.loading}
        error={detail.error}
        empty={!data}
        emptyMessage="Nothing to show."
      >
        {data?.optedOut ? (
          <Box borderWidth="1px" borderColor="warn.border" borderRadius="card" p="4" bg="bg.surface">
            <Text fontSize="sm" fontWeight="medium">
              This account has opted out of conversation analysis
            </Text>
            <Text fontSize="sm" color="fg.muted" mt="1">
              {data.note}
            </Text>
          </Box>
        ) : data ? (
          <Stack gap="4">
            {/* The screen that pays for the phase, at account scale. §7 screen 3 makes
                this org-wide and grouped by theme, which needs 8C's clustering; until
                then the raw list per account is already actionable. */}
            <Panel title={`Questions we could not answer (${data.unanswered.length})`}>
              <AsyncState
                loading={false}
                error={null}
                empty={data.unanswered.length === 0}
                emptyMessage="Every question in this window was answered from the material."
              >
                <Stack p="4" gap="3">
                  {data.unanswered.map((row, index) => (
                    <Box
                      key={row.messageId ?? index}
                      borderWidth="1px"
                      borderRadius="card"
                      p="3"
                      bg="bg.canvas"
                    >
                      <Text fontSize="sm" fontWeight="medium">
                        {row.question ?? '(the question could not be paired with this answer)'}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" mt="1">
                        {formatWhen(row.askedAt)}
                      </Text>
                      {row.answer ? (
                        <Text fontSize="xs" color="fg.muted" mt="2" fontStyle="italic">
                          {row.answer.slice(0, 240)}
                          {row.answer.length > 240 ? '…' : ''}
                        </Text>
                      ) : null}
                    </Box>
                  ))}
                </Stack>
              </AsyncState>
            </Panel>

            <Panel title={`Libraries this account receives (${data.libraries.length})`}>
              <AsyncState
                loading={false}
                error={null}
                empty={data.libraries.length === 0}
                emptyMessage="This account receives no libraries, so it can see nothing."
              >
                <Table
                  headers={['Library', 'Granted', 'Documents', 'Questions since', '']}
                >
                  {data.libraries.map((library) => (
                    <Box as="tr" key={library.libraryId}>
                      <Cell>
                        <Stack gap="0">
                          <Text>{library.name}</Text>
                          {library.isPrivate ? (
                            <Text fontSize="xs" color="fg.muted">
                              private to this account
                            </Text>
                          ) : null}
                        </Stack>
                      </Cell>
                      <Cell muted nowrap>
                        {library.daysSinceGrant}d ago
                      </Cell>
                      <Cell muted>{library.documents}</Cell>
                      <Cell>
                        {/* Both numbers, so "granted three weeks ago and never used"
                            is distinguishable from "granted yesterday". */}
                        {library.questionsSinceGrant === 0 && library.daysSinceGrant >= 14 ? (
                          <Text color="warn.fg">
                            0 in {library.daysSinceGrant} days
                          </Text>
                        ) : (
                          <Text color="fg.muted">{library.questionsSinceGrant}</Text>
                        )}
                      </Cell>
                      <Cell muted>—</Cell>
                    </Box>
                  ))}
                </Table>
              </AsyncState>
            </Panel>

            <Panel title="What this account actually reads">
              <AsyncState
                loading={documents.loading}
                error={documents.error}
                empty={(documents.data?.cited.length ?? 0) === 0}
                emptyMessage="No citations yet, so nothing has been read through the chat."
              >
                <Table headers={['Document', 'Citations', 'Answers', 'Last cited']}>
                  {(documents.data?.cited ?? []).map((row) => (
                    <Box as="tr" key={row.documentId}>
                      <Cell>{row.documentName}</Cell>
                      <Cell muted>{row.citations}</Cell>
                      <Cell muted>{row.answers}</Cell>
                      <Cell muted nowrap>
                        {formatWhen(row.lastCitedAt)}
                      </Cell>
                    </Box>
                  ))}
                </Table>
              </AsyncState>
            </Panel>

            <HStack gap="2">
              <Pill value={data.retentionDays === null ? 'kept forever' : `${data.retentionDays}d retention`} />
              <Text fontSize="xs" color="fg.muted">
                Window: last {data.windowDays ?? 90} days.
              </Text>
            </HStack>
          </Stack>
        ) : null}
      </AsyncState>
    </Stack>
  )
}
