-- Compass AI - Phase 3: batch embeddings and indexing observability
--
-- Bulk ingest can use the OpenAI Batch API, which is roughly half the price of the
-- synchronous embeddings endpoint but may take up to 24 hours. That changes the
-- pipeline shape: chunks are written first with a NULL embedding, the batch is
-- submitted with each chunk id as its custom_id, and the vectors are filled in when
-- the batch completes.
--
-- `document_chunks.embedding` was already nullable and every retrieval query already
-- filters on `embedding IS NOT NULL`, so a document mid-batch simply contributes
-- nothing to retrieval rather than returning unembedded passages.

CREATE TABLE public.embedding_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  -- OpenAI's batch id. Unique so a poll can never process one batch twice.
  provider_batch_id TEXT NOT NULL,
  input_file_id     TEXT,
  output_file_id    TEXT,
  error_file_id     TEXT,
  status            TEXT NOT NULL DEFAULT 'submitted',
  model             TEXT NOT NULL,
  dimensions        INTEGER NOT NULL,
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  embedded_count    INTEGER NOT NULL DEFAULT 0,
  -- Documents whose chunks are in this batch; a batch may span several uploads.
  document_ids      UUID[] NOT NULL DEFAULT '{}',
  request_counts    JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_error        TEXT,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT embedding_batches_provider_id_key UNIQUE (provider_batch_id),
  CONSTRAINT embedding_batches_status_check CHECK (status IN (
    'submitted', 'validating', 'in_progress', 'finalizing',
    'completed', 'failed', 'expired', 'cancelled'
  )),
  CONSTRAINT embedding_batches_counts_check CHECK (embedded_count >= 0 AND chunk_count >= 0)
);

CREATE INDEX embedding_batches_workspace_idx
  ON public.embedding_batches (workspace_id, created_at DESC);

-- The poller claims work by status, so keep the open ones cheap to find.
CREATE INDEX embedding_batches_open_idx
  ON public.embedding_batches (status, submitted_at)
  WHERE status NOT IN ('completed', 'failed', 'expired', 'cancelled');

CREATE TRIGGER embedding_batches_touch_updated_at
  BEFORE UPDATE ON public.embedding_batches
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- pipeline support
-- ---------------------------------------------------------------------------

-- A new job kind polls an open batch and applies its results.
ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT ingest_jobs_kind_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_kind_check CHECK (kind IN (
    'parse', 'ocr', 'embed', 'reindex', 'delete', 'embed_batch_poll'
  ));

-- Link a chunk back to the batch that will fill in its vector, so a stuck or failed
-- batch can be traced from either direction.
ALTER TABLE public.document_chunks
  ADD COLUMN embedding_batch_id UUID REFERENCES public.embedding_batches (id) ON DELETE SET NULL;

CREATE INDEX document_chunks_pending_batch_idx
  ON public.document_chunks (embedding_batch_id)
  WHERE embedding IS NULL;

-- ---------------------------------------------------------------------------
-- workspace controls
-- ---------------------------------------------------------------------------

ALTER TABLE public.workspace_settings
  ADD COLUMN batch_embedding_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Below this many chunks the synchronous endpoint is used: a small upload should be
-- searchable in seconds, not in up to 24 hours, and the saving would be trivial.
ALTER TABLE public.workspace_settings
  ADD COLUMN batch_embedding_min_chunks INTEGER NOT NULL DEFAULT 400;

ALTER TABLE public.workspace_settings
  ADD CONSTRAINT workspace_settings_batch_min_chunks_check
  CHECK (batch_embedding_min_chunks BETWEEN 1 AND 1000000);

-- ---------------------------------------------------------------------------
-- indexing observability
-- ---------------------------------------------------------------------------

-- Documents needing attention, for the indexing dashboard. A view keeps the
-- aggregation in one place rather than duplicated across queries.
CREATE VIEW public.document_index_health AS
SELECT
  d.workspace_id,
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
