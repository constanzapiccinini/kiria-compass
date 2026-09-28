/**
 * Overview — §7 screen 1, org-level and k-anonymised.
 *
 * **No question text appears here, ever.** §2 draws that line and the backend enforces
 * it, but the screen states it too: an operator reading a gap rate should know they
 * are looking at counts by design rather than by coincidence.
 *
 * ## The gap rate is shown with its denominator, on purpose
 *
 * "28.6%" over seven answers is not a rate, it is an anecdote. §1 says the answer-gap
 * rate is the headline value of the whole phase, which makes it exactly the number
 * most likely to end up in a slide without its base. So the tile carries the count,
 * and a coverage line says how much of the book it is computed over.
 *
 * ## Charts come last, if at all
 *
 * §1: "Charts of message counts are decoration; build them last if at all." The weekly
 * series is here as a small table rather than a chart for that reason — with seven
 * accounts and a handful of weeks, a line chart is a decoration around four numbers.
 * When there is a year of history and a trend worth seeing, it becomes a chart and
 * follows the `dataviz` guidance then.
 */

import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { AsyncState, Cell, Panel, Table, useLoader } from '@/components/primitives'
import { api } from '@/lib/client'

/** One number and what it means, with room for the qualifier it needs. */
function Tile({
  label,
  value,
  detail,
  tone,
  primary = false,
}: {
  label: string
  value: string
  detail?: string
  tone?: 'warn' | 'default'
  /**
   * The one number on this screen (§5).
   *
   * > one emphasis per view … the one number that matters on each screen is the one in
   * > brand blue at 800 weight; the rest of the table is ink.
   *
   * Exactly one tile may set this. Three numbers at the same weight and colour is the
   * shape §5 calls generic — six identical boxes in a grid, nothing telling the eye
   * where to go — and it is what the screenshot review found here.
   */
  primary?: boolean
}): React.ReactElement {
  return (
    <Box
      borderWidth="1px"
      borderColor={tone === 'warn' ? 'warn.border' : 'border.default'}
      borderRadius="card"
      bg="bg.surface"
      px="4"
      py="3"
      flex="1"
      minW="0"
    >
      <Text
        fontSize="11px"
        color="fg.muted"
        textTransform="uppercase"
        fontWeight="extrabold"
        letterSpacing="label"
      >
        {label}
      </Text>
      <Text
        fontSize={primary ? '32px' : '2xl'}
        fontWeight="extrabold"
        lineHeight="1.15"
        color={primary ? 'accent.solid' : 'fg.default'}
      >
        {value}
      </Text>
      {detail ? (
        <Text fontSize="xs" color="fg.muted" mt="0.5">
          {detail}
        </Text>
      ) : null}
    </Box>
  )
}

export function OverviewScreen(): React.ReactElement {
  const { data, loading, error } = useLoader(() => api.overview(), [])

  const totals = data?.totals
  const coverage = data?.coverage
  const gapRate =
    totals && totals.answers > 0 ? ((totals.gaps / totals.answers) * 100).toFixed(1) : null

  return (
    <Stack gap="4">
      <AsyncState loading={loading} error={error} empty={!data} emptyMessage="No data yet.">
        {data ? (
          <Stack gap="4">
            <HStack gap="3" align="stretch" flexWrap="wrap">
              {/* The headline — and the screen's one emphasis (§5): brand blue, 800,
                  larger than its neighbours. Bordered whenever there is any gap at all — this is the
                  brief for the next Compass chapter, and a neutral tile invites
                  reading it as a statistic rather than as work. */}
              <Tile
                label="Answer gap"
                value={gapRate === null ? '—' : `${gapRate}%`}
                detail={
                  totals && totals.answers > 0
                    ? `${totals.gaps} of ${totals.answers} answers found nothing`
                    : 'no answers in this window'
                }
                tone={totals && totals.gaps > 0 ? 'warn' : 'default'}
                primary
              />
              <Tile
                label="Questions"
                value={String(totals?.questions ?? 0)}
                detail={`across ${totals?.chats ?? 0} conversation(s)`}
              />
              <Tile
                label="Clients active"
                value={String(totals?.clientsActive ?? 0)}
                detail={
                  coverage
                    ? `of ${coverage.clients} account(s)` +
                      (coverage.optedOut > 0 ? `, ${coverage.optedOut} opted out` : '')
                    : undefined
                }
              />
            </HStack>

            {/* The honesty line. Without it the numbers above read as a fact about the
                book of business rather than about whoever happened to ask something. */}
            {coverage ? (
              <Box borderWidth="1px" borderRadius="card" bg="bg.surface" px="4" py="3">
                <Text fontSize="sm">
                  Computed over the last {data.windowDays} days, from{' '}
                  {totals?.clientsActive ?? 0} of {coverage.clients} accounts.
                </Text>
                <Text fontSize="xs" color="fg.muted" mt="1">
                  {coverage.questionsEmbedded} of {coverage.questionsEmbeddable} questions are
                  embedded and ready for theme clustering.
                  {coverage.optedOut > 0
                    ? ` ${coverage.optedOut} account(s) have opted out of analysis and appear in none of these numbers.`
                    : ''}
                  {coverage.withRetention === 0
                    ? ' No account has a retention limit set, so nothing is being deleted.'
                    : ` ${coverage.withRetention} account(s) have a retention limit.`}
                </Text>
              </Box>
            ) : null}

            <Panel title="By week">
              <AsyncState
                loading={false}
                error={null}
                empty={data.series.length === 0}
                emptyMessage="Nothing asked in this window."
              >
                <Table headers={['Week', 'Questions', 'Gaps', 'Clients active']}>
                  {data.series.map((week) => (
                    <Box as="tr" key={week.week}>
                      <Cell nowrap>{week.week}</Cell>
                      <Cell muted>{week.questions}</Cell>
                      <Cell>
                        {week.gaps > 0 ? (
                          <Text color="warn.fg">
                            {week.gaps}
                          </Text>
                        ) : (
                          <Text color="fg.muted">0</Text>
                        )}
                      </Cell>
                      <Cell muted>{week.clientsActive}</Cell>
                    </Box>
                  ))}
                </Table>
              </AsyncState>
            </Panel>

            {/* Named, not shown as an empty box. An empty "Top themes" panel is a
                claim that there are none; this says the feature has not shipped. */}
            <Panel title="Not here yet">
              <Stack p="4" gap="2">
                <Text fontSize="sm" color="fg.muted">
                  {data.pending.themes}
                </Text>
                <Text fontSize="sm" color="fg.muted">
                  {data.pending.flags}
                </Text>
              </Stack>
            </Panel>
          </Stack>
        ) : null}
      </AsyncState>
    </Stack>
  )
}
