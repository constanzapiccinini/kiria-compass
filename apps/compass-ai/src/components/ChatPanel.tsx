/**
 * Grounded chat content: transcript, evidence cards, composer.
 *
 * Inline citations are rendered as buttons rather than styled text, because their
 * whole purpose is to take the reader to the page the claim came from. Each citation
 * is also listed as an evidence card showing the exact passage, so a claim can be
 * checked without leaving the answer.
 *
 * This is the panel body only — the floating chrome lives in ChatWidget.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Menu,
  Portal,
  Spinner,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react'
import {
  Check,
  ClipboardList,
  Copy,
  FileText,
  MessageSquare,
  Send,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'
import { PlainButton } from '@/components/ui/PlainButton'
import {
  type Citation,
  type ChatMessageView,
  type RetrievalInfo,
} from '@/lib/client'
import {
  answerToMarkdown,
  copyToClipboard,
  toPlainText,
  transcriptToMarkdown,
} from '@/lib/export'

export interface ScopeDocument {
  id: string
  name: string
  ready: boolean
}

interface ChatPanelProps {
  messages: ChatMessageView[]
  busy: boolean
  lastRetrieval: RetrievalInfo | null
  notice: string | null
  /** Every indexable document in the workspace, for the scope selector. */
  scopeDocuments: ScopeDocument[]
  selectedIds: string[]
  onToggleSelected: (documentId: string) => void
  onSend: (question: string) => void
  onCitationClick: (citation: Citation) => void
  /**
   * Rate one answer. Resolves false when the write failed, so the control can revert.
   *
   * Optional: `fixtures.spec`-style callers and any future read-only embedding of
   * this panel should not have to supply it, and the control simply does not render
   * without it — an unwired thumb that silently does nothing is worse than no thumb.
   */
  onRateAnswer?: (messageId: string, rating: 1 | -1) => Promise<boolean>
}

const NO_INFORMATION_PREFIX = 'There is no information in the provided document'

/** Matches the `[Document Name, Page 12]` form the backend produces. */
const CITATION_PATTERN = /(\[[^[\]]+?,\s*Page\s*\d+[^[\]]*\])/g

/**
 * Render an answer as blocks, turning each resolved citation into a jump button.
 * `citations` is the authoritative list from the backend; a label with no match
 * there renders as plain text rather than a dead button.
 */
function AnswerBody({
  content,
  citations,
  onCitationClick,
}: {
  content: string
  citations: Citation[]
  onCitationClick: (citation: Citation) => void
}) {
  const blocks = useMemo(
    () => content.split(/\n{2,}/).filter((block) => block.trim().length > 0),
    [content],
  )

  return (
    <Stack gap="2">
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n')
        const isList = lines.every((line) => /^\s*([-*•]|\d+[.)])\s+/.test(line))

        if (isList) {
          return (
            <Stack as="ul" key={blockIndex} gap="1" pl="4" listStyleType="disc">
              {lines.map((line, lineIndex) => (
                <Box as="li" key={lineIndex} fontSize="sm" lineHeight="1.65">
                  <InlineText
                    text={line.replace(/^\s*([-*•]|\d+[.)])\s+/, '')}
                    citations={citations}
                    onCitationClick={onCitationClick}
                  />
                </Box>
              ))}
            </Stack>
          )
        }
        return (
          <Text key={blockIndex} fontSize="sm" lineHeight="1.65">
            <InlineText text={block} citations={citations} onCitationClick={onCitationClick} />
          </Text>
        )
      })}
    </Stack>
  )
}

