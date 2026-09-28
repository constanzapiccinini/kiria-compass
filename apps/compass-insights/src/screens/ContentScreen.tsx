/**
 * Content — §1.2 and §1.3, org-wide: what gets read, and what nobody opens.
 *
 * Both from `chat_messages.citations`, which has carried the document, the name and
 * the page since 0001. Nothing new is captured for either.
 *
 * **The library is shown beside every never-cited document**, and that is load-bearing
 * rather than decorative: production holds two documents called
 * `brand guidelines - kiria.pdf` in different libraries, one cited fourteen times over
 * and one never opened. Without the library, the same name would appear in both tables
 * and the screen would look broken. It is the same disambiguation the client sidebar
 * needed in Phase 6 — a document name is not an identifier.
 *
 * ## "Never cited" has a floor, and says so
 *
 * A PDF indexed an hour ago is not evidence that nobody wants it. The backend excludes
 * anything younger than seven days and returns that number, so the screen can state
 * the rule instead of implying a verdict.
 *
 * No question text here: this is org-scoped (§2).
 */

import { Box, Stack, Text } from '@chakra-ui/react'
import { AsyncState, Cell, Panel, Table, useLoader } from '@/components/primitives'
import { api } from '@/lib/client'

function formatWhen(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function ContentScreen(): React.ReactElement {
  const { data, loading, error } = useLoader(() => api.documents(), [])

  return (
    <Stack gap="4">
      <Panel title={`Most read (${data?.cited.length ?? 0})`}>
        <AsyncState
          loading={loading}
          error={error}
          empty={(data?.cited.length ?? 0) === 0}
          emptyMessage="Nothing has been cited yet."
        >
          <Table headers={['Document', 'Citations', 'Answers', 'Accounts', 'Last cited']}>
            {(data?.cited ?? []).map((row) => (
              <Box as="tr" key={row.documentId}>
                <Cell>{row.documentName}</Cell>
                <Cell muted>{row.citations}</Cell>
                <Cell muted>{row.answers}</Cell>
                {/* How many accounts read it, which is the difference between "one
                    client's favourite" and "material the whole book relies on". */}
                <Cell muted>{row.clients}</Cell>
                <Cell muted nowrap>
                  {formatWhen(row.lastCitedAt)}
                </Cell>
              </Box>
            ))}
          </Table>
        </AsyncState>
      </Panel>

      <Panel title={`Never opened (${data?.neverCited.length ?? 0})`}>
        <AsyncState
          loading={loading}
          error={error}
          empty={(data?.neverCited.length ?? 0) === 0}
          emptyMessage="Every document old enough to count has been cited at least once."
        >
          <Stack>
            <Box px="4" pt="3">
              <Text fontSize="xs" color="fg.muted">
                Indexed more than {data?.neverCitedMinDays ?? 7} days ago and never cited in an
                answer. A document younger than that is excluded — it has not had a fair chance.
              </Text>
            </Box>
            <Table headers={['Document', 'Library', 'Indexed', 'Days live', 'Passages']}>
              {(data?.neverCited ?? []).map((row) => (
                <Box as="tr" key={row.documentId}>
                  <Cell>{row.documentName}</Cell>
                  {/* Not optional. Two libraries can hold the same filename, and one
                      may be the most-cited document in the org. */}
                  <Cell muted>{row.library ?? '(no library)'}</Cell>
                  <Cell muted nowrap>
                    {formatWhen(row.indexedAt)}
                  </Cell>
                  <Cell>
                    {row.daysLive >= 30 ? (
                      <Text color="warn.fg">
                        {row.daysLive}
                      </Text>
                    ) : (
                      <Text color="fg.muted">{row.daysLive}</Text>
                    )}
                  </Cell>
                  <Cell muted>{row.chunkCount}</Cell>
                </Box>
              ))}
            </Table>
          </Stack>
        </AsyncState>
      </Panel>
    </Stack>
  )
}
