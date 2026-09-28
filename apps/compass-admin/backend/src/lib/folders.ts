/**
 * Document folders — a tree per client, at most five levels deep (§7).
 *
 * Two rules carry all the difficulty:
 *
 *   1. **A move must not create a cycle.** Reparenting a folder under one of its own
 *      descendants would detach that subtree from the root and make it unreachable —
 *      the rows survive, but nothing can ever list them again.
 *   2. **A move must not overflow the depth limit.** Checking the moved folder alone
 *      is not enough: it carries its subtree with it, so what matters is the depth of
 *      its *deepest descendant* after the move. Getting this wrong writes rows that
 *      violate the CHECK constraint and fails halfway through, leaving the tree
 *      partly moved.
 *
 * Both are answered with one recursive descent, before anything is written.
 *
 * `documents.folder_id IS NULL` renders as **Unfiled**. That is a virtual node in the
 * UI, deliberately not a row — a real "Unfiled" folder could be renamed, moved or
 * deleted, and every one of those is meaningless.
 *
 * ## This is a copy, and why
 *
 * Folder organisation is an ADMIN responsibility: the client portal shows the tree and
 * never edits it. But the two apps share no code and no backend by platform design, so
 * the logic lives here as a copy of the client app's `lib/folders.ts`.
 *
 * The client app keeps its copy because `ensureFolderPath` — auto-foldering from a
 * source column during sync — runs there and needs `createFolder`. That function is
 * therefore absent here, along with `moveDocument`, which this app already does
 * inline in its documents route.
 *
 * **A correctness fix to the cycle or depth rules must be applied to BOTH files.**
 * They were ported verbatim rather than rewritten precisely so they cannot drift on
 * day one; that only holds if later changes are made in both places.
 */

import { HttpError } from './auth.js'
import { orgId } from './config.js'
import { recordAudit } from './observability.js'
import {
  deleteRows,
  insertRow,
  query,
  queryOne,
  readNumber,
  readOptionalString,
  readString,
  updateRows,
} from './store.js'

/**
 * Who a folder belongs to — §6A.2.
 *
 * Phase 6 makes a library the only way a file enters the system, so a folder follows
 * its documents. `document_folders` gained `library_id` in 0015 with the same XOR
 * check the seven document tables got in 0013: exactly one owner, enforced by the
 * database.
 *
 * The owner is threaded through as a column name plus a value rather than as two
 * nullable ids, for one reason: **the cycle and depth guards below are not rewritten**.
 * They were the subtle part, they were duplicated in two apps once already, and this
 * phase asked explicitly for them to be left alone. Parameterising the scope means
 * every one of them keeps working, unchanged, for either owner.
 *
 * The column name comes from a closed union, never from a caller, so interpolating it
 * into SQL is safe — and it has to be interpolated, because a column is an identifier
 * and cannot be a bind parameter.
 */
export type FolderOwner =
  | { readonly column: 'client_id'; readonly value: string }
  | { readonly column: 'library_id'; readonly value: string }

/** Folders owned by a library, which is every folder after this phase. */
export function libraryFolders(libraryId: string): FolderOwner {
  return { column: 'library_id', value: libraryId }
}

/**
 * Folders owned by a tenant.
 *
 * Still reachable while the migration in §5 has not moved a client's folders into
 * its private library. Nothing creates one after that.
 */
export function clientFolders(clientId: string): FolderOwner {
  return { column: 'client_id', value: clientId }
}

/** Both owner columns, one set and one null, for an INSERT that must satisfy the XOR. */
function ownerColumns(owner: FolderOwner): { client_id: string | null; library_id: string | null } {
  return owner.column === 'client_id'
    ? { client_id: owner.value, library_id: null }
    : { client_id: null, library_id: owner.value }
}
/** Deepest allowed `depth` value; five levels means 0..4 (§7.1). */
export const MAX_DEPTH = 4

