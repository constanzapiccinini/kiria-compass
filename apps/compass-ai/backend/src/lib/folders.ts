/**
 * The folder trees a portal receives — one per library (§6A.2).
 *
 * This file used to hold both halves of the folder feature: reading the tree, and
 * writing it (create, reparent, the cycle check, the depth-overflow rule, and
 * `ensureFolderPath` for the source sync's auto-foldering). All of the writing is
 * gone.
 *
 * Two separate reasons, and it is worth keeping them apart:
 *
 *   - **Organising is admin-only** (§5C). `compass-admin/backend/src/lib/folders.ts`
 *     is the one implementation of the cycle and depth rules. Two copies meant two
 *     chances to corrupt a tree.
 *   - **The source sync is gone** (§6A.1). `ensureFolderPath` existed only to build a
 *     path while importing rows from a table source, and nothing imports rows any
 *     more. It was the last caller of the private `createFolder`, so both went.
 *
 * What is left is a read, and it changed shape. A folder belonged to a tenant until
 * 0015 and belongs to a library now, so the question "which folders does this viewer
 * see" is no longer "which client is this" but "which libraries does this portal
 * receive". After §6.5 moved every document into a library, the old client-scoped
 * query returned an empty tree for every caller — this is not a refinement of that
 * behaviour, it replaces something that no longer works.
 *
 * `documents.folder_id IS NULL` renders as **Unfiled** under its library. That is a
 * virtual node in the UI, deliberately not a row — a real "Unfiled" folder could be
 * renamed, moved or deleted, and every one of those is meaningless.
 */

import { query, readNumber, readOptionalString, readString } from './store.js'

export interface FolderNode {
  id: string
  parentId: string | null
  name: string
  position: number
  depth: number
}

/**
 * One library a portal receives, with its own tree.
 *
 * The name travels with the folders rather than being looked up separately, because
 * it is what disambiguates them: two libraries may each contain a folder called
 * *Compass*, and the only thing that tells those apart is which library they hang
 * under (§2). So the library is a node in the sidebar, never a grouping the UI is
 * free to collapse away when a portal happens to receive exactly one.
 */
export interface PortalLibrary {
  id: string
  name: string
  folders: FolderNode[]
}

function toNode(row: Record<string, unknown>): FolderNode {
  return {
    id: readString(row, 'id'),
    parentId: readOptionalString(row, 'parent_id'),
    name: readString(row, 'name'),
    position: readNumber(row, 'position'),
    depth: readNumber(row, 'depth'),
  }
}

/**
 * Every library this portal receives, each with its folders ordered for rendering.
 *
 * Resolved through `portal_source_bindings` — a tick is a binding row and nothing
 * else — and restricted to `kind = 'library'`, which after §6A.1 is the only kind
 * that still binds. Archived libraries are included: archiving means "stop offering
 * this to new portals", not "revoke it from the ones that have it", and a viewer
 * losing their documents because staff tidied the library list would be a surprise
 * nobody asked for.
 *
 * A library with no folders is still returned. It holds the portal's Unfiled
 * documents, so dropping it would hide files that are perfectly visible.
 *
 * One query rather than one per library: the number of libraries a portal receives is
 * small, but it is data, and a loop here would make the sidebar's cost depend on it.
 */
export async function listPortalLibraries(portalId: string): Promise<PortalLibrary[]> {
  const rows = await query(
    `SELECT s.id AS library_id, s.name AS library_name,
            f.id, f.parent_id, f.name, f.position, f.depth
       FROM portals p
       JOIN portal_source_bindings b ON b.portal_row_id = p.id
       JOIN document_sources s ON s.id = b.source_id AND s.kind = 'library'
       LEFT JOIN document_folders f ON f.library_id = s.id
      WHERE p.portal_id = $1
      ORDER BY s.name, f.depth, f.position, f.name`,
    [portalId],
  )

  const byLibrary = new Map<string, PortalLibrary>()
  for (const row of rows) {
    const libraryId = readString(row, 'library_id')
    let library = byLibrary.get(libraryId)
    if (!library) {
      library = { id: libraryId, name: readString(row, 'library_name'), folders: [] }
      byLibrary.set(libraryId, library)
    }
    // A LEFT JOIN row for a library with no folders carries nulls in the folder
    // columns; the library itself is still wanted, so only the folder is skipped.
    if (row.id !== null) library.folders.push(toNode(row))
  }

  return [...byLibrary.values()]
}
