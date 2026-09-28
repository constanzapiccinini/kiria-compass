/**
 * Runs — §7 screen 6: what ran, what it did, what failed.
 *
 * Thin by design. Each `insight_runs` row already carries its own counts and its own
 * error, which is what makes `INSIGHT_RUN_FAILED`'s remediation — "read its error" —
 * a true instruction rather than a redirect to the logs.
 *
 * The error is shown in full and never truncated behind a click. The one time this
 * table mattered so far, the whole diagnosis was in the message: a failed embed run
 * reading `insertIsolatedStoreSqlRow returned 400`, which was a vector being
 * stringified into a `DOUBLE PRECISION[]` column.
 */

import { Box, Stack, Text } from '@chakra-ui/react'
import { AsyncState, Cell, Panel, Pill, Table, useLoader } from '@/components/primitives'
import { api } from '@/lib/client'

function formatWhen(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** `{"embedded": 7, "skipped": 0}` reads better as `embedded 7 · skipped 0`. */
function formatCounts(counts: Record<string, unknown>): string {
  const parts = Object.entries(counts)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
    .map(([key, value]) => `${key} ${String(value)}`)
  return parts.length === 0 ? '—' : parts.join(' · ')
}

export function RunsScreen(): React.ReactElement {
  const { data, loading, error } = useLoader(() => api.runs(), [])
  const runs = data?.runs ?? []

  return (
    <Panel title={`Runs (${runs.length})`}>
      <AsyncState
        loading={loading}
        error={error}
        empty={runs.length === 0}
        emptyMessage="Nothing has run yet. The jobs are enqueued by the Compass AI worker on its sweep."
      >
        <Table headers={['Kind', 'Status', 'Counts', 'Started', 'Finished']}>
          {runs.map((run) => (
            <Box as="tr" key={run.id}>
              <Cell>{run.kind}</Cell>
              <Cell>
                <Pill value={run.status} />
              </Cell>
              <Cell>
                <Stack gap="0">
                  <Text fontSize="sm">{formatCounts(run.counts)}</Text>
                  {/* In full. A truncated error is a reason to open the logs, which is
                      what this row exists to avoid. */}
                  {run.lastError ? (
                    <Text fontSize="xs" color="red.600" _dark={{ color: 'red.300' }}>
                      {run.lastError}
                    </Text>
                  ) : null}
                </Stack>
              </Cell>
              <Cell muted nowrap>
                {formatWhen(run.startedAt)}
              </Cell>
              <Cell muted nowrap>
                {formatWhen(run.finishedAt)}
              </Cell>
            </Box>
          ))}
        </Table>
      </AsyncState>
    </Panel>
  )
}
