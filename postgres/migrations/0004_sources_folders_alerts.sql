-- ---------------------------------------------------------------------------
-- 0004 — sources, folders and the alert tables
--
-- Phase 4B of Coni-PHASE-4-Portal-Model.md (§5.2, §6, §7). The alert tables
-- (system_alerts, alert_deliveries, app_settings) are created here because the
-- spec names this file for them, but nothing raises alerts until Phase 4D —
-- creating the tables early costs nothing and keeps the migration line simple.
--
-- Three things in here change how existing reads work, so they are called out:
--
--   1. `portal_visible_documents` (§6.5) becomes the single answer to "what can
--      this portal see". Client-facing reads must join it on the trusted
--      portalId. Filtering on client_id alone breaks group sources; filtering on
--      a chat's stored document list alone keeps a removed binding readable.
--   2. `documents.sync_status` defaults to 'managed', which is what every row
--      uploaded by hand already is — so existing documents stay visible.
--   3. `documents.folder_id` NULL renders as the virtual "Unfiled" node. It is
--      deliberately not a real folder row.
--
-- REQUIRED DATA STEP AFTER THIS MIGRATION — do not deploy the view-backed reads
-- without it. `portal_visible_documents` joins `documents.source_id`, and every
-- row that exists today has `source_id = NULL`, so on its own this migration
-- makes every hand-uploaded document invisible to clients. §6.1 gives the
-- answer: `app_upload` is an implicit per-client source. So after applying:
--
--   a. create one `app_upload` source per client,
--   b. set `documents.source_id` to it for that client's existing rows,
--   c. bind it to that client's portal in `portal_source_bindings`.
--
-- That is DML and belongs in a seed script, not here — Gate rejects INSERT /
-- UPDATE inside a migration bundle. `scripts/backfill-app-upload-sources.mjs`
-- performs it and is idempotent.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- sources
-- ---------------------------------------------------------------------------

CREATE TABLE public.document_sources (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('compasses_table','app_upload')),
  owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('client','group')),
  client_id      UUID REFERENCES public.clients (id) ON DELETE CASCADE,
  group_id       UUID REFERENCES public.client_groups (id) ON DELETE CASCADE,
  config         JSONB NOT NULL DEFAULT '{}'::JSONB,
  sync_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
  status         TEXT NOT NULL DEFAULT 'idle'
                 CHECK (status IN ('idle','syncing','error','disabled')),
  last_sync_at   TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error     TEXT,
  sync_cursor    JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by_user_id TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Exactly one owner. A source owned by both, or neither, has no meaningful
  -- visibility answer, so the database refuses it rather than leaving the sync
  -- job to guess.
  CONSTRAINT document_sources_owner_check CHECK (
    (owner_kind = 'client' AND client_id IS NOT NULL AND group_id IS NULL) OR
    (owner_kind = 'group'  AND group_id  IS NOT NULL AND client_id IS NULL)
  )
);

CREATE INDEX document_sources_client_idx ON public.document_sources (client_id);
CREATE INDEX document_sources_group_idx ON public.document_sources (group_id);
-- The sync scheduler scans for due, enabled sources; this is the shape of that scan.
CREATE INDEX document_sources_due_idx
  ON public.document_sources (sync_enabled, status, last_sync_at);

