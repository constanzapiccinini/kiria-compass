-- ---------------------------------------------------------------------------
-- 0013 — libraries: documents that belong to the org, handed to portals
--
-- A library is a named set of documents owned by no portal. Staff upload into it,
-- the pipeline parses, chunks and embeds each document ONCE, and then they tick the
-- portals that receive it. A portal shows the union of its own documents and every
-- library ticked for it.
--
-- The cost argument is the practical one: a library on five portals is embedded
-- once, not five times.
--
-- `document_sources` already carries almost all of this, so it is extended rather
-- than shadowed by a parallel table.
--
-- ---------------------------------------------------------------------------
-- Bindings are the only access mechanism
--
-- Revision 1 of the phase spec added a `source_grants` table for "who holds this
-- library". Revision 2 dropped it, and this migration follows: `portal_source_bindings`
-- already means "this portal reads this source", so a library grant IS that row.
-- Two mechanisms answering one question is how a viewer ends up seeing a document
-- nobody can explain.
--
-- ---------------------------------------------------------------------------
-- Why `library_id` and not the CHECK the spec sketched
--
-- The spec's first draft proposed `CHECK (client_id IS NOT NULL OR source_id IN
-- (SELECT …))` and then said, correctly, not to ship it: Postgres does not allow a
-- subquery in a CHECK and would reject the migration. So ownership is expressed as a
-- column instead — `library_id` naming the owning library — with a constraint that
-- is enforceable:
--
--   CHECK ((client_id IS NULL) <> (library_id IS NULL))
--
-- Exactly one owner, always, checked by the database rather than by convention.
-- `source_id` stays as the sync handle it already was.
--
-- ---------------------------------------------------------------------------
-- SEVEN tables, not four
--
-- The spec named `documents` plus chunks/pages/paragraphs and said to enumerate the
-- rest from 0009 rather than trust its list. Doing that turns up fourteen tables
-- with a client-scoped policy, of which these seven are on the path a library
-- document actually travels:
--
--   documents, document_chunks, document_pages, document_paragraphs
--   ingest_jobs        a parse job for a library document has no portal
--   embedding_batches  a batch of library chunks has no portal
--   usage_events       embedding a library document is an org cost, not a portal's
--
-- `ingest_jobs` is load-bearing: without it a library document cannot be queued at
-- all, so it could never be parsed, and the feature would fail at its first upload
-- rather than at some edge.
--
-- The other seven are deliberately left client-scoped, each decided rather than
-- skipped:
--
--   chats, chat_messages, rag_traces   always belong to whoever asked, even when the
--                                      answer cites a library document
--   chat_documents                     the citation belongs to that chat, so to the
--                                      asking portal's tenant — checked explicitly
--                                      because the spec asked for a decision on it
--   client_settings, client_group_members, document_folders
--                                      per tenant by definition
--
-- `usage_events` staying free of a client for library work is the right accounting
-- too: `monthToDateUsage` filters by client, so nobody is billed for embedding a
-- document five other portals also received.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. a source may now be owned by the org itself
-- ---------------------------------------------------------------------------

ALTER TABLE public.document_sources DROP CONSTRAINT document_sources_kind_check;
ALTER TABLE public.document_sources ADD CONSTRAINT document_sources_kind_check
  CHECK (kind IN ('compasses_table', 'app_upload', 'library'));

-- `IF EXISTS` because this one is an inline column CHECK from 0004 and its name is
-- assigned by Postgres, not written down anywhere.
ALTER TABLE public.document_sources DROP CONSTRAINT IF EXISTS document_sources_owner_kind_check;
ALTER TABLE public.document_sources ADD CONSTRAINT document_sources_owner_kind_check
  CHECK (owner_kind IN ('client', 'group', 'library'));

ALTER TABLE public.document_sources DROP CONSTRAINT document_sources_owner_check;
ALTER TABLE public.document_sources ADD CONSTRAINT document_sources_owner_check CHECK (
  (owner_kind = 'client'  AND client_id IS NOT NULL AND group_id IS NULL) OR
  (owner_kind = 'group'   AND group_id  IS NOT NULL AND client_id IS NULL) OR
  (owner_kind = 'library' AND client_id IS NULL     AND group_id IS NULL)
);

ALTER TABLE public.document_sources
  ADD COLUMN description TEXT,
  -- The column a helper already assumed existed and shipped a 500 to production
  -- for. Adding it now makes that assumption true instead of merely repaired.
  ADD COLUMN archived_at TIMESTAMPTZ;

-- Pickers and the sync scheduler both filter on this.
CREATE INDEX document_sources_active_idx
  ON public.document_sources (org_id, kind)
  WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. the seven tables gain an owner that may be a library
--
-- Order matters per table: the column is added, then `client_id` is relaxed, then
-- the constraint is added last. Every existing row has a client and no library, so
-- the constraint is satisfied the moment it is created and no backfill is needed.
--
-- `ON DELETE RESTRICT` is deliberate and is the difference from an earlier draft
-- that used CASCADE: deleting a library must be REFUSED while documents exist, not
-- silently take them with it. A viewer's document list emptying with no trace is the
-- worst failure this app can produce.
-- ---------------------------------------------------------------------------

ALTER TABLE public.documents
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE RESTRICT;
ALTER TABLE public.documents ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.documents ADD CONSTRAINT documents_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

ALTER TABLE public.document_chunks
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE RESTRICT;
ALTER TABLE public.document_chunks ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.document_chunks ADD CONSTRAINT document_chunks_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

ALTER TABLE public.document_pages
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE RESTRICT;
ALTER TABLE public.document_pages ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.document_pages ADD CONSTRAINT document_pages_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

ALTER TABLE public.document_paragraphs
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE RESTRICT;
ALTER TABLE public.document_paragraphs ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.document_paragraphs ADD CONSTRAINT document_paragraphs_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

ALTER TABLE public.ingest_jobs
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE RESTRICT;
ALTER TABLE public.ingest_jobs ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.ingest_jobs ADD CONSTRAINT ingest_jobs_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

ALTER TABLE public.embedding_batches
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE RESTRICT;
ALTER TABLE public.embedding_batches ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.embedding_batches ADD CONSTRAINT embedding_batches_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

ALTER TABLE public.usage_events
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE RESTRICT;
ALTER TABLE public.usage_events ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

-- ---------------------------------------------------------------------------
-- 3. indexes for the library path
--
-- The existing composites are (org_id, client_id), which a library row cannot use
-- because its client is NULL. Partial on the library rows only: they are the
-- minority and this keeps the indexes small.
-- ---------------------------------------------------------------------------

CREATE INDEX documents_library_idx
  ON public.documents (org_id, library_id) WHERE library_id IS NOT NULL;
CREATE INDEX document_chunks_library_idx
  ON public.document_chunks (org_id, library_id) WHERE library_id IS NOT NULL;
CREATE INDEX document_pages_library_idx
  ON public.document_pages (org_id, library_id) WHERE library_id IS NOT NULL;
CREATE INDEX document_paragraphs_library_idx
  ON public.document_paragraphs (org_id, library_id) WHERE library_id IS NOT NULL;
CREATE INDEX ingest_jobs_library_idx
  ON public.ingest_jobs (org_id, library_id) WHERE library_id IS NOT NULL;
CREATE INDEX embedding_batches_library_idx
  ON public.embedding_batches (org_id, library_id) WHERE library_id IS NOT NULL;
CREATE INDEX usage_events_library_idx
  ON public.usage_events (org_id, library_id) WHERE library_id IS NOT NULL;
