-- Compass AI (compasses) - Phase 1 schema
-- Document analysis / RAG with mandatory citations.
--
-- Platform constraints that shaped this schema:
--   * pgvector is NOT available on this managed host (the azure.extensions
--     allow-list is empty and the runtime role is not azure_pg_admin), so
--     embeddings are stored as DOUBLE PRECISION[] and scored with an in-database
--     dot product. Vectors are stored unit-normalized, so dot product == cosine.
--   * Full-text search uses the built-in tsvector machinery (no pg_trgm).
--   * gen_random_uuid() is PostgreSQL core on 13+; pgcrypto is not required.

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

-- Dot product of two equal-length vectors. Embeddings are stored unit-normalized,
-- so this is the cosine similarity. STRICT => NULL when either side is NULL.
CREATE OR REPLACE FUNCTION public.vec_dot(a DOUBLE PRECISION[], b DOUBLE PRECISION[])
RETURNS DOUBLE PRECISION
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $fn$
  SELECT COALESCE(SUM(x * y), 0)::DOUBLE PRECISION FROM unnest(a, b) AS t(x, y)
$fn$;

-- ---------------------------------------------------------------------------
-- workspaces, membership, settings
-- ---------------------------------------------------------------------------

CREATE TABLE public.workspaces (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             TEXT NOT NULL,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  retention_days     INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_org_slug_key UNIQUE (org_id, slug),
  CONSTRAINT workspaces_retention_days_check CHECK (retention_days IS NULL OR retention_days > 0)
);

CREATE INDEX workspaces_org_id_idx ON public.workspaces (org_id);

CREATE TRIGGER workspaces_touch_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.workspace_members (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL,
  email              TEXT,
  role               TEXT NOT NULL,
  invited_by_user_id TEXT,
  invited_at         TIMESTAMPTZ,
  accepted_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_members_workspace_user_key UNIQUE (workspace_id, user_id),
  CONSTRAINT workspace_members_role_check CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);

CREATE INDEX workspace_members_user_id_idx ON public.workspace_members (user_id);

CREATE TRIGGER workspace_members_touch_updated_at
  BEFORE UPDATE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.workspace_settings (
  workspace_id             UUID PRIMARY KEY REFERENCES public.workspaces (id) ON DELETE CASCADE,
  retrieval_mode           TEXT NOT NULL DEFAULT 'precision',
  max_answer_tokens        INTEGER NOT NULL DEFAULT 800,
  max_retrieved_tokens     INTEGER NOT NULL DEFAULT 1500,
  max_ocr_pages_per_upload INTEGER NOT NULL DEFAULT 10000,
  monthly_token_budget     BIGINT,
  monthly_ocr_page_budget  INTEGER,
  ocr_tables_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  ocr_forms_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  ocr_queries_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_settings_retrieval_mode_check CHECK (retrieval_mode IN ('economy', 'precision')),
  CONSTRAINT workspace_settings_answer_tokens_check CHECK (max_answer_tokens BETWEEN 64 AND 4096),
  CONSTRAINT workspace_settings_retrieved_tokens_check CHECK (max_retrieved_tokens BETWEEN 256 AND 32768),
  CONSTRAINT workspace_settings_ocr_pages_check CHECK (max_ocr_pages_per_upload > 0)
);

CREATE TRIGGER workspace_settings_touch_updated_at
  BEFORE UPDATE ON public.workspace_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- documents and extracted structure
-- ---------------------------------------------------------------------------

CREATE TABLE public.documents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  stored_file_uuid       TEXT,
  read_url               TEXT,
  content_type           TEXT NOT NULL DEFAULT 'application/pdf',
  content_sha256         TEXT NOT NULL,
  byte_size              BIGINT NOT NULL DEFAULT 0,
  page_count             INTEGER,
  version                INTEGER NOT NULL DEFAULT 1,
  supersedes_document_id UUID REFERENCES public.documents (id) ON DELETE SET NULL,
  source_kind            TEXT NOT NULL DEFAULT 'native',
  needs_ocr              BOOLEAN NOT NULL DEFAULT FALSE,
  status                 TEXT NOT NULL DEFAULT 'queued',
  status_detail          TEXT,
  error_message          TEXT,
  ocr_pages_used         INTEGER NOT NULL DEFAULT 0,
  chunk_count            INTEGER NOT NULL DEFAULT 0,
  uploaded_by_user_id    TEXT NOT NULL,
  indexed_at             TIMESTAMPTZ,
  deleted_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documents_source_kind_check CHECK (source_kind IN ('native', 'ocr', 'hybrid')),
  CONSTRAINT documents_status_check CHECK (status IN (
    'queued', 'uploading', 'ocr', 'parsed', 'embedding', 'indexed', 'failed', 'deleted'
  )),
  CONSTRAINT documents_version_check CHECK (version > 0)
);

CREATE INDEX documents_workspace_id_idx ON public.documents (workspace_id);
CREATE INDEX documents_status_idx ON public.documents (status);

-- Deduplication: at most one live document per (workspace, content hash).
CREATE UNIQUE INDEX documents_workspace_content_live_key
  ON public.documents (workspace_id, content_sha256)
  WHERE status <> 'deleted';

CREATE TRIGGER documents_touch_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.document_pages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    UUID NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
  page_number    INTEGER NOT NULL,
  text           TEXT NOT NULL DEFAULT '',
  char_count     INTEGER NOT NULL DEFAULT 0,
  extracted_by   TEXT NOT NULL DEFAULT 'pdf_text',
  ocr_confidence REAL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_pages_document_page_key UNIQUE (document_id, page_number),
  CONSTRAINT document_pages_page_number_check CHECK (page_number > 0),
  CONSTRAINT document_pages_extracted_by_check CHECK (extracted_by IN ('pdf_text', 'textract'))
);

