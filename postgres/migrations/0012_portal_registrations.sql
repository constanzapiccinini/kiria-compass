-- ---------------------------------------------------------------------------
-- 0012 — portal sightings, so a new portal is findable instead of a dead end
--
-- Nothing anywhere inserted into `portals`: the two rows in production were
-- written by hand during Phase 4A, and both now point at portals that have
-- since been deleted. A portal created in FuseBase refuses its first visitor
-- with PORTAL_NOT_BOUND and appears nowhere in the admin, so the only way
-- forward was to write SQL. That is the bug this phase closes.
--
-- Discovery through Gate `listPortals` is the preferred route and the join key
-- was verified before any of this was written, because the spec was right to
-- insist: `getPortal` accepts the ids `listPortals` returns (200) and rejects
-- the ids in our own `portals` table (404 Portal not found). So the two are the
-- same identifier space, and our rows are simply stale — there is no id-shape
-- mismatch to work around.
--
-- This table is the fallback that works even when discovery does not: it is
-- fed by the client app when a portal token verifies but no `portals` row
-- exists. It records the sighting so staff can find and connect the portal
-- afterwards.
--
-- Two things it deliberately is not:
--
--   * **Not a binding.** `portals.client_id` is NOT NULL and only a person
--     knows which client a portal belongs to. Guessing would attach a client's
--     documents to the wrong portal, which is the one mistake this whole
--     tenancy model exists to prevent. That constraint stays.
--   * **Not a way in.** The visitor still gets the same refusal. Recording the
--     sighting changes nothing about what they can see.
--
-- `seen_count` matters more than it looks: it is the difference between "a
-- portal was set up and nobody has opened it" and "eleven people have been
-- turned away today".
-- ---------------------------------------------------------------------------

CREATE TABLE public.portal_registrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Defaulted from the injected setting for the same reason as every other
  -- org_id since v9: one place to be right instead of one per insert, and a
  -- missing setting fails loudly on NOT NULL rather than writing a NULL.
  org_id        TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  portal_id     TEXT NOT NULL,
  workspace_id  TEXT,
  label         TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count    INTEGER NOT NULL DEFAULT 1,
  -- Set when staff connect the portal or explicitly dismiss the sighting, so
  -- the "waiting to be connected" list empties instead of growing forever.
  dismissed_at  TIMESTAMPTZ,
  CONSTRAINT portal_registrations_key UNIQUE (org_id, portal_id)
);

-- The admin lists undismissed sightings, newest activity first.
CREATE INDEX portal_registrations_pending_idx
  ON public.portal_registrations (org_id, last_seen_at DESC)
  WHERE dismissed_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS, in the same shape as every other org-scoped table (0007), plus FORCE to
-- match 0011 — otherwise this table would be the one that reintroduces a
-- manifest warning and the count stops being a useful signal.
-- ---------------------------------------------------------------------------

ALTER TABLE public.portal_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_registrations FORCE ROW LEVEL SECURITY;

CREATE POLICY portal_registrations_org_isolation ON public.portal_registrations
  FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR org_id = current_setting('app.org_id', true))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR org_id = current_setting('app.org_id', true));
