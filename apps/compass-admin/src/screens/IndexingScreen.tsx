/**
 * Indexing — moved here from the client app by §5C.
 *
 * The screen answers one question: "why is this document not answering questions
 * yet". Everything on it is chosen to make that answerable without a database.
 *
 * The column that matters most is **passages with a vector**. A document can read as
 * `indexed` in every other screen, with pages and passages extracted, and still be
 * unreachable by any question because none of those passages were embedded. That
 * failure is invisible everywhere else in this app, and "Re-index unreachable" is the
 * one-click repair for it.
 *
 * There are no batch controls. Batch embedding is off by default and no client has
 * ever turned it on — checked, not assumed: zero batches have ever been created — so
 * the poll and cancel buttons the client app used to carry were unreachable code that
 * looked supported. The worker polls open batches every five minutes on its own. If
 * batch embedding is ever switched on, the controls come back with the screen that
 * needs them.
 */

import { useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { RefreshCw, Wrench } from 'lucide-react'
import { api, type IndexHealthDocument, type IngestJobView } from '@/lib/client'
import { AsyncState, Button, Cell, Panel, Pill, Stat, Table, useLoader } from '@/components/primitives'

function formatWhen(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function IndexingScreen({
  portalRowId,
  portalLabel,
}: {
  portalRowId: string | null
  portalLabel: string | null
}): React.ReactElement {
  const { data, loading, error, reload } = useLoader(
    () => (portalRowId ? api.indexing(portalRowId) : Promise.resolve(null)),
    [portalRowId],
  )
  const [actionError, setActionError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!portalRowId) {
    return (
      <Text fontSize="sm" color="fg.muted">
        Pick a portal above to see how its documents are indexing.
      </Text>
    )
  }

  const act = async (run: () => Promise<string>): Promise<void> => {
    setActionError(null)
    setReceipt(null)
    setBusy(true)
    try {
      setReceipt(await run())
      reload()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const documents: IndexHealthDocument[] = data?.documents ?? []
  const jobs: IngestJobView[] = data?.jobs ?? []
  const failedJobs = jobs.filter((job) => job.status === 'failed').length
  // Passages extracted but none embedded: indexed everywhere else, unanswerable here.
  const unsearchable = documents.filter((document) => document.chunksEmbedded === 0).length

  return (
    <Stack gap="4">
      {actionError ? (
        <Box borderWidth="1px" borderColor="red.400" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm" color="red.500">
            {actionError}
          </Text>
        </Box>
      ) : null}

      {receipt ? (
        <Box borderWidth="1px" borderColor="ok.fg" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm" color="ok.fg">
            {receipt}
          </Text>
        </Box>
      ) : null}

      <Panel
        title={`Pipeline${portalLabel ? ` — ${portalLabel}` : ''}`}
        actions={
          <HStack gap="2">
            <Button onClick={() => reload()} label="Reload the pipeline snapshot">
              <HStack gap="1">
                <RefreshCw size={13} />
                <Text>Refresh</Text>
              </HStack>
            </Button>
            {/* Both repairs are offered only when there is something to repair.
                A button that reports "0 requeued" teaches an operator to distrust
                the screen. */}
            {failedJobs > 0 ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await api.retryFailedJobs(portalRowId)
                    return `${result.requeued} failed job(s) requeued.`
                  })
                }
                label={`Retry ${failedJobs} failed job(s)`}
              >
                <HStack gap="1">
                  <Wrench size={13} />
                  <Text>Retry {failedJobs} failed</Text>
                </HStack>
              </Button>
            ) : null}
            {unsearchable > 0 ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await api.reindexUnsearchable(portalRowId)
                    return `${result.enqueued} document(s) queued for re-indexing.`
                  })
                }
                label={`Re-index ${unsearchable} unreachable document(s)`}
              >
                <HStack gap="1">
                  <Wrench size={13} />
                  <Text>Re-index {unsearchable} unreachable</Text>
                </HStack>
              </Button>
            ) : null}
          </HStack>
        }
      >
        <AsyncState
          loading={loading}
          error={error}
          empty={false}
          emptyMessage="No pipeline activity."
        >
          {/* §5, one emphasis per view. The queue counts are bookkeeping; the number
              that decides whether anyone needs to do something today is how many
              documents a client cannot get an answer out of. It is the emphasis
              whatever its value, because "zero unreachable" is the reassurance the
              screen exists to give, and a number that only appears when it is bad
              teaches people not to look. */}
          <HStack p="4" gap="7" wrap="wrap" align="end">
            <Stat
              value={unsearchable}
              label="unreachable by a question"
              primary
              tone={unsearchable > 0 ? 'warn' : 'default'}
            />
            {Object.entries(data?.statusCounts ?? {}).map(([status, count]) => (
              <Stat key={status} value={count} label={status} />
            ))}
          </HStack>
        </AsyncState>
      </Panel>

      <Panel title={`Documents (${documents.length})`}>
        <AsyncState
          loading={loading}
          error={error}
          empty={documents.length === 0}
          emptyMessage="This portal has no documents yet."
        >
          <Table
            headers={['Document', 'Status', 'Pages', 'Passages', 'With a vector', 'Indexed']}
          >
            {documents.map((document) => (
              <Box as="tr" key={document.documentId}>
                <Cell>
                  <Stack gap="0">
                    <Text>{document.name}</Text>
                    {document.errorMessage ? (
                      <Text fontSize="xs" color="red.600">
                        {document.errorMessage}
                      </Text>
                    ) : document.statusDetail ? (
                      <Text fontSize="xs" color="fg.muted">
                        {document.statusDetail}
                      </Text>
                    ) : null}
                  </Stack>
                </Cell>
                <Cell>
                  <Pill value={document.status} />
                </Cell>
                <Cell muted>{document.pageCount ?? '—'}</Cell>
                <Cell muted>{document.chunksPresent}</Cell>
                <Cell>
                  {/* The whole reason this screen exists. Passages with no vector
                      means the document is indexed and unanswerable. */}
                  {document.chunksEmbedded === 0 && document.chunksPresent > 0 ? (
                    <Text color="warn.fg" fontSize="sm">
                      0 — cannot be cited
                    </Text>
                  ) : (
                    <Text>{document.chunksEmbedded}</Text>
                  )}
                </Cell>
                <Cell muted nowrap>
                  {formatWhen(document.indexedAt)}
                </Cell>
              </Box>
            ))}
          </Table>
        </AsyncState>
      </Panel>

      <Panel title={`Recent jobs (${jobs.length})`}>
        <AsyncState
          loading={loading}
          error={error}
          empty={jobs.length === 0}
          emptyMessage="No pipeline jobs have run for this portal."
        >
          <Table headers={['Job', 'Status', 'Attempts', 'Queued', 'Finished']}>
            {jobs.map((job) => (
              <Box as="tr" key={job.id}>
                <Cell>
                  <Stack gap="0">
                    <Text>{job.kind}</Text>
                    {job.lastError ? (
                      <Text fontSize="xs" color="red.600">
                        {job.lastError}
                      </Text>
                    ) : null}
                  </Stack>
                </Cell>
                <Cell>
                  <Pill value={job.status} />
                </Cell>
                <Cell muted>
                  {job.attempts} / {job.maxAttempts}
                </Cell>
                <Cell muted nowrap>
                  {formatWhen(job.createdAt)}
                </Cell>
                <Cell muted nowrap>
                  {formatWhen(job.finishedAt)}
                </Cell>
              </Box>
            ))}
          </Table>
        </AsyncState>
      </Panel>
    </Stack>
  )
}
