-- ---------------------------------------------------------------------------
-- 0016 — FuseBase is the source of truth for portals, and libraries can be private
--
-- Two small additions, both in service of §4 and §3 of the phase spec.
--
-- ---------------------------------------------------------------------------
-- `missing` is a status, not a deletion
--
-- A portal absent from `listPortals` stops serving immediately —
-- `portal_visible_documents` already filters `p.status = 'active'`, so `missing` gets
-- a visitor nothing, which is the deletion a client experiences.
--
-- What it deliberately does NOT do is destroy rows. Deleting a portal takes its
-- chats, its message history, its usage record and its audit trail with it, and the
-- trigger would be *the absence of a row in an API response*. Absence is also what a
-- partial page, a permission change, a renamed org and a five-second outage look
-- like. So the row survives, `missing_since` records when the doubt started, and
-- removing anything is a staff action taken later and on purpose.
--
-- `missing_since` is also what makes the reverse path work: a portal that reappears
-- has its stamp cleared and returns to `active`, which is the case that proves the
-- caution was worth having.
-- ---------------------------------------------------------------------------

ALTER TABLE public.portals ADD COLUMN missing_since TIMESTAMPTZ;

ALTER TABLE public.portals DROP CONSTRAINT portals_status_check;
ALTER TABLE public.portals ADD CONSTRAINT portals_status_check
  CHECK (status IN ('active', 'paused', 'missing'));

-- Finding the portals eligible for removal is a scan over a handful of rows today,
-- but it runs on every Portals screen load, and the predicate is exactly this shape.
CREATE INDEX portals_missing_idx
  ON public.portals (org_id, missing_since)
  WHERE missing_since IS NOT NULL;

-- ---------------------------------------------------------------------------
-- a private library
--
-- Removing `app_upload` must not remove the ability to give one client one file, so
-- a portal's private files become a library like any other — same upload, same
-- folders, same pipeline — with one promise attached: it goes to exactly one portal.
--
-- The flag is what lets the API keep that promise. `is_private` cannot be expressed
-- as "has exactly one binding", because that is also true of an ordinary library
-- nobody has shared yet, and the difference matters: one is a fact, the other is an
-- undertaking. A boolean says which.
-- ---------------------------------------------------------------------------

ALTER TABLE public.document_sources
  ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.document_sources.is_private IS
  'A private library belongs to one portal and the API refuses to tick it to a '
  'second. Set only on the library auto-created for a portal by ensurePortalTenant.';
