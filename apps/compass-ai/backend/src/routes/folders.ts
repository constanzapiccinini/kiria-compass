/**
 * The folder trees, read-only (§5C), one per library (§6A.2).
 *
 * A viewer needs the tree to navigate, and that is all this app does with it now.
 * Creating, renaming, reparenting, reordering and filing a document are gone from
 * here: they live in Compass Admin, which is the only implementation left, closing
 * the duplication flagged in PHASE-4-COMPLETE. The subtle parts of that logic — the
 * cycle check and the depth-overflow rule — were duplicated verbatim in both apps,
 * which meant two chances to corrupt a tree and two places to fix a bug.
 *
 * `lib/folders.ts` no longer keeps `ensureFolderPath` either: it existed for the
 * source sync's auto-foldering, and §6A.1 removed the sync.
 */

import { Hono } from 'hono'
import { HttpError } from '../lib/auth.js'
import { assertNoTenantOverride, resolvePortalContext } from '../lib/portal.js'
import { listPortalLibraries } from '../lib/folders.js'

export const folderRoutes = new Hono()

/**
 * The libraries this portal receives, each with its own tree.
 *
 * Open to both actors: which folder a document sits in is not privileged
 * information, and a client cannot navigate without it.
 *
 * The response is a list of libraries rather than a flat list of folders, and the
 * nesting is the contract: two libraries may each contain a folder called *Compass*,
 * so a flat list would be ambiguous exactly where it matters (§2). The portal's
 * status is not re-checked here — `resolvePortalContext` already refuses a paused or
 * missing portal with a 409 before this runs.
 */
folderRoutes.get('/', async (c) => {
  const probe = assertNoTenantOverride(c)
  if (probe) {
    throw new HttpError(400, `Request carried a tenant identifier "${probe}"`, 'TENANCY_PROBE')
  }

  const context = await resolvePortalContext(c)
  const libraries = await listPortalLibraries(context.portalId)
  return c.json({ libraries })
})
