/**
 * Review — §7 screen 5: "flags with the question in context, and reviewed / dismissed
 * / escalated with a note. Escalation is a human deciding, not a webhook."
 *
 * ## Not a table
 *
 * Every other screen here is a table, and this one is a stack of cards. The difference
 * is what the reader is doing: on the other screens they are scanning for a pattern,
 * here they are reading one question and deciding about it. A table optimises for
 * comparison across rows and this task has no comparison in it — it has a question, the
 * answer the client was given, and a judgement. Squeezing a two-paragraph question into
 * a table cell would make the truncation the reviewer's problem, and the truncated part
 * is exactly where an adverse-event mention hides.
 *
 * ## The question is never truncated
 *
 * For the same reason. If it is long, the card is long.
 *
 * ## Why the screening progress line is at the top
 *
 * An empty queue means one of two very different things — nothing was flagged, or
 * nothing has been screened — and a compliance queue that cannot tell them apart is
 * worse than no queue, because it looks like an answer. The line says how much of the
 * eligible history has been looked at, straight from `flag_screened_at`.
 *
 * ## The decision is deliberately three buttons and a note
 *
 * No bulk actions, no "dismiss all". A recall-tuned classifier produces false positives
 * on purpose (§5), and the cost of that trade is that a person reads each one — which
 * only holds if the interface makes reading each one the path of least resistance.
 */

import { useCallback, useState } from 'react'
import { Box, Flex, HStack, Stack, Text } from '@chakra-ui/react'
import { AsyncState, Button, Panel, Pill, useLoader } from '@/components/primitives'
import { PlainSelect, PlainTextarea } from '@/components/ui/native'
import { ApiError, api, type ReviewFlag } from '@/lib/client'

/** What each code is looking for, in the reviewer's words rather than the prompt's. */
const CODE_LABEL: Record<string, string> = {
  adverse_event: 'Possible adverse event',
  off_label: 'Off-label use',
  complaint: 'Complaint',
  privacy: 'Personal data',
  other: 'Other',
}

const STATUS_FILTERS = [
  { value: 'new', label: 'Waiting' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'Everything' },
]

