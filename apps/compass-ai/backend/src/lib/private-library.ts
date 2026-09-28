/**
 * A portal's private files — §6A.3.
 *
 * Phase 6 makes a library the only way a file enters the system. That must not remove
 * the ability to give one client one document, so "just for this portal" becomes a
 * library like any other: same upload contract, same folders, same pipeline. The only
 * thing that distinguishes it is a promise — **it goes to exactly one portal** — and
 * `is_private` is what lets the API keep that promise rather than merely hope for it.
 *
 * Why a flag instead of inferring it from "has exactly one binding": an ordinary
 * library that nobody has shared yet also has one binding. One of those is a fact
 * about today, the other is an undertaking about tomorrow, and only the second should
 * make a second tick a 409.
 *
 * This replaces `ensureAppUploadSource`. The old shape — an `app_upload` source per
 * tenant, bound to that tenant's portals — is what Phase 6 retires, and keeping both
 * would mean two doors again.
 *
 * Duplicated in `apps/compass-admin/backend/src/lib/private-library.ts`: backends are
 * not shared between apps on this platform and both callers are required — the admin
 * provisions on click, the client app self-registers on a first visit. Edit together.
 */

import { orgId } from './config.js'
import { insertRow, query, queryOne, readString } from './store.js'

/** The name a portal's private library carries. §6 open item 3 settled on this. */
export function privateLibraryName(portalLabel: string): string {
  return `${portalLabel} — files`.slice(0, 200)
}

/**
 * Find or create this portal's private library, ticked to it and nothing else.
 *
 * Idempotent on the tick as well as on the library: called on every provision, and a
 * portal must not accumulate duplicate bindings to its own files.
 *
 * Returns the library id. Throws only if the library cannot be created at all — a
 * portal with no private library cannot receive a direct upload, which is the trap
 * the Phase 4 backfill had to repair by hand.
 */
export async function ensurePrivateLibrary(
  portalRowId: string,
  portalLabel: string,
  actorUserId: string,
): Promise<string> {
  // Keyed on the binding rather than on the name: a rename must not orphan the
  // library and cause a second one to be created beside it.
  const existing = await queryOne(
    `SELECT s.id
       FROM document_sources s
       JOIN portal_source_bindings b ON b.source_id = s.id
      WHERE b.portal_row_id = $1
        AND s.kind = 'library'
        AND s.is_private IS TRUE
      ORDER BY s.created_at
      LIMIT 1`,
    [portalRowId],
  )
  if (existing) return readString(existing, 'id')

  const created = await insertRow(
    'document_sources',
    {
      org_id: orgId(),
      name: privateLibraryName(portalLabel),
      description: 'Files for this portal only. Created automatically.',
      kind: 'library',
      owner_kind: 'library',
      is_private: true,
      created_by_user_id: actorUserId,
    },
    ['id'],
  )
  if (!created) {
    throw new Error(`Could not create a private library for portal row ${portalRowId}`)
  }
  const libraryId = readString(created, 'id')

  // The tick is what makes it visible at all: `portal_visible_documents` resolves
  // through bindings, so a library with no binding is invisible however well its
  // documents indexed.
  await insertRow(
    'portal_source_bindings',
    { org_id: orgId(), portal_row_id: portalRowId, source_id: libraryId },
    ['source_id'],
  ).catch(() => undefined)

  return libraryId
}

/**
 * The portal a private library belongs to, or null when it is a shared library.
 *
 * Read from the binding, so it stays correct if the library is renamed.
 */
export async function privateLibraryOwner(libraryId: string): Promise<string | null> {
  const row = await queryOne(
    `SELECT b.portal_row_id
       FROM document_sources s
       JOIN portal_source_bindings b ON b.source_id = s.id
      WHERE s.id = $1 AND s.is_private IS TRUE
      LIMIT 1`,
    [libraryId],
  )
  return row ? readString(row, 'portal_row_id') : null
}

/**
 * Every private library in the org, by the portal row that owns it.
 *
 * One statement for the whole list rather than one per library: the Libraries screen
 * marks each private library with its portal, and N+1 round trips would show counts
 * from N different moments.
 */
export async function privateLibraryOwners(): Promise<Map<string, string>> {
  const rows = await query(
    `SELECT s.id AS library_id, b.portal_row_id
       FROM document_sources s
       JOIN portal_source_bindings b ON b.source_id = s.id
      WHERE s.org_id = $1 AND s.kind = 'library' AND s.is_private IS TRUE`,
    [orgId()],
  )
  const owners = new Map<string, string>()
  for (const row of rows) {
    owners.set(readString(row, 'library_id'), readString(row, 'portal_row_id'))
  }
  return owners
}
