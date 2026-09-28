-- ---------------------------------------------------------------------------
-- 0019 — prune what 6A stopped writing (§6B)
--
-- 6A removed the table-source feature: the readers, the config parser, the sync
-- scheduler, the `source_sync` job kind, both screens, and the `app_upload` source
-- that every portal used to get. This drops the columns that machinery owned.
--
-- **Deliberately a separate release from 6A**, which is the one rule §6B states
-- outright: do not prune columns in the same release that stops writing them. If 6A
-- had been wrong about something, the columns were still there to roll back into.
-- 6A shipped and has been serving; this is the next release.
--
-- ---------------------------------------------------------------------------
-- Run `scripts/prune-6b-preflight.mjs` first
--
-- Three of the changes below are validated against existing rows and will FAIL
-- without it — a CHECK constraint is checked against the table as it is, not only
-- against future writes:
--
--   * `kind` narrowed to 'library'      — six archived `app_upload` rows exist
--   * `owner_kind` narrowed to 'library' — those six carry owner_kind = 'client'
--   * `source_sync` removed from the ingest_jobs kind check — eleven completed sync
--     jobs are still in the queue table
--
-- The apply is transactional, so forgetting costs a confusing error rather than a
-- half-pruned schema. The preflight also normalises `retrieval_mode` (Phase 7 §5) and
-- measures the per-portal visible count before and after, because that number is the
-- one that is the product.
--
-- ---------------------------------------------------------------------------
-- What is deliberately KEPT
--
--   * `client_id` on every table, and its RLS policies. Every row will be NULL, and
--     they still stay: they are the second half of the tenancy guard, they cost
--     nothing, and unwinding them is a separate decision with its own risk. §6B says
--     this explicitly and it is worth repeating where someone would otherwise "finish
--     the job".
--   * `documents.source_id`, and 0018's constraint on it. A tenant-owned document is
--     still reachable through a source in principle; the column is the second arm of
--     both visibility views and dropping it is a model change, not a prune.
--   * `documents.source_kind` — a DIFFERENT column: 'native' | 'ocr' | 'hybrid', how
--     the text was extracted. Nothing to do with sync sources despite the name.
--   * `description` and `archived_at` on `document_sources`, per §6B.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. the views come first
--
-- Both `portal_visible_documents` and `portal_documents_admin` select
-- `d.sync_status`, and a column cannot be dropped while a view depends on it. They
-- are recreated here without it — `CREATE OR REPLACE VIEW` cannot change a view's
-- column list, so the client-facing one is dropped and rebuilt.
--
-- The `sync_status <> 'orphaned'` filter goes with the column. It was the mechanism
-- by which a document whose source row vanished stopped being visible without being
-- destroyed. Nothing writes `sync_status` any more: the source sync was its only
-- writer, and a library document cannot be orphaned that way — `documents.library_id`
-- is ON DELETE RESTRICT, so the library cannot disappear from under it. Every row in
-- both stages reads 'managed'.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.portal_visible_documents;
CREATE VIEW public.portal_visible_documents AS
SELECT p.portal_id,
       d.id AS document_id,
       d.client_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.source_id = b.source_id
 WHERE d.deleted_at IS NULL
   AND d.status = 'indexed'
   AND p.status = 'active'
UNION ALL
SELECT p.portal_id,
       d.id AS document_id,
       d.client_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.library_id = b.source_id
 WHERE d.deleted_at IS NULL
   AND d.status = 'indexed'
   AND p.status = 'active';

COMMENT ON VIEW public.portal_visible_documents IS
  'What a client can see: indexed, not deleted, reached through a binding on either '
  'its source or its library, in an active portal. The two arms are disjoint because '
  '0018 forbids a document from carrying both a library and a source.';

DROP VIEW IF EXISTS public.portal_documents_admin;
CREATE VIEW public.portal_documents_admin AS
SELECT p.portal_id,
       d.id AS document_id,
       d.client_id,
       d.status,
       NULL::UUID AS library_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.source_id = b.source_id
 WHERE d.deleted_at IS NULL