function formatWhen(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/**
 * One flag, and the decision on it.
 *
 * The note box is always visible rather than revealed by a button. A note written
 * after the fact is a note nobody writes, and the escalation path requires one.
 */
function FlagCard({
  flag,
  onDecided,
}: {
  flag: ReviewFlag
  onDecided: () => void
}): React.ReactElement {
  const [notes, setNotes] = useState(flag.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const decide = useCallback(
    async (status: 'reviewed' | 'dismissed' | 'escalated') => {
      setBusy(true)
      setError(null)
      try {
        await api.decideFlag(flag.flagId, status, notes.trim() === '' ? null : notes)
        onDecided()
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not save the decision')
        setBusy(false)
      }
    },
    [flag.flagId, notes, onDecided],
  )

  const decided = flag.status !== 'new'

  return (
    <Stack borderWidth="1px" borderRadius="card" bg="bg.surface" p="4" gap="3">
      <Flex justify="space-between" align="start" gap="3" wrap="wrap">
        <HStack gap="2" wrap="wrap">
          <Pill value={CODE_LABEL[flag.code] ?? flag.code} />
          <Pill value={flag.status} />
          <Text fontSize="xs" color="fg.muted">
            {flag.clientName}
          </Text>
        </HStack>
        <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">
          asked {formatWhen(flag.askedAt)}
          {flag.confidence === null ? '' : ` · confidence ${flag.confidence.toFixed(2)}`}
        </Text>
      </Flex>

      <Box>
        <Text fontSize="xs" color="fg.muted" fontWeight="medium">
          They asked
        </Text>
        {/* In full, and wrapped as written. See the file docblock. */}
        <Text fontSize="sm" whiteSpace="pre-wrap">
          {flag.question}
        </Text>
      </Box>

      <Box>
        <Text fontSize="xs" color="fg.muted" fontWeight="medium">
          We answered
          {flag.answerGrounded === false ? ' (no supporting material was found)' : ''}
        </Text>
        <Text fontSize="sm" whiteSpace="pre-wrap" color={flag.answer ? undefined : 'fg.muted'}>
          {flag.answer ?? 'No answer was recorded for this question.'}
        </Text>
      </Box>

      {decided ? (
        <Box borderTopWidth="1px" pt="3">
          <Text fontSize="xs" color="fg.muted">
            {flag.status} by {flag.reviewedBy ?? 'unknown'} on {formatWhen(flag.reviewedAt)}
          </Text>
          {flag.notes ? (
            <Text fontSize="sm" whiteSpace="pre-wrap" mt="1">
              {flag.notes}
            </Text>
          ) : null}
        </Box>
      ) : (
        <Stack gap="2" borderTopWidth="1px" pt="3">
          <PlainTextarea
            value={notes}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
              setNotes(event.target.value)
            }
            rows={2}
            placeholder="What you saw, and why. Required to escalate."
            aria-label="Reviewer note"
            px="2"
            py="1.5"
            fontSize="sm"
            w="100%"
          />
          <HStack gap="2" wrap="wrap">
            {/* Escalate first, and visually first, because it is the decision that
                must not be the hardest one to reach. */}
            <Button
              onClick={() => void decide('escalated')}
              variant="danger"
              disabled={busy || notes.trim() === ''}
              label="Escalate this flag"
            >
              Escalate
            </Button>
            <Button onClick={() => void decide('reviewed')} disabled={busy}>
              Reviewed, no action
            </Button>
            <Button onClick={() => void decide('dismissed')} disabled={busy}>
              Not a concern
            </Button>
          </HStack>
          {notes.trim() === '' ? (
            <Text fontSize="xs" color="fg.muted">
              An escalation needs a note. The other two do not, but a dismissal is the
              decision most likely to be asked about later.
            </Text>
          ) : null}
          {error ? (
            <Text fontSize="xs" color="red.600" _dark={{ color: 'red.300' }}>
              {error}
            </Text>
          ) : null}
        </Stack>
      )}

      <Text fontSize="10px" color="fg.muted">
        flagged by {flag.model} · {flag.promptVersion} · {formatWhen(flag.createdAt)}
      </Text>
    </Stack>
  )
}

export function ReviewScreen(): React.ReactElement {
  const [status, setStatus] = useState('new')
  const { data, loading, error, reload } = useLoader(() => api.flags(status), [status])

  const flags = data?.flags ?? []
  const waiting = data?.byStatus.new ?? 0
  const screening = data?.screening

  return (
    <Stack gap="4">
      <Panel
        title={`Review queue (${waiting} waiting)`}
        actions={
          <PlainSelect
            value={status}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
              setStatus(event.target.value)
            }
            aria-label="Filter by status"
            px="2"
            py="1"
            fontSize="sm"
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </PlainSelect>
        }
      >
        <Box px="4" py="3">
          {/* What an empty queue means. See the file docblock — this is the line that
              stops "nothing to review" from being read into "nothing was screened". */}
          <Text fontSize="xs" color="fg.muted">
            {screening
              ? `${screening.screened} of ${screening.eligible} questions have been screened.`
              : 'Screening progress is not available.'}{' '}
            Flagging errs towards false positives on purpose: a missed adverse-event
            mention costs far more than one a reviewer dismisses in two seconds. Nothing
            here is sent to the client, and nothing fires when a flag is escalated.
          </Text>
        </Box>
      </Panel>

      <AsyncState
        loading={loading}
        error={error}
        empty={flags.length === 0}
        emptyMessage={
          status === 'new'
            ? 'Nothing is waiting for review.'
            : 'No flags with that status.'
        }
      >
        <Stack gap="3">
          {flags.map((flag) => (
            <FlagCard key={flag.flagId} flag={flag} onDecided={reload} />
          ))}
        </Stack>
      </AsyncState>
    </Stack>
  )
}
