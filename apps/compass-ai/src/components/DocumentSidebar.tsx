/**
 * Libraries, folder trees and documents, left of the viewer (§8.1 and §6A.2).
 *
 * Four decisions shape this component:
 *
 * 0. **A library is a node, not a grouping.** Each library the portal receives is a
 *    top-level row carrying its own tree, and its documents with no folder sit under
 *    an "Unfiled" child of that library — not in one bucket at the bottom of the
 *    sidebar, which is what Phase 5 did and what §2 corrects. Two libraries may each
 *    contain a folder called *Compass*, so the library name is the disambiguator and
 *    is never collapsed away, even when a portal receives exactly one.
 *
 * 1. **Selection is one control, not two.** The checkboxes that decide what the chat
 *    searches are the same ones that show what is selected here, so "what I see" and
 *    "what the chat answers from" can never disagree. §8.1 asks for this explicitly,
 *    and it is the difference between a scope the user trusts and one they have to
 *    verify twice.
 *
 * 2. **Persistence is best-effort.** Collapse state and width are per portal in
 *    localStorage, every access wrapped, and a failure falls back to expanded at the
 *    default width. A private window or blocked site data must not stop the sidebar
 *    rendering.
 *
 * 3. **Under 900px it is an overlay drawer, closed by default.** On a narrow screen
 *    a persistent 240px rail would leave nothing for the document itself.
 *
 * Folder editing is absent for EVERY actor, not just clients. Organising the tree is
 * an admin responsibility, so it lives in Compass Admin and this component only ever
 * renders the tree. A drag-to-reorder interaction was built here and then removed for
 * that reason — two places that can reorder the same tree is one more than the number
 * of places that should.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, HStack, Input, Stack, Text } from '@chakra-ui/react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  Library as LibraryIcon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { PlainButton } from '@/components/ui/PlainButton'
import type { DocumentSummary, FolderNode, PortalLibrary } from '@/lib/client'

const MIN_WIDTH = 240
const MAX_WIDTH = 420
const DEFAULT_WIDTH = 288
/** Below this the sidebar becomes an overlay drawer rather than a column. */
const DRAWER_BREAKPOINT = 900

interface StoredState {
  collapsed: boolean
  width: number
}

/**
 * Read persisted sidebar state.
 *
 * Returns the default on any failure — a thrown localStorage (private windows,
 * blocked site data, thumbnail capture) must never prevent a render.
 */
function readStored(portalId: string): StoredState {
  const fallback: StoredState = { collapsed: false, width: DEFAULT_WIDTH }
  try {
    const raw = window.localStorage.getItem(`compass:sidebar:${portalId}`)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const state = parsed as Partial<StoredState>
    return {
      collapsed: state.collapsed === true,
      width:
        typeof state.width === 'number' && state.width >= MIN_WIDTH && state.width <= MAX_WIDTH
          ? state.width
          : DEFAULT_WIDTH,
    }
  } catch {
    return fallback
  }
}

function writeStored(portalId: string, state: StoredState): void {
  try {
    window.localStorage.setItem(`compass:sidebar:${portalId}`, JSON.stringify(state))
  } catch {
    // A preference that cannot be saved is not worth surfacing to the user.
  }
}

/** Status dot colour. Three states, because a client only needs three. */
function statusTone(document: DocumentSummary): { color: string; label: string } {
  if (document.status === 'indexed') return { color: 'ok.fg', label: 'Ready' }
  // 'orphaned' went with `sync_status` in 0019: it meant "the source row this
  // document came from has vanished", and there are no sources left to vanish — a
  // library cannot disappear from under its documents, because `library_id` is
  // ON DELETE RESTRICT.
  if (document.status === 'failed') return { color: 'danger.fg', label: 'Unavailable' }
  return { color: 'fg.muted', label: 'Preparing' }
}

interface TreeFolder extends FolderNode {
  children: TreeFolder[]
  documents: DocumentSummary[]
}

/**
 * A library and everything under it: its folder tree, plus the documents it holds
 * that are in no folder.
 *
 * The library is a node in its own right, which is the whole shape of §2. Grouping
 * only when there is more than one library would read as tidier and is wrong: two
 * libraries may each contain a folder called *Compass*, and a viewer who learns to
 * read the tree without the library name in the single-library case has learned to
 * read it wrong.
 */
