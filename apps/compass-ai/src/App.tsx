/**
 * Compass AI — Phase 2 shell.
 *
 * Documents rail on the left, PDF viewer as the main surface, and the chat docked
 * bottom-right as a floating widget. Clicking a citation in an answer scrolls the
 * viewer to that document's page and highlights the cited paragraph.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Stack,
  Spinner,
  Text,
} from '@chakra-ui/react'
import { AlertTriangle, FileText, X } from 'lucide-react'
import { AuthExpiredModal } from '@/components/AuthExpiredModal'
import { ChatPanel, type ScopeDocument } from '@/components/ChatPanel'
import { ChatWidget } from '@/components/ChatWidget'
import { DocumentSidebar } from '@/components/DocumentSidebar'
import type { CitationTarget } from '@/components/PdfViewer'

import {
  ApiError,
  api,
  type ChatMessageView,
  type Citation,
  type DocumentSummary,
  type PortalLibrary,
  type RetrievalInfo,
  type Actor,
  type ClientRef,
} from '@/lib/client'

/**
 * PDF.js is ~600 kB of the bundle. Loading it lazily lets the shell, document list
 * and chat paint immediately; the viewer arrives a beat later, and only for users who
 * actually open a document.
 */
const PdfViewer = lazy(() =>
  import('@/components/PdfViewer').then((module) => ({ default: module.PdfViewer })),
)

/** Documents mid-ingestion are polled so status badges advance without a refresh. */
const ACTIVE_POLL_MS = 2500

/**
 * Where Compass Admin lives, derived from this app's own hostname at runtime.
 *
 * Never a baked constant: a bundle built with one environment's host and deployed
 * against another would point staff at the wrong organization's admin app, and that
 * is the exact class of bug the runtime-host rule exists to prevent. Both apps are
 * subdomains of the same platform host, so swapping the first label is the whole
 * derivation.
 *
 * Returns null when the hostname has no domain to build on — a bare `localhost`, or
 * anything unexpected. The ribbon then renders as plain text rather than as a link
 * to nowhere, because a dead link is worse than no link.
 */
function adminUrl(): string | null {
  if (typeof window === 'undefined') return null
  const { protocol, hostname } = window.location
  const labels = hostname.split('.')
  if (labels.length < 2) return null
  return `${protocol}//compass-admin.${labels.slice(1).join('.')}`
}

const ADMIN_URL = adminUrl()

