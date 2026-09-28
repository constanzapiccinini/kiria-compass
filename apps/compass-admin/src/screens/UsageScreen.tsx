/**
 * Screen 7 — Usage.
 *
 * Cost comes from the `cost_usd` stored on each usage row, not from recomputing
 * current prices against historical token counts. A usage row keeps what it was
 * charged at, so a price change cannot silently rewrite last month. Current rates are
 * shown separately, where they cannot be mistaken for having applied retroactively.
 */

import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { api } from '@/lib/client'
import { AsyncState, Cell, Panel, Stat, Table, useLoader } from '@/components/primitives'

function money(value: number): string {
  // Four decimals: per-client monthly cost is routinely under a cent, and rounding to
  // two would render most rows as $0.00 — which reads as "no usage" rather than
  // "cheap".
  return `$${value.toFixed(4)}`
}

export function UsageScreen(): React.ReactElement {
  const { data, loading, error } = useLoader(() => api.usage(), [])
  const rows = data?.clients ?? []
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0)

  return (
    <Stack gap="4">
      <Panel
        title="Month to date"
        actions={
          <Text fontSize="sm" color="fg.muted">
            since {data ? new Date(data.periodStart).toLocaleDateString() : '—'}
          </Text>
        }
      >
        {/* §5, one emphasis per view. The month's spend was a clause inside a muted
            subtitle — the one number a Usage screen exists to report, set smaller than
            every row of the table beneath it. */}
        <Box px="4" pt="4" pb="4" borderBottomWidth="1px">
          <Stat value={money(total)} label="spent this month" primary />
        </Box>

        <AsyncState
          loading={loading}
          error={error}
          empty={rows.length === 0}
          emptyMessage="No clients yet."
        >
          <Table
            headers={['Client', 'Input tokens', 'Output tokens', 'OCR pages', 'Events', 'Cost']}
          >
            {rows.map((row) => (
              <Box as="tr" key={row.clientId}>
                <Cell>{row.clientName}</Cell>
                <Cell muted>{row.inputTokens.toLocaleString()}</Cell>
                <Cell muted>{row.outputTokens.toLocaleString()}</Cell>
                <Cell muted>{row.ocrPages.toLocaleString()}</Cell>
                <Cell muted>{row.events.toLocaleString()}</Cell>
                <Cell>
                  <Text fontWeight={row.costUsd > 0 ? 'medium' : 'normal'}>
                    {money(row.costUsd)}
                  </Text>
                </Cell>
              </Box>
            ))}
          </Table>
        </AsyncState>
      </Panel>

      <Panel title="Current rates">
        <Stack p="4" gap="2" fontSize="sm">
          <Text fontSize="xs" color="fg.muted">
            Applied to new usage only. The costs above were computed at the rate in force
            when each call was made.
          </Text>
          <HStack gap="6" wrap="wrap">
            <Text>embeddings: $0.13 per 1M input tokens</Text>
            <Text>chat: $0.40 in, $1.60 out per 1M tokens</Text>
            <Text>OCR: $0.0015 per page</Text>
          </HStack>
        </Stack>
      </Panel>
    </Stack>
  )
}
