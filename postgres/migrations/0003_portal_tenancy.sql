-- Compass AI - Phase 4A: portal tenancy and the two-role model
--
-- Replaces self-service workspaces with KIRIA-managed clients, one per client
-- engagement, reached through a FuseBase portal embed.
--
-- Three things happen here, in one migration so no query is ever half-renamed:
--   1. `workspaces` becomes `clients`, and `workspace_id` becomes `client_id`
--      on every child table, with indexes and constraints renamed to match.
--   2. `workspace_members` is DROPPED. Roles are no longer stored: an actor is
--      derived per request from the portal context and the caller's org role
--      (employee vs client). Membership lives in the portal, not in our schema.
--   3. New tenancy tables: `client_groups`, `client_group_members`, `portals`.
--
-- `portals.portal_id` unique per org is the whole tenancy join: a verified portal
-- token yields a portal id, that row yields the client id, and every client-facing
-- query is filtered by it.

-- ---------------------------------------------------------------------------
-- 0. drop the dependent view; recreated against client_id at the end
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.document_index_health;

-- ---------------------------------------------------------------------------
-- 1. workspaces -> clients
-- ---------------------------------------------------------------------------

ALTER TABLE public.workspaces RENAME TO clients;

ALTER TABLE public.clients RENAME CONSTRAINT workspaces_pkey TO clients_pkey;
ALTER TABLE public.clients RENAME CONSTRAINT workspaces_org_slug_key TO clients_org_slug_key;
ALTER TABLE public.clients
  RENAME CONSTRAINT workspaces_retention_days_check TO clients_retention_days_check;

ALTER INDEX public.workspaces_org_id_idx RENAME TO clients_org_id_idx;

ALTER TRIGGER workspaces_touch_updated_at ON public.clients
  RENAME TO clients_touch_updated_at;

-- `created_by_user_id` stays, but only as provenance: it no longer confers ownership.
COMMENT ON COLUMN public.clients.created_by_user_id IS
  'Employee who created the client. Provenance only - confers no permission.';

ALTER TABLE public.clients
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN notes TEXT;

ALTER TABLE public.clients
  ADD CONSTRAINT clients_status_check CHECK (status IN ('active', 'paused', 'archived'));

-- ---------------------------------------------------------------------------
-- 2. workspace_settings -> client_settings
-- ---------------------------------------------------------------------------

ALTER TABLE public.workspace_settings RENAME TO client_settings;
ALTER TABLE public.client_settings RENAME COLUMN workspace_id TO client_id;

ALTER TABLE public.client_settings RENAME CONSTRAINT workspace_settings_pkey TO client_settings_pkey;
ALTER TABLE public.client_settings
  RENAME CONSTRAINT workspace_settings_workspace_id_fkey TO client_settings_client_id_fkey;
ALTER TABLE public.client_settings
  RENAME CONSTRAINT workspace_settings_retrieval_mode_check TO client_settings_retrieval_mode_check;
ALTER TABLE public.client_settings
  RENAME CONSTRAINT workspace_settings_answer_tokens_check TO client_settings_answer_tokens_check;
ALTER TABLE public.client_settings
  RENAME CONSTRAINT workspace_settings_retrieved_tokens_check TO client_settings_retrieved_tokens_check;
ALTER TABLE public.client_settings
  RENAME CONSTRAINT workspace_settings_ocr_pages_check TO client_settings_ocr_pages_check;
ALTER TABLE public.client_settings
  RENAME CONSTRAINT workspace_settings_batch_min_chunks_check TO client_settings_batch_min_chunks_check;

ALTER TRIGGER workspace_settings_touch_updated_at ON public.client_settings
  RENAME TO client_settings_touch_updated_at;

-- ---------------------------------------------------------------------------
-- 3. workspace_id -> client_id on every child table
-- ---------------------------------------------------------------------------

ALTER TABLE public.documents RENAME COLUMN workspace_id TO client_id;
ALTER TABLE public.documents
  RENAME CONSTRAINT documents_workspace_id_fkey TO documents_client_id_fkey;
ALTER INDEX public.documents_workspace_id_idx RENAME TO documents_client_id_idx;
ALTER INDEX public.documents_workspace_content_live_key RENAME TO documents_client_content_live_key;

ALTER TABLE public.document_chunks RENAME COLUMN workspace_id TO client_id;
ALTER TABLE public.document_chunks
  RENAME CONSTRAINT document_chunks_workspace_id_fkey TO document_chunks_client_id_fkey;
ALTER INDEX public.document_chunks_workspace_idx RENAME TO document_chunks_client_idx;

ALTER TABLE public.ingest_jobs RENAME COLUMN workspace_id TO client_id;
ALTER TABLE public.ingest_jobs
  RENAME CONSTRAINT ingest_jobs_workspace_id_fkey TO ingest_jobs_client_id_fkey;