export interface FolderNode {
  id: string
  parentId: string | null
  name: string
  position: number
  depth: number
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

/** Every folder belonging to a client, ordered for direct rendering. */
export async function listFolders(owner: FolderOwner): Promise<FolderNode[]> {
  const rows = await query(
    `SELECT id, parent_id, name, position, depth
       FROM document_folders
      WHERE ${owner.column} = $1
      ORDER BY depth, position, name`,
    [owner.value],
  )
  return rows.map(toNode)
}

async function loadFolder(owner: FolderOwner, folderId: string): Promise<FolderNode> {
  const row = await queryOne(
    `SELECT id, parent_id, name, position, depth
       FROM document_folders
      WHERE id = $1 AND ${owner.column} = $2`,
    [folderId, owner.value],
  )
  // Scoped by client, so a folder id from another tenant is a 404 like any other
  // foreign id — never a 403, which would confirm it exists.
  if (!row) throw new HttpError(404, 'Folder not found', 'NOT_FOUND')
  return toNode(row)
}

/**
 * How many levels of descendants a folder has beneath it.
 *
 * 0 for a leaf. Used to decide whether a subtree still fits under a new parent.
 */
async function subtreeHeight(owner: FolderOwner, folderId: string): Promise<number> {
  const rows = await query(
    `WITH RECURSIVE descendants AS (
       SELECT id, 0 AS relative_depth
         FROM document_folders
        WHERE id = $1 AND ${owner.column} = $2
       UNION ALL
       SELECT f.id, d.relative_depth + 1
         FROM document_folders f
         JOIN descendants d ON f.parent_id = d.id
        WHERE f.${owner.column} = $2
     )
     SELECT max(relative_depth) AS height FROM descendants`,
    [folderId, owner.value],
  )
  const height = rows[0]?.height
  return typeof height === 'number' ? height : Number(height ?? 0)
}

/** True when `candidateParentId` is the folder itself or one of its descendants. */
async function isSelfOrDescendant(
  owner: FolderOwner,
  folderId: string,
  candidateParentId: string,
): Promise<boolean> {
  if (folderId === candidateParentId) return true
  const rows = await query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM document_folders WHERE id = $1 AND ${owner.column} = $2
       UNION ALL
       SELECT f.id FROM document_folders f
         JOIN descendants d ON f.parent_id = d.id
        WHERE f.${owner.column} = $2
     )
     SELECT 1 FROM descendants WHERE id = $3 LIMIT 1`,
    [folderId, owner.value, candidateParentId],
  )
  return rows.length > 0
}

async function nextPosition(owner: FolderOwner, parentId: string | null): Promise<number> {
  const rows = await query(
    parentId === null
      // Template literals, not single quotes. These two were plain strings before the
      // owner became a parameter, and leaving them so would have put the characters
      // `${owner.column}` into the SQL itself — well-typed, invisible to `tsc`, and a
      // syntax error the first time a folder is created.
      ? `SELECT COALESCE(max(position), -1) + 1 AS next FROM document_folders WHERE ${owner.column} = $1 AND parent_id IS NULL`
      : `SELECT COALESCE(max(position), -1) + 1 AS next FROM document_folders WHERE ${owner.column} = $1 AND parent_id = $2`,
    parentId === null ? [owner.value] : [owner.value, parentId],
  )
  const next = rows[0]?.next
  return typeof next === 'number' ? next : Number(next ?? 0)
}

/**
 * Refuse a duplicate sibling name **before** writing, with a 409 that names it.
 *
 * A pre-check rather than a caught constraint violation, and the reason is worth
 * stating because the obvious implementation does not work: writes go through Gate's
 * structured row API, and the Postgres error it surfaces does **not** carry the
 * constraint or index name. Matching on `document_folders_*_sibling_key` therefore
 * never fires, and the duplicate came back to the operator as a bare
 * `500 {"code":"INTERNAL"}` — which is what production actually did, twice: once
 * because both catch blocks still named the constraint 0015 had replaced, and again
 * after that name was corrected, because the name never arrives at all.
 *
 * `COALESCE(parent_id, …)` mirrors 0015's partial indexes exactly, so this refuses
 * precisely what the database would refuse — including two ROOT folders of the same
 * name, which the pre-0015 `UNIQUE (client_id, parent_id, name)` missed because NULL
 * parents never compare equal.
 *
 * The database is still the authority: two simultaneous creates can both pass this
 * and one will lose on the index. That is a genuine race and a rare one; the catch
 * below remains as the backstop for it. This makes the *ordinary* case correct
 * instead of relying on an error message the platform does not promise.
 */
const NO_PARENT = '00000000-0000-0000-0000-000000000000'

async function assertSiblingNameFree(
  owner: FolderOwner,
  parentId: string | null,
  name: string,
  excludeFolderId: string | null = null,
): Promise<void> {
  const existing = await queryOne(
    `SELECT id FROM document_folders
      WHERE ${owner.column} = $1
        AND COALESCE(parent_id, $2::uuid) = COALESCE($3::uuid, $2::uuid)
        AND name = $4
        AND ($5::uuid IS NULL OR id <> $5::uuid)
      LIMIT 1`,
    [owner.value, NO_PARENT, parentId, name, excludeFolderId],
  )
  if (existing) {
    throw new HttpError(409, `A folder named "${name}" already exists here`, 'FOLDER_NAME_TAKEN')
  }
}

export interface CreateFolderInput {
  owner: FolderOwner
  parentId: string | null
  name: string
  userId: string
}

export async function createFolder(input: CreateFolderInput): Promise<FolderNode> {
  const name = input.name.trim()
  if (name.length === 0) throw new HttpError(400, 'A folder name is required', 'BAD_REQUEST')

  let depth = 0
  if (input.parentId !== null) {
    const parent = await loadFolder(input.owner, input.parentId)
    depth = parent.depth + 1
    if (depth > MAX_DEPTH) {
      throw new HttpError(
        400,
        `Folders can be nested ${MAX_DEPTH + 1} levels deep; "${parent.name}" is already at the deepest level`,
        'FOLDER_TOO_DEEP',
      )
    }
  }

  await assertSiblingNameFree(input.owner, input.parentId, name.slice(0, 200))

  const position = await nextPosition(input.owner, input.parentId)

  try {
    const row = await insertRow(
      'document_folders',
      {
        ...ownerColumns(input.owner),
        parent_id: input.parentId,
        name: name.slice(0, 200),
        position,
        depth,
        created_by_user_id: input.userId,
      },
      ['id', 'parent_id', 'name', 'position', 'depth'],
    )
    if (!row) throw new HttpError(500, 'Failed to create folder')
    return toNode(row)
  } catch (error) {
    // Backstop for the race `assertSiblingNameFree` cannot close. It may not fire —
    // see that function for why the constraint name does not reach us — so it is not
    // the mechanism, only the last line.
    if (isSiblingNameConflict(error)) {
      throw new HttpError(
        409,
        `A folder named "${name}" already exists here`,
        'FOLDER_NAME_TAKEN',
      )
    }
    throw error
  }
}

/**
 * True when a write failed on the sibling-name uniqueness rule.
 *
 * Matched against three names, because 0015 replaced the single
 * `document_folders_sibling_name_key` constraint with **two** partial indexes over
 * `COALESCE(parent_id, '000…')`, so that two root folders of the same name are caught
 * as well — NULL parents never compared equal under the old one.
 *
 * **This is a backstop, not the mechanism.** Writes go through Gate's structured row
 * API, whose surfaced error does not include the constraint or index name, so in
 * practice none of the three match and the caller would see a bare 500. That is why
 * `assertSiblingNameFree` exists and runs first. This stays for the concurrent-create
 * race, where it is the only thing between a lost insert and an unexplained error —
 * and it costs nothing to keep pointed at the right names.
 */
function isSiblingNameConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('document_folders_sibling_name_key') ||
    message.includes('document_folders_library_sibling_key') ||
    message.includes('document_folders_client_sibling_key')
  )
}

export async function renameFolder(
  owner: FolderOwner,
  folderId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new HttpError(400, 'A folder name is required', 'BAD_REQUEST')
  const current = await loadFolder(owner, folderId)
  // Excluding itself, so renaming a folder to the name it already has is a no-op
  // rather than a conflict with its own row.
  await assertSiblingNameFree(owner, current.parentId, trimmed.slice(0, 200), folderId)

  try {
    await updateRows('document_folders', { name: trimmed.slice(0, 200) }, [
      { column: 'id', operator: 'eq', value: folderId },
      { column: owner.column, operator: 'eq', value: owner.value },
    ])
  } catch (error) {
    if (isSiblingNameConflict(error)) {
      throw new HttpError(409, `A folder named "${trimmed}" already exists here`, 'FOLDER_NAME_TAKEN')
    }
    throw error
  }
}

/**
 * Reparent a folder, carrying its subtree.
 *
 * Both invariants are checked before any write, and the descendants' `depth` values
 * are rewritten in the same pass — leaving them stale would corrupt every later depth
 * calculation, and the corruption would only surface when someone hit the limit.
 */
export async function moveFolder(
  owner: FolderOwner,
  folderId: string,
  newParentId: string | null,
): Promise<void> {
  const folder = await loadFolder(owner, folderId)
  if (folder.parentId === newParentId) return

  let newDepth = 0
  if (newParentId !== null) {
    if (await isSelfOrDescendant(owner, folderId, newParentId)) {
      throw new HttpError(
        400,
        'A folder cannot be moved inside itself or one of its own subfolders',
        'FOLDER_CYCLE',
      )
    }
    const parent = await loadFolder(owner, newParentId)
    newDepth = parent.depth + 1
  }

  const height = await subtreeHeight(owner, folderId)
  if (newDepth + height > MAX_DEPTH) {
    throw new HttpError(
      400,
      `That move would nest folders ${newDepth + height + 1} levels deep; the limit is ${MAX_DEPTH + 1}`,
      'FOLDER_TOO_DEEP',
    )
  }

  const shift = newDepth - folder.depth
  const position = await nextPosition(owner, newParentId)

  await updateRows(
    'document_folders',
    { parent_id: newParentId, depth: newDepth, position },
    [
      { column: 'id', operator: 'eq', value: folderId },
      { column: owner.column, operator: 'eq', value: owner.value },
    ],
  )

  if (shift !== 0) {
    // Descendants keep their relative shape; only the absolute depth changes.
    //
    // Read the ids with a recursive SELECT, then write with the structured row API.
    // `query()` cannot do the update — it is read-only — and the backend token holds
    // `isolated_store.data.write` without the privileged `isolated_store.execute`,
    // so raw DML is not available here by design.
    //
    // A structured update sets literals, not expressions, so `depth = depth + shift`
    // is issued as one update per distinct current depth. There are at most five
    // levels, so that is at most five statements.
    const descendants = await query(
      `WITH RECURSIVE descendants AS (
         SELECT id, depth FROM document_folders WHERE parent_id = $1 AND ${owner.column} = $2
         UNION ALL
         SELECT f.id, f.depth FROM document_folders f
           JOIN descendants d ON f.parent_id = d.id
          WHERE f.${owner.column} = $2
       )
       SELECT id, depth FROM descendants`,
      [folderId, owner.value],
    )

    const idsByDepth = new Map<number, string[]>()
    for (const row of descendants) {
      const depth = readNumber(row, 'depth')
      const ids = idsByDepth.get(depth) ?? []
      ids.push(readString(row, 'id'))
      idsByDepth.set(depth, ids)
    }

    for (const [depth, ids] of idsByDepth) {
      await updateRows('document_folders', { depth: depth + shift }, [
        { column: 'id', operator: 'in', value: ids },
        { column: owner.column, operator: 'eq', value: owner.value },
      ])
    }
  }
}

/**
 * Delete a folder. Its documents and subfolders move up to its parent.
 *
 * Never deletes documents (§7.2). A folder is an arrangement, and deleting an
 * arrangement must not destroy the things arranged.
 */
export async function deleteFolder(owner: FolderOwner, folderId: string): Promise<void> {
  const folder = await loadFolder(owner, folderId)

  // Children first, so nothing is orphaned by the delete cascade. `ON DELETE CASCADE`
  // on parent_id would otherwise take the whole subtree with it.
  const children = await query(
    `SELECT id FROM document_folders WHERE ${owner.column} = $1 AND parent_id = $2`,
    [owner.value, folderId],
  )
  for (const child of children) {
    await moveFolder(owner, readString(child, 'id'), folder.parentId)
  }

  await updateRows('documents', { folder_id: folder.parentId }, [
    { column: owner.column, operator: 'eq', value: owner.value },
    { column: 'folder_id', operator: 'eq', value: folderId },
  ])

  await deleteRows('document_folders', [
    { column: 'id', operator: 'eq', value: folderId },
    { column: owner.column, operator: 'eq', value: owner.value },
  ])
}

/**
 * Put one folder's siblings in an explicit order (§7.2).
 *
 * `position` has been maintained since folders existed — `createFolder` appends and
 * `moveFolder` appends into the new parent — but nothing could ever *change* it, so a
 * tree could only ever be ordered by creation accident. This is the missing half.
 *
 * Three things this deliberately does not do:
 *
 *   - **It does not accept a partial list.** Reordering is a statement about a whole
 *     sibling set, and applying a partial one leaves the omitted folders holding
 *     positions that collide with the new ones. A caller that knows only "move this
 *     one to index 2" still has to send the resulting order, which is what a drag in
 *     the UI produces anyway.
 *   - **It does not renumber sparsely** (0, 10, 20…). Gaps only help when inserting
 *     without rewriting neighbours, and every caller here rewrites the whole set.
 *     Dense 0..n-1 keeps `ORDER BY position` total and readable in the database.
 *   - **It does not move anything between parents.** That is `moveFolder`, which owns
 *     the cycle and depth checks; mixing the two would put reparenting behind an
 *     endpoint whose validation does not look for cycles.
 */
export async function reorderSiblings(input: {
  owner: FolderOwner
  /** The parent whose children are being ordered; null for the root level. */
  parentId: string | null
  /** Every child of that parent, in the wanted order. */
  orderedIds: string[]
  userId: string
}): Promise<FolderNode[]> {
  // Validate the parent belongs to this client before reading its children, so a
  // foreign parent id is a 404 rather than an empty-and-successful reorder.
  if (input.parentId !== null) await loadFolder(input.owner, input.parentId)

  const current = await query(
    input.parentId === null
      ? `SELECT id FROM document_folders
          WHERE ${input.owner.column} = $1 AND parent_id IS NULL ORDER BY position, name`
      : `SELECT id FROM document_folders
          WHERE ${input.owner.column} = $1 AND parent_id = $2 ORDER BY position, name`,
    input.parentId === null ? [input.owner.value] : [input.owner.value, input.parentId],
  )
  const actual = current.map((row) => readString(row, 'id'))

  // Compared as sets, then reported specifically. "Bad request" without saying which
  // id is wrong makes the caller diff two uuid lists by eye.
  const wanted = new Set(input.orderedIds)
  if (wanted.size !== input.orderedIds.length) {
    throw new HttpError(400, 'orderedIds contains a duplicate', 'BAD_REQUEST')
  }

  const foreign = input.orderedIds.filter((id) => !actual.includes(id))
  if (foreign.length > 0) {
    throw new HttpError(
      400,
      `orderedIds names ${foreign.length} folder(s) that are not children of this parent: ${foreign.join(', ')}`,
      'BAD_REQUEST',
    )
  }

  const missing = actual.filter((id) => !wanted.has(id))
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `orderedIds must list every child of this parent; missing ${missing.length}: ${missing.join(', ')}`,
      'BAD_REQUEST',
    )
  }

  // Already in this order: return without writing. Saves n round trips on the very
  // common case of a drag that ends where it started.
  if (actual.every((id, index) => id === input.orderedIds[index])) {
    return listSiblings(input.owner, input.parentId)
  }

  // One update per folder, because a structured update writes literals — there is no
  // single statement that assigns each row a different position without
  // `isolated_store.execute`, which this backend deliberately does not hold. Sibling
  // sets are small (a folder level, not a table), so this is a handful of calls.
  //
  // Filtered on client_id as well as id: the ids were just verified, but a tenancy
  // filter on the write itself is what makes a future refactor of the check above
  // fail closed instead of silently writing across tenants.
  for (const [index, id] of input.orderedIds.entries()) {
    await updateRows('document_folders', { position: index }, [
      { column: 'id', operator: 'eq', value: id },
      { column: input.owner.column, operator: 'eq', value: input.owner.value },
    ])
  }

  await recordAudit({
    orgId: orgId(),
    // A library folder belongs to no tenant, so its audit row carries none.
    clientId: input.owner.column === 'client_id' ? input.owner.value : null,
    actorUserId: input.userId,
    action: 'folder.reordered',
    targetType: 'folder',
    // The parent is the thing that changed shape; null means the root level.
    targetId: input.parentId ?? 'root',
    metadata: { count: input.orderedIds.length, order: input.orderedIds },
  })

  return listSiblings(input.owner, input.parentId)
}

/** The children of one parent, in stored order. Returned so a caller can render the result without refetching the whole tree. */
async function listSiblings(
  owner: FolderOwner,
  parentId: string | null,
): Promise<FolderNode[]> {
  const rows = await query(
    parentId === null
      ? `SELECT id, parent_id, name, position, depth FROM document_folders
          WHERE ${owner.column} = $1 AND parent_id IS NULL ORDER BY position, name`
      : `SELECT id, parent_id, name, position, depth FROM document_folders
          WHERE ${owner.column} = $1 AND parent_id = $2 ORDER BY position, name`,
    parentId === null ? [owner.value] : [owner.value, parentId],
  )
  return rows.map(toNode)
}