-- Stable paragraph identity so a citation can highlight an exact region.
CREATE TABLE public.document_paragraphs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
  page_number     INTEGER NOT NULL,
  paragraph_index INTEGER NOT NULL,
  paragraph_key   TEXT NOT NULL,
  text            TEXT NOT NULL,
  bbox            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_paragraphs_key_key UNIQUE (document_id, paragraph_key),
  CONSTRAINT document_paragraphs_page_number_check CHECK (page_number > 0)
);

CREATE INDEX document_paragraphs_document_page_idx
  ON public.document_paragraphs (document_id, page_number);

-- ---------------------------------------------------------------------------
-- chunks + embeddings (the retrieval index)
-- ---------------------------------------------------------------------------

CREATE TABLE public.document_chunks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  document_id         UUID NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
  chunk_index         INTEGER NOT NULL,
  page_number         INTEGER NOT NULL,
  page_start          INTEGER NOT NULL,
  page_end            INTEGER NOT NULL,
  paragraph_key       TEXT,
  paragraph_keys      TEXT[] NOT NULL DEFAULT '{}',
  section_title       TEXT,
  text                TEXT NOT NULL,
  token_count         INTEGER NOT NULL DEFAULT 0,
  content_sha256      TEXT NOT NULL,
  embedding           DOUBLE PRECISION[],
  embedding_model     TEXT,
  embedding_dims      INTEGER,
  fts                 TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_chunks_document_index_key UNIQUE (document_id, chunk_index),
  CONSTRAINT document_chunks_page_range_check CHECK (page_start <= page_end AND page_start > 0)
);

CREATE INDEX document_chunks_workspace_idx ON public.document_chunks (workspace_id);
CREATE INDEX document_chunks_document_idx ON public.document_chunks (document_id);
CREATE INDEX document_chunks_fts_idx ON public.document_chunks USING GIN (fts);

-- Only embedded chunks are retrievable; keeps the scored sequential scan tight.
CREATE INDEX document_chunks_embedded_idx
  ON public.document_chunks (workspace_id, document_id)
  WHERE embedding IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ingest pipeline (queue + retry)
-- ---------------------------------------------------------------------------

CREATE TABLE public.ingest_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  document_id  UUID REFERENCES public.documents (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by    TEXT,
  locked_at    TIMESTAMPTZ,
  last_error   TEXT,
  payload      JSONB NOT NULL DEFAULT '{}'::JSONB,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ingest_jobs_kind_check CHECK (kind IN ('parse', 'ocr', 'embed', 'reindex', 'delete')),
  CONSTRAINT ingest_jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE INDEX ingest_jobs_claim_idx ON public.ingest_jobs (status, next_run_at);
CREATE INDEX ingest_jobs_document_idx ON public.ingest_jobs (document_id);

CREATE TRIGGER ingest_jobs_touch_updated_at
  BEFORE UPDATE ON public.ingest_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- chat sessions
-- ---------------------------------------------------------------------------

CREATE TABLE public.chats (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  title              TEXT NOT NULL DEFAULT 'New chat',
  retrieval_mode     TEXT NOT NULL DEFAULT 'precision',
  created_by_user_id TEXT NOT NULL,
  last_message_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chats_retrieval_mode_check CHECK (retrieval_mode IN ('economy', 'precision'))
);

CREATE INDEX chats_workspace_idx ON public.chats (workspace_id, created_at DESC);

CREATE TRIGGER chats_touch_updated_at
  BEFORE UPDATE ON public.chats
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.chat_documents (
  chat_id     UUID NOT NULL REFERENCES public.chats (id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, document_id)
);

CREATE TABLE public.chat_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id             UUID NOT NULL REFERENCES public.chats (id) ON DELETE CASCADE,
  workspace_id        UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  role                TEXT NOT NULL,
  content             TEXT NOT NULL,
  citations           JSONB NOT NULL DEFAULT '[]'::JSONB,
  retrieved_chunk_ids UUID[] NOT NULL DEFAULT '{}',
  grounded            BOOLEAN,
  model               TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  latency_ms          INTEGER,
  truncated           BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_role_check CHECK (role IN ('user', 'assistant', 'system'))
);

CREATE INDEX chat_messages_chat_idx ON public.chat_messages (chat_id, created_at);

-- ---------------------------------------------------------------------------
-- observability: usage metering, audit log, rag traces
-- ---------------------------------------------------------------------------

CREATE TABLE public.usage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  user_id       TEXT,
  kind          TEXT NOT NULL,
  model         TEXT,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  ocr_pages     INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0,
  document_id   UUID,
  chat_id       UUID,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_kind_check CHECK (kind IN ('embedding', 'chat_completion', 'ocr', 'rerank'))
);

CREATE INDEX usage_events_workspace_created_idx ON public.usage_events (workspace_id, created_at DESC);

CREATE TABLE public.audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL,
  workspace_id  UUID,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  ip            TEXT,
  user_agent    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_workspace_created_idx ON public.audit_logs (workspace_id, created_at DESC);
CREATE INDEX audit_logs_org_created_idx ON public.audit_logs (org_id, created_at DESC);

CREATE TABLE public.rag_traces (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  chat_id      UUID,
  message_id   UUID,
  step         TEXT NOT NULL,
  duration_ms  INTEGER,
  detail       JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rag_traces_step_check CHECK (step IN (
    'embed_query', 'retrieve', 'rerank', 'generate', 'ingest'
  ))
);

CREATE INDEX rag_traces_workspace_created_idx ON public.rag_traces (workspace_id, created_at DESC);