UNION ALL
-- `library_id` is carried here so the admin preview can say HOW a document reached a
-- portal (§5B.6). Without it the screen can list forty documents and explain none.
SELECT p.portal_id,
       d.id AS document_id,
       d.client_id,
       d.status,
       d.library_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.library_id = b.source_id
 WHERE d.deleted_at IS NULL;

COMMENT ON VIEW public.portal_documents_admin IS
  'The employee variant: same resolution, but keeps the rows an employee needs in '
  'order to fix things — still processing, or failed. Client-facing reads must never '
  'use this one.';

-- ---------------------------------------------------------------------------
-- 2. document_sources — the sync machinery
--
-- `document_sources_due_idx` is on (sync_enabled, status, last_sync_at) and goes with
-- them. It was the index the scheduler scanned to find sources due for a poll, and
-- there is no scheduler.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS public.document_sources_due_idx;

ALTER TABLE public.document_sources
  DROP COLUMN IF EXISTS sync_enabled,
  DROP COLUMN IF EXISTS sync_interval_minutes,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS last_sync_at,
  DROP COLUMN IF EXISTS last_success_at,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS sync_cursor;

-- ---------------------------------------------------------------------------
-- 3. document_sources — collapse kind and owner_kind to 'library'
--
-- The defaults are set alongside the constraints so an insert that omits either
-- column is correct rather than merely refused. Both app backends write them
-- explicitly and will keep doing so; the default is for the operator scripts and for
-- whoever writes the next one.
--
-- `document_sources_owner_check` coupled `owner_kind` to `client_id` / `group_id`.
-- With only 'library' left, the whole condition collapses to "neither is set", which
-- is what a library is. `group_id` itself stays: `owner_kind = 'group'` was refused at
-- the API in §5B and no row ever used it, but dropping the column is a schema change
-- with no benefit here.
-- ---------------------------------------------------------------------------

ALTER TABLE public.document_sources
  DROP CONSTRAINT IF EXISTS document_sources_kind_check,
  DROP CONSTRAINT IF EXISTS document_sources_owner_kind_check,
  DROP CONSTRAINT IF EXISTS document_sources_owner_check;

ALTER TABLE public.document_sources
  ALTER COLUMN kind SET DEFAULT 'library',
  ALTER COLUMN owner_kind SET DEFAULT 'library';

ALTER TABLE public.document_sources
  ADD CONSTRAINT document_sources_kind_check CHECK (kind = 'library'),
  ADD CONSTRAINT document_sources_owner_kind_check CHECK (owner_kind = 'library'),
  ADD CONSTRAINT document_sources_owner_check
    CHECK (client_id IS NULL AND group_id IS NULL);

COMMENT ON COLUMN public.document_sources.kind IS
  'Always ''library''. The other two kinds — app_upload and compasses_table — were '
  'removed in Phase 6: a library is the only way a document enters the system.';

-- ---------------------------------------------------------------------------
-- 4. documents — the sync columns
--
-- `documents_source_external_key` is the unique index on (source_id, external_id)
-- that made a sync idempotent: the same external row re-imported found its existing
-- document instead of creating a second. It goes with `external_id`.
--
-- `folder_pinned` said "a person filed this, do not let the next sync move it". With
-- no sync there is nothing to defend the folder against.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS public.documents_source_external_key;

ALTER TABLE public.documents
  DROP CONSTRAINT IF EXISTS documents_sync_status_check;

ALTER TABLE public.documents
  DROP COLUMN IF EXISTS external_id,
  DROP COLUMN IF EXISTS external_updated_at,
  DROP COLUMN IF EXISTS folder_pinned,
  DROP COLUMN IF EXISTS sync_status;

-- ---------------------------------------------------------------------------
-- 5. ingest_jobs — 'source_sync' is not a kind any more
--
-- The worker's dispatch branch for it is gone, so a queued one would fail with
-- "Unknown job kind" on the next drain. The preflight removes the completed rows;
-- this stops new ones being written at all.
-- ---------------------------------------------------------------------------

ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT IF EXISTS ingest_jobs_kind_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_kind_check
    CHECK (kind IN ('parse', 'ocr', 'embed', 'reindex', 'delete', 'embed_batch_poll'));
