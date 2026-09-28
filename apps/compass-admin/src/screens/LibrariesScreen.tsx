/**
 * Libraries — §5B.6.
 *
 * Upload a set of PDFs once, then tick which portals receive it. One copy, one
 * embedding cost, many portals.
 *
 * The list's most important column is **"goes to"**: a library is the permission
 * surface of this product, and "who has this" must be answerable without a click.
 * The detail view is where files and ticks are managed, and every tick writes
 * immediately — no save button — because that is what makes untick trustworthy: one
 * decision, one row, one audit entry, rather than a diff between two submissions.
 *
 * Deleting is deliberately hard and archiving is deliberately easy. Archiving hides
 * a library from pickers and revokes nothing; deleting is refused by the backend
 * while any portal is ticked or any document remains, and the refusal names them.
 * A viewer's document list emptying silently is the worst failure this app can
 * produce, so it is not something one click may cause.
 *
 * §6A.1 folded the Documents screen into the detail view here. That screen was
 * client-scoped, which stopped meaning anything once every document belonged to a
 * library, and keeping it as a second place to see the same rows would have meant two
 * answers to "where does this file live". What came across is what was actually used:
 * the folder tree, the per-document folder picker, re-index, and version history.
 */

import { useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { Archive, ArrowLeft, History, Library, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react'
import {
  api,
  type FolderRow,
  type LibraryDocument,
  type LibraryRow,
  type PortalRef,
} from '@/lib/client'
import {
  AsyncState,
  Button,
  Cell,
  Panel,
  Pill,
  Table,
  useLoader,
} from '@/components/primitives'
import { DocumentUploadPanel } from '@/components/DocumentUploadPanel'
import { FolderTreePanel } from '@/components/FolderTreePanel'
import { PlainInput, PlainSelect } from '@/components/ui/native'

/** Folder id → "A / B / C", so a flat table can still show where a document sits. */
function buildPaths(folders: FolderRow[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const paths = new Map<string, string>()

  const resolve = (folder: FolderRow): string => {
    const cached = paths.get(folder.id)
    if (cached) return cached
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined
    const path = parent ? `${resolve(parent)} / ${folder.name}` : folder.name
    paths.set(folder.id, path)
    return path
  }

  for (const folder of folders) resolve(folder)
  return paths
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function LibrariesScreen({ portals }: { portals: PortalRef[] }): React.ReactElement {
  const { data, loading, error, reload } = useLoader(() => api.libraries(), [])
  const [openId, setOpenId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const libraries = data?.libraries ?? []
  const open = libraries.find((library) => library.id === openId) ?? null

  const act = async (run: () => Promise<unknown>): Promise<void> => {
    setActionError(null)
    setBusy(true)
    try {
      await run()
      reload()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const create = (): void => {
    const name = newName.trim()
    if (name.length === 0) return
    void act(async () => {
      await api.createLibrary(name)
      setNewName('')
    })
  }

  const remove = (library: LibraryRow): void => {
    // The confirmation is about the shape of the loss, not just the name: a library
    // holds work that cost real money to embed. The backend refuses this outright
    // while anything is ticked or held, so this dialog is the second line, not the
    // only one.
    const confirmed = window.confirm(
      `Delete the library "${library.name}"?\n\n` +
        'Only an unused library can be deleted: no portal receiving it, no documents, ' +
        'and nothing it has already cost to index — that cost history is kept ' +
        'deliberately, so a library that has been used can be archived but never ' +
        'deleted.\n\n' +
        'Archiving is almost always what you want: it disappears from every picker ' +
        'and stops being offered, while every portal that already has it keeps it.',
    )
    if (!confirmed) return
    void act(async () => {
      await api.deleteLibrary(library.id)
      if (openId === library.id) setOpenId(null)
    })
  }

  if (open) {
    return (
      <LibraryDetail
        library={open}
        portals={portals}
        onBack={() => setOpenId(null)}
        onChanged={reload}
      />
    )
  }

  return (
    <Stack gap="4">
      {actionError ? (
        <Box borderWidth="1px" borderColor="red.400" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm" color="red.500">
            {actionError}
          </Text>
        </Box>
      ) : null}

      <Panel title="New library">
        <HStack p="4" gap="2">
          <PlainInput
            value={newName}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setNewName(event.target.value)
            }
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') create()
            }}
            placeholder="Name, e.g. Onboarding pack"
            aria-label="Name for the new library"
            borderWidth="1px"
            borderRadius="md"
            px="2"
            py="1"
            fontSize="sm"
            bg="bg.canvas"
            flex="1"
            maxW="360px"
          />
          <Button
            variant="primary"
            onClick={create}
            disabled={busy || newName.trim().length === 0}
            label="Create this library"
          >
            <HStack gap="1">
              <Plus size={13} />
              <Text>Create</Text>
            </HStack>
          </Button>
        </HStack>
      </Panel>

      <Panel title={`Libraries (${libraries.length})`}>
        <AsyncState
          loading={loading}
          error={error}
          empty={libraries.length === 0}
          emptyMessage="No libraries yet. Create one above, upload PDFs into it, then tick the portals that should receive it."
        >
          <Table headers={['Library', 'Documents', 'Pages', 'Goes to', '']}>
            {libraries.map((library) => (
              <Box as="tr" key={library.id}>
                <Cell>
                  <Stack gap="0">
                    <Text fontWeight="medium">{library.name}</Text>
                    {library.description ? (
                      <Text fontSize="xs" color="fg.muted">
                        {library.description}
                      </Text>
                    ) : null}
                    {library.archivedAt ? (
                      <Text fontSize="xs" color="warn.fg">
                        archived — hidden from pickers, still readable by every portal
                        that has it
                      </Text>
                    ) : null}
                  </Stack>
                </Cell>
                <Cell>
                  {/* Indexed versus held is the difference between "the portals can
                      read this" and "we have the files". Showing only a total would
                      hide a batch still processing. */}
                  {library.indexedCount === library.documentCount ? (
                    <Text>{library.documentCount}</Text>
                  ) : (
                    <Text color="warn.fg">
                      {library.indexedCount} of {library.documentCount} indexed
                    </Text>
                  )}
                </Cell>
                <Cell muted>{library.pageCount}</Cell>
                <Cell>
                  {library.portals.length === 0 ? (
                    <Text fontSize="sm" color="fg.muted">
                      nobody yet
                    </Text>
                  ) : (
                    <Text fontSize="sm">
                      {library.portals.map((portal) => portal.label).join(', ')}
                    </Text>
                  )}
                </Cell>
                <Cell nowrap>
                  <HStack gap="2">
                    <Button
                      onClick={() => setOpenId(library.id)}
                      label={`Open ${library.name} to manage its files and portals`}
                    >
                      <HStack gap="1">
                        <Library size={13} />
                        <Text>Open</Text>
                      </HStack>
                    </Button>
                    <Button
                      onClick={() =>
                        void act(() =>
                          api.updateLibrary(library.id, { archived: !library.archivedAt }),
                        )
                      }
                      label={
                        library.archivedAt
                          ? `Restore ${library.name}`
                          : `Archive ${library.name} — stops offering it, revokes nothing`
                      }
                    >
                      <HStack gap="1">
                        {library.archivedAt ? <Undo2 size={13} /> : <Archive size={13} />}
                        <Text>{library.archivedAt ? 'Restore' : 'Archive'}</Text>
                      </HStack>
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => remove(library)}
                      label={`Delete ${library.name}`}
                    >
                      <HStack gap="1">
                        <Trash2 size={13} />
                        <Text>Delete</Text>
                      </HStack>
                    </Button>
                  </HStack>
                </Cell>
              </Box>
            ))}
          </Table>
        </AsyncState>
      </Panel>
    </Stack>
  )
}

function LibraryDetail({
  library,
  portals,
  onBack,
  onChanged,
}: {
  library: LibraryRow
  portals: PortalRef[]
  onBack: () => void
  onChanged: () => void
}): React.ReactElement {
  const documents = useLoader(() => api.libraryDocuments(library.id), [library.id])
  const folders = useLoader(() => api.folders(library.id), [library.id])
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [versionsFor, setVersionsFor] = useState<LibraryDocument | null>(null)

  const ticked = new Set(library.portals.map((portal) => portal.portalRowId))
  const rows: LibraryDocument[] = documents.data?.documents ?? []
  const folderRows = folders.data?.folders ?? []
  const paths = buildPaths(folderRows)

  const move = async (document: LibraryDocument, folderId: string | null): Promise<void> => {
    setActionError(null)
    try {
      await api.moveDocument(document.id, library.id, folderId)
      documents.reload()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Move failed')
    }
  }

  const reindex = async (document: LibraryDocument): Promise<void> => {
    setActionError(null)
    try {
      await api.reindexDocument(document.id)
      documents.reload()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Re-index failed')
    }
  }

  const toggle = async (portalRowId: string, next: boolean): Promise<void> => {
    setActionError(null)
    setPending(portalRowId)
    try {
      await api.setLibraryPortal(library.id, portalRowId, next)
      // Both: the tick lives on the library row, the counts live on the list.
      onChanged()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Could not change that')
    } finally {
      setPending(null)
    }
  }

  const removeDocument = (document: LibraryDocument): void => {
    const confirmed = window.confirm(
      `Delete "${document.name}" from ${library.name}?\n\n` +
        `Every portal receiving this library loses it, and its ${document.chunkCount} ` +
        'indexed passages are removed. Re-uploading means embedding it again.',
    )
    if (!confirmed) return
    void (async () => {
      setActionError(null)
      try {
        await api.deleteLibraryDocument(library.id, document.id)
        documents.reload()
        onChanged()
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : 'Delete failed')
      }
    })()
  }

  return (
    <Stack gap="4">
      <HStack>
        <Button onClick={onBack} label="Back to all libraries">
          <HStack gap="1">
            <ArrowLeft size={13} />
            <Text>All libraries</Text>
          </HStack>
        </Button>
        <Text fontWeight="semibold">{library.name}</Text>
        {library.archivedAt ? (
          <Text fontSize="xs" color="warn.fg">
            archived
          </Text>
        ) : null}
      </HStack>

      {actionError ? (
        <Box borderWidth="1px" borderColor="red.400" borderRadius="card" p="3" bg="bg.surface">
          <Text fontSize="sm" color="red.500">
            {actionError}
          </Text>
        </Box>
      ) : null}

      <DocumentUploadPanel
        destination={library.name}
        upload={(files) => api.uploadLibraryDocuments(library.id, files)}
        onUploaded={() => {
          documents.reload()
          onChanged()
        }}
      />

      {/* The permission surface. Headed as a question because that is what the
          operator is answering, and every answer is written the moment it is given. */}
      <Panel title="Which portals receive these files?">
        <Stack p="4" gap="2">
          {portals.length === 0 ? (
            <Text fontSize="sm" color="fg.muted">
              No portals exist yet. A portal registers itself the first time someone opens
              the app in it.
            </Text>
          ) : (
            portals.map((portal) => {
              const isTicked = ticked.has(portal.id)
              return (
                <HStack key={portal.id} gap="3">
                  {/* A plain native checkbox, as everywhere else in this app.
                      `Box as="input"` would not accept `type` or `checked` at all —
                      Chakra's `as` changes the tag but not the props type — and a
                      styled div would have to reimplement keyboard and
                      screen-reader semantics, worse. */}
                  <input
                    type="checkbox"
                    checked={isTicked}
                    disabled={pending === portal.id}
                    onChange={() => void toggle(portal.id, !isTicked)}
                    aria-label={`${isTicked ? 'Stop sending' : 'Send'} ${library.name} to ${portal.label}`}
                  />
                  <Text fontSize="sm">{portal.label}</Text>
                  {portal.status !== 'active' ? (
                    <Text fontSize="xs" color="fg.muted">
                      ({portal.status})
                    </Text>
                  ) : null}
                  {pending === portal.id ? (
                    <Text fontSize="xs" color="fg.muted">
                      saving…
                    </Text>
                  ) : null}
                </HStack>
              )
            })
          )}
          <Text fontSize="xs" color="fg.muted" pt="1">
            Each tick saves immediately. Unticking removes access on the portal&apos;s next
            request and deletes nothing — re-ticking restores it instantly, at no cost.
          </Text>
        </Stack>
      </Panel>

      <FolderTreePanel
        libraryId={library.id}
        folders={folderRows}
        onChanged={() => {
          // Both: the tree changed, and documents carry `folderId`, so deleting a
          // folder that unfiles its documents would otherwise leave the table's
          // picker showing a folder that no longer exists.
          folders.reload()
          documents.reload()
        }}
      />

      <Panel title={`Documents (${rows.filter((row) => !row.deletedAt).length})`}>
        <AsyncState
          loading={documents.loading}
          error={documents.error}
          empty={rows.length === 0}
          emptyMessage="No documents in this library yet — drop some PDFs above."
        >
          <Table headers={['Document', 'Status', 'Folder', 'Pages', 'Passages', 'Size', '']}>
            {rows.map((row) => (
              <Box as="tr" key={row.id} opacity={row.deletedAt ? 0.5 : 1}>
                <Cell>
                  <Stack gap="0">
                    <Text>{row.name}</Text>
                    {row.errorMessage ? (
                      <Text fontSize="xs" color="red.600">
                        {row.errorMessage}
                      </Text>
                    ) : row.statusDetail ? (
                      <Text fontSize="xs" color="fg.muted">
                        {row.statusDetail}
                      </Text>
                    ) : null}
                  </Stack>
                </Cell>
                <Cell>
                  <Pill value={row.deletedAt ? 'deleted' : row.status} />
                </Cell>
                <Cell>
                  {row.deletedAt ? (
                    <Text fontSize="xs" color="fg.muted">
                      —
                    </Text>
                  ) : (
                    <PlainSelect
                      value={row.folderId ?? ''}
                      onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                        void move(row, event.target.value || null)
                      }
                      aria-label={`Folder for ${row.name} in ${library.name}`}
                      borderWidth="1px"
                      borderRadius="md"
                      px="1"
                      py="1"
                      fontSize="xs"
                      bg="bg.canvas"
                      maxW="180px"
                    >
                      {/* Unfiled is a real choice, not an absence — the backend stores
                          null and the viewer's sidebar renders it as a virtual node
                          under this library. */}
                      <option value="">Unfiled</option>
                      {folderRows.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {paths.get(folder.id) ?? folder.name}
                        </option>
                      ))}
                    </PlainSelect>
                  )}
                </Cell>
                <Cell muted>{row.pageCount ?? '—'}</Cell>
                <Cell muted>{row.chunkCount}</Cell>
                <Cell muted nowrap>
                  {formatBytes(row.byteSize)}
                </Cell>
                <Cell nowrap>
                  <HStack gap="2">
                    <Button onClick={() => setVersionsFor(row)} label={`Versions of ${row.name}`}>
                      <HStack gap="1">
                        <History size={13} />
                        <Text>v{row.version}</Text>
                      </HStack>
                    </Button>
                    {/* Absent for an already-deleted row: there is nothing left to
                        re-index or revoke, and offering either would imply otherwise. */}
                    {row.deletedAt ? null : (
                      <>
                        <Button onClick={() => void reindex(row)} label={`Re-index ${row.name}`}>
                          <HStack gap="1">
                            <RefreshCw size={13} />
                            <Text>Re-index</Text>
                          </HStack>
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => removeDocument(row)}
                          label={`Delete ${row.name} from ${library.name}`}
                        >
                          <HStack gap="1">
                            <Trash2 size={13} />
                            <Text>Delete</Text>
                          </HStack>
                        </Button>
                      </>
                    )}
                  </HStack>
                </Cell>
              </Box>
            ))}
          </Table>
        </AsyncState>
      </Panel>

      {versionsFor ? (
        <DocumentVersions document={versionsFor} onClose={() => setVersionsFor(null)} />
      ) : null}
    </Stack>
  )
}