CREATE TRIGGER document_sources_touch_updated_at
  BEFORE UPDATE ON public.document_sources
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Which sources feed which portal. A portal reads its client's source plus any
-- number of group sources, ordered by position.
CREATE TABLE public.portal_source_bindings (
  portal_row_id UUID NOT NULL REFERENCES public.portals (id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES public.document_sources (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (portal_row_id, source_id)
);

CREATE INDEX portal_source_bindings_source_idx
  ON public.portal_source_bindings (source_id);

-- ---------------------------------------------------------------------------
-- folders
-- ---------------------------------------------------------------------------

CREATE TABLE public.document_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES public.document_folders (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  depth       INTEGER NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 4),
  created_by_user_id TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_folders_sibling_name_key UNIQUE (client_id, parent_id, name)
);

CREATE INDEX document_folders_client_idx
  ON public.document_folders (client_id, parent_id, position);

CREATE TRIGGER document_folders_touch_updated_at
  BEFORE UPDATE ON public.document_folders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- alerts (tables now, wiring in Phase 4D)
-- ---------------------------------------------------------------------------

CREATE TABLE public.system_alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL,
  code          TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  scope         TEXT NOT NULL CHECK (scope IN ('org','client','portal','source','document','chat')),
  client_id     UUID REFERENCES public.clients (id) ON DELETE CASCADE,
  portal_row_id UUID REFERENCES public.portals (id) ON DELETE CASCADE,
  source_id     UUID REFERENCES public.document_sources (id) ON DELETE CASCADE,
  document_id   UUID REFERENCES public.documents (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  cause         TEXT NOT NULL,
  remediation   TEXT NOT NULL,
  client_message TEXT,
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','acknowledged','resolved')),
  dedupe_key    TEXT NOT NULL,
  occurrences   INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified_at TIMESTAMPTZ,
  acknowledged_by_user_id TEXT,
  resolved_at   TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  -- Dedupe is scoped by status so a resolved alert does not block an identical
  -- new one when the same failure recurs later.
  CONSTRAINT system_alerts_dedupe_key UNIQUE (org_id, dedupe_key, status)
);

CREATE INDEX system_alerts_open_idx
  ON public.system_alerts (status, severity, last_seen_at DESC);

CREATE TABLE public.alert_deliveries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id   UUID NOT NULL REFERENCES public.system_alerts (id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('email','in_app','monday')),
  target     TEXT,
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','sent','failed','skipped')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX alert_deliveries_alert_idx ON public.alert_deliveries (alert_id);
CREATE INDEX alert_deliveries_pending_idx
  ON public.alert_deliveries (status, created_at);

CREATE TABLE public.app_settings (
  org_id     TEXT PRIMARY KEY,
  defaults   JSONB NOT NULL DEFAULT '{}'::JSONB,
  alert_recipients JSONB NOT NULL DEFAULT '[]'::JSONB,
  channels   JSONB NOT NULL DEFAULT '{"email":true,"in_app":true,"monday":false}'::JSONB,
  updated_by_user_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER app_settings_touch_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- documents gains source, folder and sync columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.documents
  ADD COLUMN folder_id  UUID REFERENCES public.document_folders (id) ON DELETE SET NULL,
  ADD COLUMN source_id  UUID REFERENCES public.document_sources (id) ON DELETE SET NULL,
  ADD COLUMN external_id TEXT,
  ADD COLUMN external_updated_at TIMESTAMPTZ,
  -- A manual move by an employee wins over auto-foldering, so the next sync does
  -- not drag the document back to the path its source column implies (§7.3).
  ADD COLUMN folder_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'managed' is the right default for every row that already exists: they were
  -- uploaded by hand and no source owns them.
  ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'managed'
    CHECK (sync_status IN ('managed','synced','orphaned'));

-- One row per (source, external id) among live documents. Partial so that
-- soft-deleted rows do not block a re-sync of the same external id.
CREATE UNIQUE INDEX documents_source_external_key
  ON public.documents (source_id, external_id)
  WHERE source_id IS NOT NULL AND external_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX documents_folder_idx ON public.documents (client_id, folder_id);
CREATE INDEX documents_source_idx ON public.documents (source_id);

-- ---------------------------------------------------------------------------
-- sync job kind
-- ---------------------------------------------------------------------------

-- Same shape as 0002's extension: drop and re-add, because a CHECK constraint
-- cannot be altered in place.
ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT ingest_jobs_kind_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_kind_check CHECK (kind IN (
    'parse', 'ocr', 'embed', 'reindex', 'delete', 'embed_batch_poll', 'source_sync'
  ));

-- ---------------------------------------------------------------------------
-- visibility (§6.5)
-- ---------------------------------------------------------------------------

-- The single place that answers "what can this portal see".
--
-- Note what it does NOT do: it never filters on client_id. A portal reads its
-- own client's source plus any group sources, and a group source belongs to no
-- single client — so a client_id filter would silently hide exactly the
-- documents group sources exist to share.
CREATE OR REPLACE VIEW public.portal_visible_documents AS
SELECT p.portal_id,
       d.id AS document_id,
       d.client_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.source_id = b.source_id
 WHERE d.deleted_at IS NULL
   AND d.status = 'indexed'
   AND d.sync_status <> 'orphaned'
   AND p.status = 'active';

-- The employee variant: same resolution, but keeps the rows an employee needs in
-- order to fix things — still processing, failed, or orphaned by a removed
-- binding. Client-facing reads must never use this one.
CREATE OR REPLACE VIEW public.portal_documents_admin AS
SELECT p.portal_id,
       d.id AS document_id,
       d.client_id,
       d.status,
       d.sync_status
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.source_id = b.source_id
 WHERE d.deleted_at IS NULL;
