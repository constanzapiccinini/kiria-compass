/**
 * Who a row belongs to: a portal's tenant, or a library (§5B).
 *
 * Migration 0013 gave seven tables a `library_id` alongside `client_id` and a
 * `CHECK ((client_id IS NULL) <> (library_id IS NULL))` — exactly one owner, checked
 * by the database rather than by convention. This module is the same invariant in
 * TypeScript, in one place, so the pipeline cannot write half the pair.
 *
 * Why a type at all, rather than passing two nullable strings around: the pipeline
 * had roughly a dozen sites that wrote `client_id: clientId` for a derived row, and
 * every one of them would have silently produced an unsatisfiable row for a library
 * document. Making the owner a value that must be threaded through turned each of
 * those into a compile error, which is how they were found rather than guessed at.
 */

export interface RowOwner {
  /** The owning tenant, or null when the row belongs to a library. */
  clientId: string | null
  /** The owning library, or null when the row belongs to a tenant. */
  libraryId: string | null
}

/** The owner columns for a `documents`, `ingest_jobs`, chunk, page or usage row. */
export function ownerColumns(owner: RowOwner): {
  client_id: string | null
  library_id: string | null
} {
  return { client_id: owner.clientId, library_id: owner.libraryId }
}

/**
 * An owner for work that definitely belongs to a tenant.
 *
 * Used at the call sites that have a client in hand and no library to consider — a
 * portal upload, a source sync — so they read as a deliberate statement rather than
 * as an object literal with a null someone might later "fix".
 */
export function clientOwner(clientId: string): RowOwner {
  return { clientId, libraryId: null }
}

/**
 * An owner for work that belongs to the organisation rather than to anyone in it.
 *
 * Both columns null, which 0013's XOR check refuses for every kind except the two
 * Phase 8 analysis jobs — 0022 names them explicitly. Used only for those: an
 * `insight_embed` run reads every client's questions in one query and an
 * `insight_purge` walks every client with a retention setting, so writing any single
 * tenant here would make the run look like it belonged to that one client in every
 * list and every cost report.
 */
export const orgOwner: RowOwner = { clientId: null, libraryId: null }

/** True when this row belongs to a library and so to no single tenant. */
export function isLibraryOwned(owner: RowOwner): boolean {
  return owner.libraryId !== null
}