/** Find the citation a rendered label refers to, by document name and page. */
function matchCitation(label: string, citations: Citation[]): Citation | null {
  const parsed = /^\[(.+?),\s*Page\s*(\d+)/.exec(label)
  if (!parsed) return null
  const name = parsed[1].trim()
  const page = Number(parsed[2])
  return (
    citations.find((citation) => citation.documentName === name && citation.page === page) ?? null
  )
}

function InlineText({
  text,
  citations,
  onCitationClick,
}: {
  text: string
  citations: Citation[]
  onCitationClick: (citation: Citation) => void
}) {
  // Split on citations first so bold parsing never straddles one.
  const parts = text.split(CITATION_PATTERN)

  return (
    <>
      {parts.map((part, index) => {
        if (/^\[[^[\]]+?,\s*Page\s*\d+[^[\]]*\]$/.test(part)) {
          const citation = matchCitation(part, citations)
          if (!citation) {
            return (
              <Box as="span" key={index} fontSize="xs" color="fg.muted">
                {part}
              </Box>
            )
          }
          return (
            <PlainButton
              type="button"
              key={index}
              onClick={() => onCitationClick(citation)}
              title={`Go to ${citation.documentName}, page ${citation.page}`}
              display="inline"
              whiteSpace="nowrap"
              fontSize="xs"
              fontWeight="medium"
              color="accent.fg"
              bg="accent.subtle"
              borderRadius="4px"
              px="1"
              mx="0.5"
              cursor="pointer"
              textAlign="left"
              _hover={{ textDecoration: 'underline' }}
              _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid', outlineOffset: '1px' }}
            >
              {part}
            </PlainButton>
          )
        }
        return (
          <Box as="span" key={index}>
            {part.split(/(\*\*[^*]+\*\*)/g).map((piece, pieceIndex) =>
              /^\*\*[^*]+\*\*$/.test(piece) ? (
                <Text as="strong" key={pieceIndex} fontWeight="semibold">
                  {piece.slice(2, -2)}
                </Text>
              ) : (
                <Box as="span" key={pieceIndex}>
                  {piece}
                </Box>
              ),
            )}
          </Box>
        )
      })}
    </>
  )
}

function CitationCard({
  citation,
  onClick,
}: {
  citation: Citation
  onClick: (citation: Citation) => void
}) {
  return (
    <PlainButton
      type="button"
      onClick={() => onClick(citation)}
      textAlign="left"
      width="full"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="control"
      p="2"
      bg="bg.canvas"
      cursor="pointer"
      transition="border-color 120ms"
      _hover={{ borderColor: 'accent.solid' }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent.solid', outlineOffset: '2px' }}
    >
      <HStack gap="2" mb="1" flexWrap="wrap">
        {/* Not yellow, even though this badge sits on a citation card. §1 lists the
            exclusions by name — "not on buttons, not on badges, not on the chat pill" —
            and the reason holds here: the yellow swipe in the document is the citation.
            A yellow badge in the chat competing with it makes two things claim to be
            the one thing that matters. */}
        <Badge size="sm" bg="bg.raised" color="fg.muted" variant="subtle">
          Page {citation.page}
        </Badge>
        <Text fontSize="xs" fontWeight="medium" wordBreak="break-word">
          {citation.documentName}
        </Text>
        {citation.sectionTitle && (
          <Text fontSize="xs" color="fg.muted">
            {citation.sectionTitle}
          </Text>
        )}
      </HStack>
      <Text fontSize="xs" color="fg.muted" lineHeight="1.5">
        “{citation.snippet}
        {citation.snippet.length >= 320 ? '…' : ''}”
      </Text>
    </PlainButton>
  )
}

/**
 * Thumbs up / down on one answer (Phase 8 §3).
 *
 * The cheapest high-value signal there is: without it, "was this answer good" is
 * guesswork over latency and token counts. It is the one addition Phase 8 makes to
 * the client app, and it belongs to chat rather than to configuration — a reader
 * reacting to an answer is reading, not configuring — so §5C's view-and-chat rule
 * still holds.
 *
 * **Optimistic, and it reverts on failure.** A rating is a two-hundred-millisecond
 * round trip against an isolated store, and a thumb that waits for it feels broken.
 * Reverting rather than leaving the optimistic state is the part that matters: a
 * rating that looks saved and was not is worse than one that visibly failed, because
 * nobody rates twice.
 *
 * No count is shown, ever. The backend returns this person's own rating and nothing
 * else — "three colleagues disliked this" is a different product with different
 * consent behind it.
 */
function AnswerRating({
  rating,
  onRate,
}: {
  rating: number | null
  onRate: (next: 1 | -1) => Promise<boolean>
}): React.ReactElement {
  const [current, setCurrent] = useState<number | null>(rating)
  const [busy, setBusy] = useState(false)

  // Re-synced when the conversation is reloaded: the prop is the stored truth and the
  // local state is only ahead of it while a request is in flight.
  useEffect(() => setCurrent(rating), [rating])

  const rate = (next: 1 | -1): void => {
    if (busy) return
    const previous = current
    setCurrent(next)
    setBusy(true)
    void onRate(next)
      .then((ok) => {
        if (!ok) setCurrent(previous)
      })
      .finally(() => setBusy(false))
  }

  return (
    <>
      <IconButton
        aria-label="This answer was helpful"
        aria-pressed={current === 1}
        title="Helpful"
        size="xs"
        variant={current === 1 ? 'subtle' : 'ghost'}
        disabled={busy}
        onClick={() => rate(1)}
      >
        <ThumbsUp size={13} />
      </IconButton>
      <IconButton
        aria-label="This answer was not helpful"
        aria-pressed={current === -1}
        title="Not helpful"
        size="xs"
        variant={current === -1 ? 'subtle' : 'ghost'}
        disabled={busy}
        onClick={() => rate(-1)}
      >
        <ThumbsDown size={13} />
      </IconButton>
    </>
  )
}

/**
 * Copy menu for a single answer.
 *
 * The **Download .md** item is gone (§7.6). Worth knowing why rather than only that:
 * a script-driven `<a download>` is blocked in many embedded-iframe contexts, so for
 * portal readers — which is everyone here — this item may have been failing silently
 * the whole time. Copy works everywhere and is what people were reaching for.
 */
function AnswerActions({ message }: { message: ChatMessageView }) {
  const [copied, setCopied] = useState(false)

  const flashCopied = (ok: boolean): void => {
    if (!ok) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const markdown = answerToMarkdown(message)

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton aria-label="Copy or export this answer" size="xs" variant="ghost" title="Copy or export">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content>
            <Menu.Item
              value="copy-markdown"
              onSelect={() => void copyToClipboard(markdown).then(flashCopied)}
            >
              Copy as Markdown
            </Menu.Item>
            <Menu.Item
              value="copy-text"
              onSelect={() => void copyToClipboard(toPlainText(markdown)).then(flashCopied)}
            >
              Copy as plain text
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}

/** Compact multi-document scope selector, so scope can change without leaving the chat. */
function ScopeSelector({
  scopeDocuments,
  selectedIds,
  onToggleSelected,
}: {
  scopeDocuments: ScopeDocument[]
  selectedIds: string[]
  onToggleSelected: (documentId: string) => void
}) {
  const ready = scopeDocuments.filter((document) => document.ready)
  // Count only selections that are actually searchable, so the label can never read
  // "1 of 0" for a document whose indexing failed.
  const selectedReady = ready.filter((document) => selectedIds.includes(document.id)).length

  let label: string
  if (scopeDocuments.length === 0) {
    label = 'No documents yet'
  } else if (ready.length === 0) {
    label = 'No indexed documents'
  } else if (selectedReady === 0) {
    label = `All ${ready.length} ready ${ready.length === 1 ? 'document' : 'documents'}`
  } else {
    label = `${selectedReady} of ${ready.length} selected`
  }

  return (
    <Menu.Root closeOnSelect={false}>
      <Menu.Trigger asChild>
        <Button size="xs" variant="ghost" title="Choose which documents this chat searches">
          <FileText size={13} />
          {label}
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content maxH="60vh" overflowY="auto" minW="64">
            {ready.length === 0 && (
              <Box px="3" py="2">
                <Text fontSize="xs" color="fg.muted">
                  No indexed documents yet.
                </Text>
              </Box>
            )}
            {ready.map((document) => (
              <Menu.Item
                key={document.id}
                value={document.id}
                onSelect={() => onToggleSelected(document.id)}
              >
                <HStack gap="2" width="full">
                  <Box w="4" flexShrink="0" color="accent.fg">
                    {selectedIds.includes(document.id) ? <Check size={13} /> : null}
                  </Box>
                  <Text fontSize="xs" truncate>
                    {document.name}
                  </Text>
                </HStack>
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}

export function ChatPanel({
  messages,
  busy,
  lastRetrieval,
  notice,
  scopeDocuments,
  selectedIds,
  onToggleSelected,
  onSend,
  onCitationClick,
  onRateAnswer,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const [conversationCopied, setConversationCopied] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, busy])

  const submit = (): void => {
    const question = draft.trim()
    if (question.length === 0 || busy) return
    onSend(question)
    setDraft('')
  }

  const readyCount = scopeDocuments.filter((document) => document.ready).length
  const canAsk = readyCount > 0

  return (
    <Flex direction="column" h="full" overflow="hidden">
      {/* scope + mode */}
      <Flex
        align="center"
        justify="space-between"
        px="2"
        py="1.5"
        borderBottomWidth="1px"
        borderColor="border.default"
        gap="2"
        flexWrap="wrap"
      >
        <ScopeSelector
          scopeDocuments={scopeDocuments}
          selectedIds={selectedIds}
          onToggleSelected={onToggleSelected}
        />
      </Flex>

      <Stack flex="1" overflowY="auto" gap="4" px="3" py="3">
        {messages.length === 0 && !busy && (
          <Box textAlign="center" py="8" px="2">
            <Box color="fg.muted" display="flex" justifyContent="center" mb="2">
              <MessageSquare size={22} />
            </Box>
            <Text fontSize="sm" fontWeight="medium">
              Answers are grounded in your documents
            </Text>
            <Text fontSize="xs" color="fg.muted" mt="1">
              Every key statement is cited to an exact page — click a citation to jump there. If
              your documents do not contain the answer, Compass says so instead of guessing.
            </Text>
          </Box>
        )}

        {messages.map((message, index) => {
          if (message.role === 'user') {
            return (
              <Flex key={message.id ?? `user-${index}`} justify="flex-end">
                <Box
                  bg="bg.raised"
                  borderRadius="card"
                  px="3"
                  py="2"
                  maxW="88%"
                  borderWidth="1px"
                  borderColor="border.default"
                >
                  <Text fontSize="sm" whiteSpace="pre-wrap">
                    {message.content}
                  </Text>
                </Box>
              </Flex>
            )
          }

          const ungrounded = message.content.startsWith(NO_INFORMATION_PREFIX)

          return (
            <Box key={message.id ?? `assistant-${index}`}>
              <Box
                bg="bg.surface"
                borderWidth="1px"
                borderColor={ungrounded ? 'border.default' : 'accent.solid'}
                borderLeftWidth={ungrounded ? '1px' : '3px'}
                borderRadius="card"
                px="3"
                py="3"
              >
                {ungrounded ? (
                  <Text fontSize="sm" color="fg.muted">
                    {message.content}
                  </Text>
                ) : (
                  <AnswerBody
                    content={message.content}
                    citations={message.citations}
                    onCitationClick={onCitationClick}
                  />
                )}

                {message.truncated && (
                  <Text fontSize="xs" color="danger.fg" mt="2">
                    The answer reached the workspace answer-length limit and was cut off.
                  </Text>
                )}

                {message.citations.length > 0 && (
                  <Stack gap="2" mt="3" pt="3" borderTopWidth="1px" borderColor="border.default">
                    <Text
                      fontSize="xs"
                      fontWeight="semibold"
                      color="fg.muted"
                      textTransform="uppercase"
                      letterSpacing="wide"
                    >
                      Sources
                    </Text>
                    {message.citations.map((citation) => (
                      <CitationCard
                        key={citation.chunkId}
                        citation={citation}
                        onClick={onCitationClick}
                      />
                    ))}
                  </Stack>
                )}
              </Box>

              <HStack gap="1" mt="1" px="1">
                {/* Only for a persisted answer: a message still streaming has no id
                    yet, and a rating needs one to attach to. */}
                {onRateAnswer && message.id !== null && (
                  <AnswerRating
                    rating={message.rating ?? null}
                    onRate={(next) => onRateAnswer(message.id as string, next)}
                  />
                )}
                <AnswerActions message={message} />
                {typeof message.latencyMs === 'number' && (
                  <Text fontSize="xs" color="fg.muted">
                    {(message.latencyMs / 1000).toFixed(1)}s
                  </Text>
                )}
                {typeof message.inputTokens === 'number' &&
                  typeof message.outputTokens === 'number' && (
                    <Text fontSize="xs" color="fg.muted">
                      {message.inputTokens.toLocaleString()} in /{' '}
                      {message.outputTokens.toLocaleString()} out
                    </Text>
                  )}
              </HStack>
            </Box>
          )
        })}

        {busy && (
          <HStack color="fg.muted" fontSize="sm" px="1">
            <Spinner size="xs" color="accent.solid" />
            <Text>Retrieving passages and composing a cited answer…</Text>
          </HStack>
        )}

        <div ref={endRef} />
      </Stack>

      {notice && (
        <Box borderTopWidth="1px" borderColor="border.default" bg="bg.raised" px="3" py="2">
          <Text fontSize="xs" color="fg.muted">
            {notice}
          </Text>
        </Box>
      )}

      <Box borderTopWidth="1px" borderColor="border.default" px="3" py="2">
        <Flex gap="2" align="end">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            placeholder={
              canAsk ? 'Ask a question about your documents…' : 'Index a document first…'
            }
            rows={2}
            resize="none"
            size="sm"
            bg="bg.surface"
            disabled={busy || !canAsk}
            aria-label="Question"
          />
          {/* Quiet, per §5: "In the chat, the answer and its citations carry the
              colour, the input and controls stay quiet."

              This was a solid blue fill for about an hour — the loudest thing in the
              panel, sitting next to the answer it is supposed to defer to. Outlined
              in the accent instead: still unmistakably the send control, no longer
              competing with the content above it. */}
          <Button
            size="sm"
            variant="outline"
            color="accent.solid"
            borderColor="accent.solid"
            bg="transparent"
            _hover={{ bg: "accent.subtle" }}
            onClick={submit}
            disabled={busy || draft.trim().length === 0 || !canAsk}
            aria-label="Send question"
          >
            <Send size={15} />
          </Button>
        </Flex>

        <Flex justify="space-between" mt="1.5" gap="2" flexWrap="wrap" align="center">
          <Text fontSize="10px" color="fg.muted">
            Enter to send · Shift+Enter for a new line
          </Text>
          <HStack gap="2">
            {lastRetrieval && (
              <Text fontSize="10px" color="fg.muted">
                {lastRetrieval.usedCount}/{lastRetrieval.candidateCount} passages ·{' '}
                {lastRetrieval.contextTokens.toLocaleString()} tokens
              </Text>
            )}
            {/* Copy, not download (§7.6). The capability is kept rather than simply
                removed: someone was using it to paste a transcript somewhere, and the
                same `transcriptToMarkdown` output now goes to the clipboard. Dropping
                clipboard export as well is one line if that is preferred (§9.1). */}
            {messages.some((message) => message.role === 'assistant') && (
              <IconButton
                aria-label="Copy the whole conversation as Markdown"
                title={conversationCopied ? 'Copied' : 'Copy conversation'}
                size="xs"
                variant="ghost"
                onClick={() =>
                  void copyToClipboard(
                    transcriptToMarkdown(messages, 'Compass AI conversation'),
                  ).then((ok) => {
                    if (!ok) return
                    setConversationCopied(true)
                    window.setTimeout(() => setConversationCopied(false), 1500)
                  })
                }
              >
                {conversationCopied ? <Check size={13} /> : <ClipboardList size={13} />}
              </IconButton>
            )}
          </HStack>
        </Flex>
      </Box>
    </Flex>
  )
}
