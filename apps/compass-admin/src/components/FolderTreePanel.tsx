/**
 * Folder organisation for one library — the only place the tree can be edited (§7).
 *
 * Retargeted from client to library by §6A.2, which is a change of owner and not of
 * behaviour: the cycle check, the depth rule and the reorder/reparent split are
 * untouched. Two libraries may each hold a folder called *Compass* and those are
 * different folders; the panel is rendered inside one library's detail view, so the
 * tree it shows is never ambiguous.
 *
 * The client portal renders the tree and never mutates it, so every create, rename,
 * reparent, reorder and delete happens here.
 *
 * ## Reorder and reparent are separate controls on purpose
 *
 * They look like one gesture in a drag-and-drop tree, and treating them as one is how
 * a reparent ends up running through validation that only knows about ordering.
 * Moving a folder under one of its own descendants detaches that subtree from the root
 * permanently — the rows survive and nothing can list them again — so reparenting goes
 * through its own endpoint, which refuses cycles and depth overflow before writing.
 *
 * Buttons rather than drag-and-drop, deliberately. A pointer-only tree editor excludes
 * keyboard users, and the operations here are destructive enough that an explicit
 * "move up" beats a gesture that can be triggered by a stray drag. Arrow buttons are
 * also unambiguous about which sibling set is being reordered, which a drop indicator
 * between two nested rows is not.
 */

import { useState } from 'react'
import { Box, HStack, Stack, Text } from '@chakra-ui/react'
import { ChevronDown, ChevronUp, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import { api, type FolderRow } from '@/lib/client'
import { Button, Panel } from '@/components/primitives'
import { PlainInput, PlainSelect } from '@/components/ui/native'

/** Matches the backend's `MAX_DEPTH` (§7.1): five levels, 0..4. */
const MAX_DEPTH = 4

interface TreeNode extends FolderRow {
  children: TreeNode[]
}

/** Build the tree, ordered by `position` then name — the same order the portal uses. */
function buildTree(folders: FolderRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>(
    folders.map((folder) => [folder.id, { ...folder, children: [] }]),
  )
  const roots: TreeNode[] = []

  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sort = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    for (const node of nodes) sort(node.children)
  }
  sort(roots)
  return roots
}

/** Flatten for the parent picker, indenting so nesting is readable in a select. */
function flatten(nodes: TreeNode[], depth = 0): Array<{ folder: TreeNode; depth: number }> {
  return nodes.flatMap((folder) => [
    { folder, depth },
    ...flatten(folder.children, depth + 1),
  ])
}

/**
 * Ids that cannot be a new parent for `folderId`: itself and its descendants.
 *
 * The backend refuses these anyway. Removing them from the picker means the operator
 * never chooses a move that will be rejected, rather than learning it from an error.
 */
function forbiddenParents(node: TreeNode): Set<string> {
  const ids = new Set<string>([node.id])
  const walk = (current: TreeNode): void => {
    for (const child of current.children) {
      ids.add(child.id)
      walk(child)
    }
  }
  walk(node)
  return ids
}

export interface FolderTreePanelProps {
  libraryId: string
  folders: FolderRow[]
  onChanged: () => void
}

