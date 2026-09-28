/**
 * Content gaps — §7 screen 3: "the actionable one … the screen that pays for the
 * phase".
 *
 * Unanswered questions grouped by theme, ranked by **frequency × accounts affected**,
 * each row traceable to the questions behind it. The ranking is the spec's and it is
 * the right one: a theme asked twice by four accounts is a content gap; the same theme
 * asked eight times by one account is that account's project.
 *
 * ## The questions are shown, not hidden behind a click
 *
 * §7 asks for each row to be "traceable to the questions behind it". A theme label is
 * a model's summary of somebody else's words — it is exactly the thing a person should
 * check before writing a chapter on the strength of it. So the sample questions are on
 * the row, and the label is presented as a name for them rather than as a finding.
 *
 * ## What this screen does not show, and says so
 *
 * Every theme here is scoped to one account. Cross-account themes — the "what recurs
 * across the whole book" question — are gated on §2's contracts and disclosure
 * paragraph, and the database refuses one below three accounts regardless. The banner
 * states that, because a screen that silently shows part of what it could gets read as
 * the whole picture.
 */

import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { AsyncState, Panel, Pill, useLoader } from '@/components/primitives'
import { api } from '@/lib/client'

/** The ranking, restated for the reader rather than left as a sort order. */
function priority(questionCount: number, clientCount: number, unansweredShare: number): number {
  return questionCount * clientCount * unansweredShare
}

export function GapsScreen(): React.ReactElement {
  const { data, loading, error } = useLoader(() => api.gaps(), [])
  const themes = data?.themes ?? []

  return (
    <Stack gap="4">
      {/* Scope, first and plainly. */}
      {data ? (
        <Box borderWidth="1px" borderRadius="card" bg="bg.surface" px="4" py="3">
          <Text fontSize="sm">Grouped within each account.</Text>
          <Text fontSize="xs" color="fg.muted" mt="1">
            {data.scopeNote}
          </Text>
        </Box>
      ) : null}

      <Panel title={`Gaps by theme (${themes.length})`}>
        <AsyncState
          loading={loading}
          error={error}
          empty={themes.length === 0}
          emptyMessage={
            'No themes with unanswered questions yet. Clustering runs daily in the ' +
            'Compass AI worker — check the Runs screen if you expected some.'
          }
        >
          <Stack p="4" gap="3">
            {themes.map((theme) => {
              const share = theme.unansweredShare ?? 0
              return (
                <Box
                  key={theme.themeId}
                  borderWidth="1px"
                  borderColor={share >= 0.5 ? 'warn.border' : 'border.default'}
                  borderRadius="card"
                  p="3"
                  bg="bg.canvas"
                >
                  <HStack justify="space-between" align="start" gap="3">
                    <Stack gap="0" minW="0">
                      <Text fontSize="sm" fontWeight="semibold">
                        {theme.label}
                      </Text>
                      <Text fontSize="xs" color="fg.muted">
                        {theme.summary}
                      </Text>
                    </Stack>
                    <HStack gap="2" flexShrink="0">
                      <Pill value={theme.clientName} />
                      {/* The ranking made legible. A bare sort order leaves the reader
                          guessing why this row is first. */}
                      <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">
                        {theme.questionCount} question(s) ·{' '}
                        {Math.round(share * 100)}% unanswered · priority{' '}
                        {priority(theme.questionCount, theme.clientCount, share).toFixed(1)}
                      </Text>
                    </HStack>
                  </HStack>

                  {theme.sampleQuestions.length > 0 ? (
                    <Stack gap="1" mt="3" pl="3" borderLeftWidth="2px" borderColor="border.default">
                      {/* The label is a model's summary of a client's words. Showing
                          the words is what makes it checkable before anyone writes a
                          chapter on the strength of it. */}
                      {theme.sampleQuestions.map((question, index) => (
                        <Text key={index} fontSize="xs">
                          {question}
                        </Text>
                      ))}
                    </Stack>
                  ) : (
                    <Text fontSize="xs" color="fg.muted" mt="2" fontStyle="italic">
                      The questions behind this theme are no longer available — retention
                      removed them and the aggregate survived (§6).
                    </Text>
                  )}

                  <Text fontSize="10px" color="fg.muted" mt="2">
                    {theme.periodStart} to {theme.periodEnd} · {theme.promptVersion}
                  </Text>
                </Box>
              )
            })}
          </Stack>
        </AsyncState>
      </Panel>

      {/* Why a period and a prompt version are on every row. */}
      <Text fontSize="xs" color="fg.muted">
        Two periods are only comparable when their prompt version matches — the label,
        the model and the similarity threshold all change what a theme is, and the
        version records which produced a row.
      </Text>
    </Stack>
  )
}