interface TreeLibrary {
  id: string
  name: string
  roots: TreeFolder[]
  unfiled: DocumentSummary[]
  /** Kept so an empty library can say why it is empty rather than just look broken. */
  total: number
  /**
   * True for the one synthetic node that holds documents belonging to no library in
   * this response. Not a library, and it says so.
   */
  orphaned?: boolean
}

/**
 * Build one tree per library, then prune each to what matches the search.
 *
 * A folder survives when its own name matches or any descendant does, so searching
 * for a document never hides the path that leads to it. A library survives when
 * anything under it survives, or when its own name matches — searching for the
 * library name is a reasonable way to ask for everything in it.
 *
 * Documents are placed by `libraryId`, not by walking the folders: a document with
 * `folderId: null` has no folder to be found through, and it is exactly the Unfiled
 * case that must not go missing. A document whose library is not in the list (a stale
 * fetch, or a binding removed between the two requests) is dropped rather than
 * guessed at — the alternative is showing a file under a library that does not
 * provide it.
 */
function buildLibraryTrees(
  libraries: PortalLibrary[],
  documents: DocumentSummary[],
  search: string,
): TreeLibrary[] {
  const term = search.trim().toLowerCase()
  const matchesDocument = (document: DocumentSummary): boolean =>
    term.length === 0 || document.name.toLowerCase().includes(term)

  const known = new Set(libraries.map((library) => library.id))
  const documentsByLibrary = new Map<string, DocumentSummary[]>()
  /**
   * Documents this response cannot place under any library.
   *
   * Collected rather than skipped. Grouping by library means every document needs a
   * group, and "no group" silently resolving to "not shown" is how this codebase has
   * lost documents twice: a Phase 4 upload with no `source_id` was indexed, paid for
   * and visible nowhere, and the Phase 5 staff query hid every library document by
   * filtering on the tenancy column. Both looked fine.
   *
   * It should stay empty. A client's documents all arrive through a binding, and
   * §6.5 moved every tenant-owned row into a library. The reachable cases are a
   * document still carrying a `client_id` from before that migration, and a library
   * unticked between the document fetch and the folder fetch. Neither should make a
   * file disappear from the only list a viewer has.
   */
  const unplaced: DocumentSummary[] = []
  for (const document of documents) {
    if (document.libraryId === null || !known.has(document.libraryId)) {
      unplaced.push(document)
      continue
    }
    const bucket = documentsByLibrary.get(document.libraryId)
    if (bucket) bucket.push(document)
    else documentsByLibrary.set(document.libraryId, [document])
  }

  const sortNodes = (nodes: TreeFolder[]): void => {
    nodes.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    for (const node of nodes) sortNodes(node.children)
  }

  // Prune bottom-up: keep a folder when it matches by name, holds a matching
  // document, or has a surviving child.
  const prune = (nodes: TreeFolder[]): TreeFolder[] =>
    nodes
      .map((node) => ({ ...node, children: prune(node.children) }))
      .filter(
        (node) =>
          term.length === 0 ||
          node.name.toLowerCase().includes(term) ||
          node.documents.length > 0 ||
          node.children.length > 0,
      )

  const built: TreeLibrary[] = []

  for (const library of libraries) {
    const own = documentsByLibrary.get(library.id) ?? []
    const libraryMatches = term.length === 0 || library.name.toLowerCase().includes(term)
    const keep = (document: DocumentSummary): boolean =>
      libraryMatches || matchesDocument(document)

    const byId = new Map<string, TreeFolder>()
    for (const folder of library.folders) {
      byId.set(folder.id, { ...folder, children: [], documents: [] })
    }

    for (const document of own) {
      if (!keep(document)) continue
      const node = document.folderId ? byId.get(document.folderId) : undefined
      if (node) node.documents.push(document)
    }

    const roots: TreeFolder[] = []
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    sortNodes(roots)

    const unfiled = own.filter((document) => document.folderId === null && keep(document))
    const prunedRoots = libraryMatches ? roots : prune(roots)

    if (!libraryMatches && prunedRoots.length === 0 && unfiled.length === 0) continue
    built.push({
      id: library.id,
      name: library.name,
      roots: prunedRoots,
      unfiled,
      total: own.length,
    })
  }

  const unplacedMatching = unplaced.filter(matchesDocument)
  if (unplacedMatching.length > 0) {
    built.push({
      id: '__unplaced__',
      name: 'Not in a library',
      roots: [],
      unfiled: unplacedMatching,
      total: unplaced.length,
      orphaned: true,
    })
  }

  return built
}