ALTER TABLE public.chats RENAME COLUMN workspace_id TO client_id;
ALTER TABLE public.chats RENAME CONSTRAINT chats_workspace_id_fkey TO chats_client_id_fkey;
ALTER INDEX public.chats_workspace_idx RENAME TO chats_client_idx;

ALTER TABLE public.chat_messages RENAME COLUMN workspace_id TO client_id;
ALTER TABLE public.chat_messages
  RENAME CONSTRAINT chat_messages_workspace_id_fkey TO chat_messages_client_id_fkey;

ALTER TABLE public.usage_events RENAME COLUMN workspace_id TO client_id;
ALTER TABLE public.usage_events
  RENAME CONSTRAINT usage_events_workspace_id_fkey TO usage_events_client_id_fkey;
ALTER INDEX public.usage_events_workspace_created_idx RENAME TO usage_events_client_created_idx;

ALTER TABLE public.audit_logs RENAME COLUMN workspace_id TO client_id;
ALTER INDEX public.audit_logs_workspace_created_idx RENAME TO audit_logs_client_created_idx;

ALTER TABLE public.rag_traces RENAME COLUMN workspace_id TO client_id;
ALTER INDEX public.rag_traces_workspace_created_idx RENAME TO rag_traces_client_created_idx;

ALTER TABLE public.embedding_batches RENAME COLUMN workspace_id TO client_id;
ALTER TABLE public.embedding_batches
  RENAME CONSTRAINT embedding_batches_workspace_id_fkey TO embedding_batches_client_id_fkey;
ALTER INDEX public.embedding_batches_workspace_idx RENAME TO embedding_batches_client_idx;

-- `document_chunks_embedded_idx` is defined over (workspace_id, document_id); the
-- column rename follows it automatically, so only the name needs updating.
ALTER INDEX public.document_chunks_embedded_idx RENAME TO document_chunks_embedded_client_idx;

-- ---------------------------------------------------------------------------
-- 4. stored roles are gone
-- ---------------------------------------------------------------------------

-- An actor is derived per request: portal context + org role => employee | client.
-- Nothing role-shaped is stored, so nothing role-shaped can drift from the truth.
DROP TABLE public.workspace_members;

-- ---------------------------------------------------------------------------
-- 5. new tenancy tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.client_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_groups_name_key UNIQUE (org_id, name)
);

CREATE TRIGGER client_groups_touch_updated_at
  BEFORE UPDATE ON public.client_groups
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.client_group_members (
  group_id  UUID NOT NULL REFERENCES public.client_groups (id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, client_id)
);

CREATE INDEX client_group_members_client_idx ON public.client_group_members (client_id);

CREATE TABLE public.portals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            TEXT NOT NULL,
  -- Platform portal global id, as returned by a verified portalFeatureContextToken.
  portal_id         TEXT NOT NULL,
  -- Platform workspace behind the portal; used only for Gate membership calls.
  workspace_id      TEXT,
  client_id         UUID NOT NULL REFERENCES public.clients (id) ON DELETE RESTRICT,
  label             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  -- Highest-precedence settings layer: portal -> client -> app defaults -> code.
  settings_override JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT portals_portal_id_key UNIQUE (org_id, portal_id),
  CONSTRAINT portals_status_check CHECK (status IN ('active', 'paused'))
);

CREATE INDEX portals_client_idx ON public.portals (client_id);

CREATE TRIGGER portals_touch_updated_at
  BEFORE UPDATE ON public.portals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 6. observability: the portal resolution step is measurable
-- ---------------------------------------------------------------------------

ALTER TABLE public.rag_traces DROP CONSTRAINT rag_traces_step_check;

ALTER TABLE public.rag_traces
  ADD CONSTRAINT rag_traces_step_check CHECK (step IN (
    'embed_query', 'retrieve', 'rerank', 'generate', 'ingest', 'resolve_portal'
  ));

-- ---------------------------------------------------------------------------
-- 7. recreate the health view against client_id
-- ---------------------------------------------------------------------------

CREATE VIEW public.document_index_health AS
SELECT
  d.client_id,
  d.id                AS document_id,
  d.name,
  d.status,
  d.status_detail,
  d.error_message,
  d.page_count,
  d.chunk_count,
  d.source_kind,
  d.needs_ocr,
  d.created_at,
  d.indexed_at,
  COUNT(c.id)                                        AS chunks_present,
  COUNT(c.id) FILTER (WHERE c.embedding IS NOT NULL) AS chunks_embedded
FROM public.documents d
LEFT JOIN public.document_chunks c ON c.document_id = d.id
WHERE d.status <> 'deleted'
GROUP BY d.id;