export default function App() {
  const [booting, setBooting] = useState(true)
  const [authExpired, setAuthExpired] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  const [client, setClient] = useState<ClientRef | null>(null)
  const [portalError, setPortalError] = useState<{ code: string; message: string } | null>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  /** Identity, not permission: the staff ribbon is the only thing keyed on it. */
  const [actor, setActor] = useState<Actor | null>(null)

  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [libraries, setLibraries] = useState<PortalLibrary[]>([])
  const [portalId, setPortalId] = useState<string | null>(null)
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  /** The document open in the viewer. */
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null)
  const [citationTarget, setCitationTarget] = useState<CitationTarget | null>(null)

  const [chatId, setChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessageView[]>([])
  const [asking, setAsking] = useState(false)
  const [lastRetrieval, setLastRetrieval] = useState<RetrievalInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // One portal means one client; there is nothing to switch between.
  const clientId = client?.id ?? null

  const openDocument = useMemo(
    () => documents.find((document) => document.id === openDocumentId) ?? null,
    [documents, openDocumentId],
  )

  /**
   * Only a 401 means "not signed in". Anything else during boot is a transient or
   * server problem and must not be shown as an auth failure.
   */
  const handleError = useCallback((error: unknown, context: string) => {
    if (error instanceof ApiError && error.status === 401) {
      setAuthExpired(true)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    setBanner(`${context}: ${message}`)
  }, [])

  // --- boot ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false

    const boot = async (attempt = 1): Promise<void> => {
      try {
        const session = await api.session()
        if (cancelled) return
        setUserEmail(session.user.email)
        setActor(session.actor)
        setPortalId(session.portalId)
        setClient(session.client)
        setBooting(false)
      } catch (error) {
        if (cancelled) return
        if (error instanceof ApiError && error.code.startsWith('PORTAL_')) {
          // A portal problem is not an auth problem and not a server fault: show the
          // client-safe explanation the backend authored and stop.
          setPortalError({ code: error.code, message: error.message })
          setBooting(false)
          return
        }
        if (error instanceof ApiError && error.status === 401) {
          setAuthExpired(true)
          setBooting(false)
          return
        }
        if (error instanceof ApiError && error.code === 'FORBIDDEN_CLIENT_ROLE') {
          setPortalError({ code: error.code, message: error.message })
          setBooting(false)
          return
        }
        // A deploy rollout or cold start can 5xx briefly — retry before giving up.
        if (attempt < 3) {
          setTimeout(() => void boot(attempt + 1), attempt === 1 ? 600 : 1800)
          return
        }
        setFatalError(error instanceof Error ? error.message : 'Could not reach the server.')
        setBooting(false)
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  // --- documents ----------------------------------------------------------
  const refreshDocuments = useCallback(
    async (showSpinner = false) => {
      if (!clientId) return
      if (showSpinner) setDocumentsLoading(true)
      try {
        const response = await api.listDocuments()
        setDocuments(response.documents)

        // Folders are fetched with the documents rather than separately: a tree
        // rendered from a stale folder list puts documents under the wrong parent,
        // or silently drops them into Unfiled.
        const folderResponse = await api.listFolders().catch(() => null)
        if (folderResponse) setLibraries(folderResponse.libraries)
      } catch (error) {
        handleError(error, 'Could not load documents')
      } finally {
        if (showSpinner) setDocumentsLoading(false)
      }
    },
    [clientId, handleError],
  )

  useEffect(() => {
    setDocuments([])
    setLibraries([])
    setSelectedIds([])
    setOpenDocumentId(null)
    setCitationTarget(null)
    setChatId(null)
    setMessages([])
    setLastRetrieval(null)
    setNotice(null)
    if (clientId) void refreshDocuments(true)
  }, [clientId, refreshDocuments])

  // Poll only while something is actually being ingested.
  const hasActiveIngestion = useMemo(
    () => documents.some((document) => !['indexed', 'failed', 'deleted'].includes(document.status)),
    [documents],
  )

  useEffect(() => {
    if (!hasActiveIngestion) return
    const timer = setInterval(() => void refreshDocuments(), ACTIVE_POLL_MS)
    return () => clearInterval(timer)
  }, [hasActiveIngestion, refreshDocuments])

  /**
   * Open the first readable document automatically, so the viewer is never blank
   * when there is something to show.
   *
   * Readability is not the same as being indexed: a document whose indexing failed
   * (or is still running) is stored and can be read perfectly well. Only the chat's
   * search scope requires an index.
   */
  useEffect(() => {
    if (openDocumentId !== null) return
    const readable =
      documents.find((document) => document.status === 'indexed') ??
      documents.find((document) => document.status !== 'deleted')
    if (readable) setOpenDocumentId(readable.id)
  }, [documents, openDocumentId])

  // If the open document is deleted, fall back rather than showing a broken viewer.
  useEffect(() => {
    if (openDocumentId && !documents.some((document) => document.id === openDocumentId)) {
      setOpenDocumentId(null)
      setCitationTarget(null)
    }
  }, [documents, openDocumentId])

  // --- chat session restore ----------------------------------------------
  /**
   * Reopen the workspace's most recent conversation on load. Without this a refresh
   * silently loses the transcript even though the server still has it, and every
   * question would start a new chat row.
   */
  useEffect(() => {
    if (!clientId) return
    let cancelled = false

    void (async () => {
      try {
        const { chats } = await api.listChats()
        const latest = chats[0]
        if (!latest || cancelled) return

        const detail = await api.getChat(latest.id)
        if (cancelled) return

        setChatId(detail.chat.id)
        setMessages(detail.messages)
        // Restore the document scope, dropping anything no longer searchable — a
        // document whose index was since removed would otherwise sit in the scope
        // contributing nothing.
        const active = detail.documents
          .filter((document) => document.active && document.status === 'indexed')
          .map((document) => document.id)
        if (active.length > 0) setSelectedIds(active)
      } catch (error) {
        // A failed restore must not block the app; the user can still ask a question,
        // which creates a fresh chat.
        if (!cancelled && error instanceof ApiError && error.status === 401) setAuthExpired(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [clientId])

  // --- chat ---------------------------------------------------------------
  const ensureChat = useCallback(async (): Promise<string> => {
    if (chatId) return chatId
        const chat = await api.createChat(selectedIds)
    setChatId(chat.id)
    return chat.id
  }, [chatId, selectedIds])

  const send = useCallback(
    async (question: string) => {
      setAsking(true)
      setNotice(null)
      setMessages((current) => [
        ...current,
        { id: `local-${Date.now()}`, role: 'user', content: question, citations: [], grounded: null },
      ])
      try {
        const activeChatId = await ensureChat()
        const response = await api.ask(activeChatId, question, selectedIds)
        setMessages((current) => [...current, response.message])
        setLastRetrieval(response.retrieval)
        setNotice(response.notice ?? null)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setAuthExpired(true)
        } else {
          setBanner(error instanceof Error ? error.message : 'The question could not be answered.')
          // Drop the optimistic user turn so the transcript matches the server.
          setMessages((current) => current.slice(0, -1))
        }
      } finally {
        setAsking(false)
      }
    },
    [ensureChat, selectedIds],
  )

  const toggleSelected = useCallback((documentId: string) => {
    setSelectedIds((current) =>
      current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : [...current, documentId],
    )
  }, [])

  /**
   * Jump to a citation: open its document if it is not the one on screen, then hand
   * the viewer the page and paragraph. The nonce makes a repeat click re-trigger.
   */
  const goToCitation = useCallback(
    (citation: Citation) => {
      setOpenDocumentId(citation.documentId)
      setCitationTarget({
        documentId: citation.documentId,
        page: citation.page,
        paragraphKey: citation.paragraphKey,
        nonce: Date.now(),
      })
    },
    [],
  )

  const scopeDocuments = useMemo<ScopeDocument[]>(
    () =>
      documents.map((document) => ({
        id: document.id,
        name: document.name,
        ready: document.status === 'indexed',
      })),
    [documents],
  )

  const readyCount = documents.filter((document) => document.status === 'indexed').length

  const scopeLabel = useMemo(() => {
    if (selectedIds.length === 0) {
      return readyCount === 0
        ? 'No indexed documents yet'
        : `All ${readyCount} ready ${readyCount === 1 ? 'document' : 'documents'}`
    }
    if (selectedIds.length === 1) {
      const only = documents.find((document) => document.id === selectedIds[0])
      return only ? only.name : '1 document'
    }
    return `${selectedIds.length} documents selected`
  }, [selectedIds, readyCount, documents])

  // ---------------------------------------------------------------------------
  // Every hook must be above every conditional return, and this one was not.
  //
  // `rateAnswer` sat below the `portalError` / `booting` / `fatalError` returns. On
  // the first render `booting` is true, so the component returned early and this
  // `useCallback` never ran; when the session arrived and `booting` flipped, the
  // render reached it and called one more hook than the render before. That is React
  // error #310 — "rendered more hooks than during the previous render" — and React's
  // response is to unmount the tree, which is a white page.
  //
  // It is deterministic: it happened on every successful session, not intermittently.
  // The backend logged `portal.resolved` and then nothing at all, because there was
  // no app left to make the next request.
  // ---------------------------------------------------------------------------

  /**
   * Rate one answer (Phase 8 §3).
   *
   * Returns false rather than throwing so the control can revert its optimistic
   * state: a failed rating is a minor, local disappointment, and turning it into the
   * app's error banner would put a chat-panel hiccup where real failures go.
   *
   * The local message list is updated on success so the thumb survives a re-render
   * without a round trip — the server is still the truth, and the next chat load
   * re-reads it.
   */
  const rateAnswer = useCallback(
    async (messageId: string, rating: 1 | -1): Promise<boolean> => {
      if (!chatId) return false
      try {
        await api.rateAnswer(chatId, messageId, rating)
        setMessages((current) =>
          current.map((message) => (message.id === messageId ? { ...message, rating } : message)),
        )
        return true
      } catch {
        return false
      }
    },
    [chatId],
  )

  // A portal problem is neither an auth failure nor a server fault. The message is
  // the one the backend authored for clients: it names no ids, tables or providers.
  if (portalError) {
    return (
      <Flex h={['100vh', '100dvh']} minH="480px" align="center" justify="center" p="6">
        <Box
          maxW="md"
          borderWidth="1px"
          borderColor="border.default"
          bg="bg.surface"
          borderRadius="card"
          p="6"
        >
          <Stack gap="2" mb="2">
            {/* The wordmark (§2), swapped by colour mode rather than by two toggled
                <img> tags. Sized from the compact lockup's trimmed aspect, so the height is
                the mark's height and not the height of its padding. */}
            <Box
              role="img"
              aria-label="KIRIA Advisory Partners"
              css={{
                height: '20px',
                width: '55px',
                flexShrink: 0,
                backgroundImage: 'url(/brand/wordmark.png)',
                backgroundSize: 'contain',
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'left center',
                _dark: { backgroundImage: 'url(/brand/wordmark-white.png)' },
              }}
            />
            <Heading size="sm">Compass AI</Heading>
          </Stack>
          <Text fontSize="sm" color="fg.muted">
            {portalError.message}
          </Text>
        </Box>
      </Flex>
    )
  }

  if (authExpired) return <AuthExpiredModal />

  if (booting) {
    return (
      <Flex h={['100vh', '100dvh']} minH="480px" align="center" justify="center" direction="column" gap="3">
        <Spinner color="accent.solid" />
        <Text fontSize="sm" color="fg.muted">
          Starting Compass AI…
        </Text>
      </Flex>
    )
  }

  if (fatalError) {
    return (
      <Flex h={['100vh', '100dvh']} minH="480px" align="center" justify="center" p="6">
        <Box
          maxW="md"
          borderWidth="1px"
          borderColor="border.default"
          bg="bg.surface"
          borderRadius="card"
          p="6"
        >
          <HStack gap="2" mb="2" color="danger.fg">
            <AlertTriangle size={18} />
            <Heading size="sm">Can’t reach the server</Heading>
          </HStack>
          <Text fontSize="sm" color="fg.muted">
            {fatalError}
          </Text>
          <Button mt="4" size="sm" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </Box>
      </Flex>
    )
  }


  return (
    <Flex direction="column" h={['100vh', '100dvh']} minH="480px" overflow="hidden">
      <Flex
        as="header"
        align="center"
        justify="space-between"
        px="5"
        py="3"
        borderBottomWidth="1px"
        borderColor="border.default"
        bg="bg.surface"
        gap="4"
        flexShrink="0"
      >
        <HStack gap="2" minW="0">
          {/* §2: "Header uses the light (blue) wordmark on light surfaces". This was
              still the generic lucide compass — the one client-facing header in the
              product, and the only one the rebrand had not reached. */}
          <Box
            role="img"
            aria-label="KIRIA Advisory Partners"
            css={{
              height: '22px',
              width: '60px',
              flexShrink: 0,
              backgroundImage: 'url(/brand/wordmark.png)',
              backgroundSize: 'contain',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'left center',
              _dark: { backgroundImage: 'url(/brand/wordmark-white.png)' },
            }}
          />
          <Heading size="md" whiteSpace="nowrap">
            Compass AI
          </Heading>
          <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">
            {readyCount} of {documents.length} documents ready
          </Text>
        </HStack>

        <HStack gap="2" minW="0">
          {client && (
            <Badge size="sm" variant="subtle">
              {client.name}
            </Badge>
          )}
          {userEmail && (
            <Text fontSize="xs" color="fg.muted" display={{ base: 'none', md: 'block' }}>
              {userEmail}
            </Text>
          )}
          {/* The staff ribbon (§5C).
              This app configures nothing any more, for anyone — so a staff member
              arriving here to fix something needs to be told where the controls went
              rather than left hunting for buttons that no longer exist. Keyed on
              `actor`, which is identity rather than permission: a client sees no
              ribbon because there is nothing there for them. */}
          {actor === 'employee' &&
            (ADMIN_URL ? (
              <Text asChild fontSize="xs" color="accent.solid" whiteSpace="nowrap">
                <a href={ADMIN_URL} target="_blank" rel="noreferrer">
                  Manage in Compass Admin →
                </a>
              </Text>
            ) : (
              <Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">
                Manage in Compass Admin
              </Text>
            ))}
        </HStack>
      </Flex>

      {banner && (
        <Flex
          align="center"
          justify="space-between"
          bg="red.50"
          _dark={{ bg: 'red.950' }}
          borderBottomWidth="1px"
          borderColor="border.default"
          px="5"
          py="2"
          gap="3"
          flexShrink="0"
        >
          <Text fontSize="sm" color="red.600" _dark={{ color: 'red.300' }}>
            {banner}
          </Text>
          <Button size="xs" variant="ghost" onClick={() => setBanner(null)} aria-label="Dismiss">
            <X size={14} />
          </Button>
        </Flex>
      )}

      <Flex flex="1" overflow="hidden">
        {/* documents rail: the folder tree. Nothing above it any more — upload,
            delete and re-index moved to Compass Admin (§5C). */}
        {portalId ? (
          <Flex direction="column" flexShrink="0" bg="bg.surface" overflow="hidden">
            <Box flex="1" overflow="hidden">
              <DocumentSidebar
                portalId={portalId}
                libraries={libraries}
                documents={documents}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                activeDocumentId={openDocumentId}
                loading={documentsLoading}
                onOpenDocument={(documentId) => {
                  setOpenDocumentId(documentId)
                  setCitationTarget(null)
                }}
              />
            </Box>
          </Flex>
        ) : null}

        {/* viewer */}
        <Box flex="1" overflow="hidden" bg="bg.canvas">
          {openDocument ? (
            <Suspense
              fallback={
                <Flex direction="column" align="center" justify="center" h="full" gap="3">
                  <Spinner color="accent.solid" />
                  <Text fontSize="sm" color="fg.muted">
                    Loading the viewer…
                  </Text>
                </Flex>
              }
            >
              <PdfViewer
                key={openDocument.id}
                documentId={openDocument.id}
                documentName={openDocument.name}
                target={citationTarget}
                portalId={portalId ?? 'unknown'}
              />
            </Suspense>
          ) : (
            /* Phase 9 §4: "empty and error states are where a product feels cheap or
               considered". Two different empty states share this slot and they are not
               the same thing, so they no longer read the same way:

                 * nothing shared yet — the client has arrived somewhere that is not
                   ready. This one carries the mark and says who is doing something
                   about it, because the honest content of the screen is "we are
                   working on it", not "there is nothing here".
                 * nothing open — the client is one click from a document. That is an
                   instruction, and dressing it up would be noise. */
            <Flex direction="column" align="center" justify="center" h="full" p="8" gap="3">
              {documents.length === 0 ? (
                <>
                  {/* The real wordmark now, where a type-set "KIRIA" stood in while
                      the asset was missing. Larger than the header's, because this is
                      the one screen whose entire content is "we are working on it" and
                      the mark is most of the reassurance. */}
                  <Box
                    role="img"
                    aria-label="KIRIA Advisory Partners"
                    css={{
                      height: '52px',
                      width: '142px',
                      flexShrink: 0,
                      backgroundImage: 'url(/brand/wordmark.png)',
                      backgroundSize: 'contain',
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'center',
                      _dark: { backgroundImage: 'url(/brand/wordmark-white.png)' },
                    }}
                  />
                  <Text fontSize="md" fontWeight="bold" textAlign="center">
                    Nothing here yet
                  </Text>
                  <Text fontSize="sm" color="fg.muted" maxW="sm" textAlign="center" lineHeight="1.6">
                    {/* Not "no documents have been shared with this portal" — that is
                        the database's view of the situation. A person is preparing
                        them, and saying so is both truer and the thing the reader
                        wants to know. Nobody can upload from here (§5C), so an
                        instruction would be one the reader cannot follow. */}
                    Your KIRIA team is preparing your material. It will appear here as
                    soon as it is ready.
                  </Text>
                </>
              ) : (
                <>
                  <Box color="fg.muted">
                    <FileText size={26} />
                  </Box>
                  <Text fontSize="sm" fontWeight="medium">
                    No document open
                  </Text>
                  <Text fontSize="xs" color="fg.muted" maxW="sm" textAlign="center">
                    Pick a document on the left to open it. Citations in an answer will
                    bring you straight to the right page.
                  </Text>
                </>
              )}
            </Flex>
          )}
        </Box>

        {/* The chat, as the row's third column when there is room for one (§7.3).
            Inside the row rather than fixed over it: that is what makes the viewer's
            ResizeObserver see the space it takes and re-fit the page. Collapsed it
            renders as the bottom-right pill, and below 1024px as a bottom sheet —
            both still `position: fixed`, which is correct for something that is
            genuinely floating. */}
        <ChatWidget scopeLabel={scopeLabel}>
          <ChatPanel
            onRateAnswer={rateAnswer}
            messages={messages}
            busy={asking}
            lastRetrieval={lastRetrieval}
            notice={notice}
            scopeDocuments={scopeDocuments}
            selectedIds={selectedIds}
            onToggleSelected={toggleSelected}
            onSend={(question) => void send(question)}
            onCitationClick={goToCitation}
          />
        </ChatWidget>
      </Flex>

    </Flex>
  )
}