export function FolderTreePanel({
  libraryId,
  folders,
  onChanged,
}: FolderTreePanelProps): React.ReactElement {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [newParent, setNewParent] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const tree = buildTree(folders)
  const flat = flatten(tree)
  const byId = new Map(flat.map((entry) => [entry.folder.id, entry.folder]))

  /** Wrap every mutation: one place for the busy flag, the error and the reload. */
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const create = (): void => {
    const name = newName.trim()
    if (name.length === 0) {
      setError('A folder name is required.')
      return
    }
    void run(async () => {
      await api.createFolder(libraryId, newParent || null, name)
      setNewName('')
    })
  }

  const rename = (): void => {
    if (!renaming) return
    const name = renaming.name.trim()
    if (name.length === 0) {
      setError('A folder name is required.')
      return
    }
    void run(async () => {
      await api.renameFolder(renaming.id, libraryId, name)
      setRenaming(null)
    })
  }

  const remove = (node: TreeNode): void => {
    const confirmed = window.confirm(
      `Delete the folder "${node.name}"?\n\n` +
        `Its ${node.children.length} subfolder(s) move up to its parent and its documents ` +
        `become Unfiled. No document is deleted.`,
    )
    if (!confirmed) return
    void run(() => api.deleteFolder(node.id, libraryId))
  }

  /** Move one folder within its own sibling set. Sends the complete new order. */
  const nudge = (node: TreeNode, direction: -1 | 1): void => {
    const siblings = node.parentId ? (byId.get(node.parentId)?.children ?? []) : tree
    const from = siblings.findIndex((sibling) => sibling.id === node.id)
    const to = from + direction
    if (from === -1 || to < 0 || to >= siblings.length) return

    const orderedIds = siblings.map((sibling) => sibling.id)
    orderedIds.splice(to, 0, ...orderedIds.splice(from, 1))
    void run(() => api.reorderFolders(libraryId, node.parentId, orderedIds))
  }

  const reparent = (node: TreeNode, parentId: string | null): void => {
    if (parentId === node.parentId) return
    void run(() => api.reparentFolder(node.id, libraryId, parentId))
  }

  const renderRow = (node: TreeNode, depth: number): React.ReactElement => {
    const siblings = node.parentId ? (byId.get(node.parentId)?.children ?? []) : tree
    const index = siblings.findIndex((sibling) => sibling.id === node.id)
    const forbidden = forbiddenParents(node)

    return (
      <Box key={node.id}>
        <HStack gap="2" py="1" pl={`${depth * 20}px`}>
          <Text fontSize="sm" flex="1" minW="0">
            {renaming?.id === node.id ? (
              <HStack gap="1">
                <PlainInput
                  value={renaming.name}
                  autoFocus
                  aria-label={`New name for ${node.name}`}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setRenaming({ id: node.id, name: event.target.value })
                  }
                  onKeyDown={(event: React.KeyboardEvent) => {
                    if (event.key === 'Enter') rename()
                    if (event.key === 'Escape') setRenaming(null)
                  }}
                  borderWidth="1px"
                  borderRadius="md"
                  px="2"
                  py="0.5"
                  fontSize="sm"
                  bg="bg.canvas"
                />
                <Button onClick={rename} disabled={busy} label="Save name">
                  Save
                </Button>
                <Button onClick={() => setRenaming(null)} label="Cancel rename">
                  Cancel
                </Button>
              </HStack>
            ) : (
              <>
                {node.name}
                <Text as="span" fontSize="xs" color="fg.muted">
                  {' '}
                  · depth {node.depth}
                </Text>
              </>
            )}
          </Text>

          {renaming?.id === node.id ? null : (
            <HStack gap="1">
              {/* Disabled at the ends rather than hidden: a control that vanishes makes
                  the row jump and the buttons move under the pointer. */}
              <Button
                onClick={() => nudge(node, -1)}
                disabled={busy || index <= 0}
                label={`Move ${node.name} up`}
              >
                <ChevronUp size={13} />
              </Button>
              <Button
                onClick={() => nudge(node, 1)}
                disabled={busy || index === siblings.length - 1}
                label={`Move ${node.name} down`}
              >
                <ChevronDown size={13} />
              </Button>

              <PlainSelect
                value={node.parentId ?? ''}
                aria-label={`Parent of ${node.name}`}
                disabled={busy}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                  reparent(node, event.target.value || null)
                }
                borderWidth="1px"
                borderRadius="md"
                px="1"
                py="0.5"
                fontSize="xs"
                bg="bg.canvas"
                maxW="170px"
              >
                <option value="">(root)</option>
                {flat
                  // Itself and its descendants would be a cycle; a parent too deep to
                  // hold this folder's own subtree would overflow the depth limit.
                  .filter(
                    (entry) =>
                      !forbidden.has(entry.folder.id) && entry.folder.depth < MAX_DEPTH,
                  )
                  .map((entry) => (
                    <option key={entry.folder.id} value={entry.folder.id}>
                      {`${' '.repeat(entry.depth * 2)}${entry.folder.name}`}
                    </option>
                  ))}
              </PlainSelect>

              <Button
                onClick={() => setRenaming({ id: node.id, name: node.name })}
                disabled={busy}
                label={`Rename ${node.name}`}
              >
                <Pencil size={13} />
              </Button>
              <Button
                variant="danger"
                onClick={() => remove(node)}
                disabled={busy}
                label={`Delete folder ${node.name}`}
              >
                <Trash2 size={13} />
              </Button>
            </HStack>
          )}
        </HStack>

        {node.children.map((child) => renderRow(child, depth + 1))}
      </Box>
    )
  }

  return (
    <Panel title={`Folders (${folders.length})`}>
      <Stack p="4" gap="3">
        {error ? (
          <Text fontSize="sm" color="red.500">
            {error}
          </Text>
        ) : null}

        <HStack gap="2">
          <PlainInput
            value={newName}
            placeholder="New folder name"
            aria-label="New folder name"
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNewName(event.target.value)}
            onKeyDown={(event: React.KeyboardEvent) => {
              if (event.key === 'Enter') create()
            }}
            borderWidth="1px"
            borderRadius="md"
            px="2"
            py="1"
            fontSize="sm"
            bg="bg.canvas"
            flex="1"
          />
          <PlainSelect
            value={newParent}
            aria-label="Parent for the new folder"
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
              setNewParent(event.target.value)
            }
            borderWidth="1px"
            borderRadius="md"
            px="2"
            py="1"
            fontSize="sm"
            bg="bg.canvas"
          >
            <option value="">(root)</option>
            {flat
              // A folder at the deepest level cannot take a child.
              .filter((entry) => entry.folder.depth < MAX_DEPTH)
              .map((entry) => (
                <option key={entry.folder.id} value={entry.folder.id}>
                  {`${' '.repeat(entry.depth * 2)}${entry.folder.name}`}
                </option>
              ))}
          </PlainSelect>
          <Button variant="primary" onClick={create} disabled={busy} label="Create folder">
            <HStack gap="1">
              <FolderPlus size={14} />
              <Text>Create</Text>
            </HStack>
          </Button>
        </HStack>

        {folders.length === 0 ? (
          <Text fontSize="sm" color="fg.muted">
            No folders yet. Documents without one show as “Unfiled”, which is a label in
            the portal rather than a folder — so it cannot be renamed, moved or deleted.
          </Text>
        ) : (
          <Stack gap="0">{tree.map((node) => renderRow(node, 0))}</Stack>
        )}

        <Text fontSize="xs" color="fg.muted">
          Up to {MAX_DEPTH + 1} levels. A folder cannot be moved under itself or its own
          subfolders, and a move that would push its deepest subfolder past the limit is
          refused before anything changes.
        </Text>
      </Stack>
    </Panel>
  )
}