/**
 * The version chain of one document.
 *
 * Real rows walked through `supersedes_document_id`, not a separate history table, so
 * what is listed is what is stored. A document ingested once has no chain and says so
 * rather than showing a one-row table.
 */
function DocumentVersions({
  document,
  onClose,
}: {
  document: LibraryDocument
  onClose: () => void
}): React.ReactElement {
  const { data, loading, error } = useLoader(() => api.documentVersions(document.id), [document.id])
  const versions = data?.versions ?? []

  return (
    <Panel
      title={`Versions — ${document.name}`}
      actions={
        <Button onClick={onClose} label="Close versions">
          Close
        </Button>
      }
    >
      <AsyncState
        loading={loading}
        error={error}
        empty={versions.length <= 1}
        emptyMessage="Only one version exists — this document has never been re-ingested."
      >
        <Table headers={['Version', 'Status', 'Passages', 'Created']}>
          {versions.map((version) => (
            <Box as="tr" key={version.id}>
              <Cell>v{version.version}</Cell>
              <Cell>
                <Pill value={version.status} />
              </Cell>
              <Cell muted>{version.chunkCount}</Cell>
              <Cell muted nowrap>
                {new Date(version.createdAt).toLocaleString()}
              </Cell>
            </Box>
          ))}
        </Table>
      </AsyncState>
    </Panel>
  )
}