export interface DocumentSidebarProps {
  portalId: string
  /** The libraries this portal receives, each with its own tree (§6A.2). */
  libraries: PortalLibrary[]
  documents: DocumentSummary[]
  /** Documents the chat currently searches. */
  selectedIds: string[]
  onSelectionChange: (ids: string[]) => void
  /** Document open in the viewer, highlighted in the tree. */
  activeDocumentId: string | null
  onOpenDocument: (documentId: string) => void
  /** First load in progress: distinguishes "nothing yet" from "nothing at all". */
  loading?: boolean
  /**
   * Per-document employee actions.
   *
   * Omitted entirely for a client, so nothing renders (§8.2). They live here rather
   * than only in the admin app because that app is Phase 4C — dropping them now would
   * leave no way to delete or re-index a document in the meantime.
   */
  canDelete?: boolean
  canReindex?: boolean
  onDeleteDocument?: (document: DocumentSummary) => void
  onReindexDocument?: (document: DocumentSummary) => void
}

export function DocumentSidebar({
  portalId,
  libraries,
  documents,
  selectedIds,
  onSelectionChange,
  activeDocumentId,
  onOpenDocument,
  loading = false,
  canDelete = false,
  canReindex = false,
  onDeleteDocument,
  onReindexDocument,
}: DocumentSidebarProps): React.ReactElement {
  const [stored, setStored] = useState<StoredState>(() => readStored(portalId))
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /**
   * Libraries a viewer has collapsed, rather than the ones they have opened.
   *
   * Stored as the negative on purpose: a library starts open. Collapsed-by-default
   * would mean a viewer with one library sees a single closed row and no documents,
   * which looks like an empty portal.
   */
  const [collapsedLibraries, setCollapsedLibraries] = useState<Set<string>>(new Set())
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < DRAWER_BREAKPOINT,
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const dragging = useRef(false)

  // Re-read when the portal changes: preferences are per portal, and a viewer who
  // moves between two portals should not inherit the other's layout.
  useEffect(() => {
    setStored(readStored(portalId))
  }, [portalId])

  const persist = useCallback(
    (next: StoredState) => {
      setStored(next)
      writeStored(portalId, next)
    },
    [portalId],
  )

  useEffect(() => {
    const onResize = (): void => setIsNarrow(window.innerWidth < DRAWER_BREAKPOINT)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Ctrl/Cmd+B. Bound on window rather than the sidebar so it works wherever focus
  // is, which is the point of a global shortcut.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      if (isNarrow) setDrawerOpen((open) => !open)
      else persist({ ...stored, collapsed: !stored.collapsed })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isNarrow, persist, stored])

  // Drag-to-resize. Listeners live on window for the duration of the drag so the
  // pointer can leave the handle without the resize sticking.
  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!dragging.current) return
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, event.clientX))
      setStored((current) => ({ ...current, width }))
    }
    const onUp = (): void => {
      if (!dragging.current) return
      dragging.current = false
      // Persist once at the end rather than on every mousemove.
      setStored((current) => {
        writeStored(portalId, current)
        return current
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [portalId])

  const trees = useMemo(
    () => buildLibraryTrees(libraries, documents, search),
    [libraries, documents, search],
  )

  // While searching, show every surviving branch: a collapsed folder hiding a match
  // makes the search look broken.
  const searching = search.trim().length > 0
  const isExpanded = (folderId: string): boolean => searching || expanded.has(folderId)

  const toggleLibrary = (libraryId: string): void => {
    setCollapsedLibraries((current) => {
      const next = new Set(current)
      if (next.has(libraryId)) next.delete(libraryId)
      else next.add(libraryId)
      return next
    })
  }

  const toggleFolder = (folderId: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  const toggleDocument = (documentId: string): void => {
    const next = new Set(selected)
    if (next.has(documentId)) next.delete(documentId)
    else next.add(documentId)
    onSelectionChange([...next])
  }

  const renderDocument = (document: DocumentSummary, indent: number): React.ReactElement => {
    const tone = statusTone(document)
    const isActive = document.id === activeDocumentId

    return (
      <HStack
        key={document.id}
        role="treeitem"
        aria-selected={isActive}
        gap="2"
        pl={`${indent * 16 + 8}px`}
        pr="2"
        py="1.5"
        borderRadius="md"
        // The open document, marked the way an active nav item is marked (§1). In
        // the reading view this is the one row that should be findable without
        // reading, because the reader's attention is on the page beside it.
        bg={isActive ? 'accent.subtle' : undefined}
        color={isActive ? 'accent.onSubtle' : undefined}
        _hover={{ bg: 'bg.subtle' }}
      >
        <input
          type="checkbox"
          checked={selected.has(document.id)}
          onChange={() => toggleDocument(document.id)}
          aria-label={`Include ${document.name} in chat`}
        />
        <Box
          w="2"
          h="2"
          borderRadius="full"
          bg={tone.color}
          flexShrink={0}
          title={tone.label}
          aria-label={tone.label}
        />
        <PlainButton
          onClick={() => onOpenDocument(document.id)}
          aria-label={`Open ${document.name} in the viewer`}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            font: 'inherit',
          }}
        >
          <Text
            fontSize="sm"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            fontWeight={isActive ? 'semibold' : 'normal'}
          >
            {document.name}
          </Text>
        </PlainButton>

        {canReindex && onReindexDocument ? (
          <PlainButton
            onClick={() => onReindexDocument(document)}
            aria-label={`Re-index ${document.name}`}
            title="Re-index"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 2,
              display: 'flex',
            }}
          >
            <RefreshCw size={13} />
          </PlainButton>
        ) : null}

        {canDelete && onDeleteDocument ? (
          <PlainButton
            onClick={() => onDeleteDocument(document)}
            aria-label={`Delete ${document.name}`}
            title="Delete"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 2,
              display: 'flex',
            }}
          >
            <Trash2 size={13} />
          </PlainButton>
        ) : null}
      </HStack>
    )
  }

  const renderFolder = (folder: TreeFolder, indent: number): React.ReactElement => {
    const open = isExpanded(folder.id)
    return (
      <Box key={folder.id} role="none">
        <HStack
          role="treeitem"
          aria-expanded={open}
          gap="1"
          pl={`${indent * 16}px`}
          py="1.5"
          borderRadius="md"
          _hover={{ bg: 'bg.subtle' }}
        >
          <PlainButton
            onClick={() => toggleFolder(folder.id)}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              font: 'inherit',
              padding: '0 4px',
            }}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <FolderIcon size={14} />
            <Text fontSize="sm" fontWeight="medium">
              {folder.name}
            </Text>
          </PlainButton>
        </HStack>

        {open ? (
          <Box role="group">
            {folder.children.map((child) => renderFolder(child, indent + 1))}
            {folder.documents.map((document) => renderDocument(document, indent + 1))}
          </Box>
        ) : null}
      </Box>
    )
  }

  /**
   * One library: its own row, then its tree, then its Unfiled documents.
   *
   * Unfiled sits INSIDE the library rather than at the bottom of the sidebar, which
   * is the correction §2 makes to Phase 5. A portal-level Unfiled bucket cannot say
   * which library a loose file came from, and with two libraries that is the one
   * question the viewer has.
   */
  const renderLibrary = (library: TreeLibrary): React.ReactElement => {
    const open = searching || !collapsedLibraries.has(library.id)
    return (
      <Box key={library.id} role="none" mb="1">
        <HStack role="treeitem" aria-expanded={open} py="1.5" borderRadius="md" _hover={{ bg: 'bg.subtle' }}>
          <PlainButton
            onClick={() => toggleLibrary(library.id)}
            aria-label={
              library.orphaned
                ? `${open ? 'Collapse' : 'Expand'} documents that are not in a library`
                : `${open ? 'Collapse' : 'Expand'} the library ${library.name}`
            }
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              font: 'inherit',
              padding: '0 4px',
              textAlign: 'left',
              minWidth: 0,
            }}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {library.orphaned ? <FileText size={14} /> : <LibraryIcon size={14} />}
            <Text fontSize="sm" fontWeight="semibold" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
              {library.name}
            </Text>
          </PlainButton>
        </HStack>

        {open ? (
          <Box role="group">
            {library.roots.map((folder) => renderFolder(folder, 1))}

            {library.unfiled.length > 0 ? (
              <Box role="none">
                {/* "Unfiled" is a label, not a folder — there is no row behind it, so
                    it cannot be renamed, moved or deleted. */}
                <Text pl="16px" px="2" py="1" fontSize="xs" color="fg.muted" textTransform="uppercase">
                  Unfiled
                </Text>
                {library.unfiled.map((document) => renderDocument(document, 1))}
              </Box>
            ) : null}

            {library.roots.length === 0 && library.unfiled.length === 0 ? (
              <Text pl="24px" py="1.5" fontSize="sm" color="fg.muted">
                {library.total > 0 ? 'No documents match that search.' : 'No documents yet.'}
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  }

  const body = (
    <Stack gap="2" h="100%" overflow="hidden">
      <HStack px="2" pt="2" gap="2">
        <Search size={14} aria-hidden />
        <Input
          size="sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search documents"
          aria-label="Search documents and folders"
        />
      </HStack>

      <Box role="tree" aria-label="Documents" overflowY="auto" px="1" pb="2" flex="1">
        {trees.map((library) => renderLibrary(library))}

        {trees.length === 0 ? (
          <Text px="3" py="4" fontSize="sm" color="fg.muted">
            {loading
              ? 'Loading documents…'
              : searching
                ? 'No documents match that search.'
                : 'No documents yet.'}
          </Text>
        ) : null}
      </Box>
    </Stack>
  )

  if (isNarrow) {
    return (
      <>
        <PlainButton
          onClick={() => setDrawerOpen(true)}
          aria-label="Open the document list"
          aria-expanded={drawerOpen}
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            cursor: 'pointer',
          }}
        >
          <PanelLeftOpen size={16} />
        </PlainButton>

        {drawerOpen ? (
          <>
            <Box
              position="fixed"
              inset="0"
              bg="blackAlpha.500"
              zIndex={30}
              onClick={() => setDrawerOpen(false)}
            />
            <Box
              position="fixed"
              top="0"
              left="0"
              bottom="0"
              w={`${stored.width}px`}
              maxW="85vw"
              bg="bg.panel"
              borderRightWidth="1px"
              zIndex={31}
            >
              <HStack justify="flex-end" p="2">
                <PlainButton
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close the document list"
                  style={{ cursor: 'pointer', padding: 4 }}
                >
                  <PanelLeftClose size={16} />
                </PlainButton>
              </HStack>
              {body}
            </Box>
          </>
        ) : null}
      </>
    )
  }

  if (stored.collapsed) {
    return (
      <Flex
        direction="column"
        align="center"
        w="44px"
        borderRightWidth="1px"
        py="2"
        flexShrink={0}
      >
        <PlainButton
          onClick={() => persist({ ...stored, collapsed: false })}
          aria-label="Expand the document list"
          aria-expanded={false}
          style={{ cursor: 'pointer', padding: 6 }}
        >
          <PanelLeftOpen size={16} />
        </PlainButton>
        <Box mt="3" aria-hidden>
          <FileText size={16} />
        </Box>
      </Flex>
    )
  }

  return (
    <Flex position="relative" flexShrink={0}>
      <Flex direction="column" w={`${stored.width}px`} borderRightWidth="1px" h="100%">
        <HStack justify="space-between" px="2" pt="2">
          <Text fontSize="xs" color="fg.muted" textTransform="uppercase">
            Documents
          </Text>
          <PlainButton
            onClick={() => persist({ ...stored, collapsed: true })}
            aria-label="Collapse the document list"
            aria-expanded
            style={{ cursor: 'pointer', padding: 4 }}
          >
            <PanelLeftClose size={16} />
          </PlainButton>
        </HStack>
        {body}
      </Flex>

      {/* Drag handle. `separator` with an orientation and value range is what makes a
          resizer legible to a screen reader, and the keyboard arrows below mean the
          width is adjustable without a pointer at all. */}
      <Box
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the document list"
        aria-valuenow={stored.width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onMouseDown={() => {
          dragging.current = true
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 32 : 8
          if (event.key === 'ArrowLeft') {
            persist({ ...stored, width: Math.max(MIN_WIDTH, stored.width - step) })
          } else if (event.key === 'ArrowRight') {
            persist({ ...stored, width: Math.min(MAX_WIDTH, stored.width + step) })
          }
        }}
        w="4px"
        cursor="col-resize"
        _hover={{ bg: 'border.emphasized' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'blue.500' }}
      />
    </Flex>
  )
}
