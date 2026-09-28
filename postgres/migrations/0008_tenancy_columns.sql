-- ---------------------------------------------------------------------------
-- 0008 — tenancy columns for row-level security (§4.3, step 2 of 3)
--
-- Step 1 (v7) enabled RLS on the seven tables that already carried `org_id`.
-- The tables whose contents a cross-tenant read would actually expose —
-- documents, their extracted text, chat messages — were left out, because they
-- carry no `org_id` at all and the platform's RLS manifest keys every
-- classification on one.
--
-- This migration adds the columns. It deliberately does NOT enable RLS or add
-- policies: the columns are nullable here, they are backfilled by
-- `scripts/backfill-tenancy-columns.mjs`, and only then does v9 make them NOT
-- NULL and switch policies on. Three steps because a policy comparing against
-- a column that is still NULL for every existing row would make every read
-- return nothing — a total outage on a live store — and because `NOT NULL`
-- cannot be added before the data exists.
--
-- Adding `org_id` to a single-organization store looks redundant, and on its
-- own it is: every row here belongs to `u27b70`. It is added because Gate's
-- manifest requires `orgColumn` for any classification other than an explicit
-- exemption, so without it these tables cannot be declared `scoped` on
-- `client_id` — which is the isolation that actually matters.
--
-- `client_id` is added to three tables that lacked it (`document_pages`,
-- `document_paragraphs`, `chat_documents`) so they can be scoped directly
-- rather than through a parent `EXISTS` subquery. That matters for more than
-- tidiness: RLS policy subqueries are themselves evaluated under RLS, so a
-- parent-join policy has to be able to see the parent row, which turns a simple
-- rule into a chain that is easy to get subtly wrong. `document_pages` holds
-- the full extracted text of every document, so it is the last table that
-- should have a clever policy.
--
-- All columns are TEXT/UUID matching their source, and every one gets an index
-- covering what the policies will compare, because a policy predicate runs on
-- every row touched by every query — an unindexed one turns each read into a
-- scan.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- org_id: the column Gate's manifest requires
-- ---------------------------------------------------------------------------

ALTER TABLE public.client_settings        ADD COLUMN org_id TEXT;
ALTER TABLE public.client_group_members   ADD COLUMN org_id TEXT;
ALTER TABLE public.documents              ADD COLUMN org_id TEXT;
ALTER TABLE public.document_folders       ADD COLUMN org_id TEXT;
ALTER TABLE public.document_chunks        ADD COLUMN org_id TEXT;
ALTER TABLE public.document_pages         ADD COLUMN org_id TEXT;
ALTER TABLE public.document_paragraphs    ADD COLUMN org_id TEXT;
ALTER TABLE public.chats                  ADD COLUMN org_id TEXT;
ALTER TABLE public.chat_messages          ADD COLUMN org_id TEXT;
ALTER TABLE public.chat_documents         ADD COLUMN org_id TEXT;
ALTER TABLE public.ingest_jobs            ADD COLUMN org_id TEXT;
ALTER TABLE public.embedding_batches      ADD COLUMN org_id TEXT;
ALTER TABLE public.usage_events           ADD COLUMN org_id TEXT;
ALTER TABLE public.rag_traces             ADD COLUMN org_id TEXT;
ALTER TABLE public.portal_source_bindings ADD COLUMN org_id TEXT;
ALTER TABLE public.alert_deliveries       ADD COLUMN org_id TEXT;

-- ---------------------------------------------------------------------------
-- client_id where it was missing
--
-- Denormalized on purpose. The alternative — a policy that reaches the parent
-- through EXISTS — is evaluated under RLS itself, so it would depend on the
-- current context being able to see the parent row, and these three tables hold
-- or index document text where a subtly wrong policy is least acceptable.
-- ---------------------------------------------------------------------------

ALTER TABLE public.document_pages      ADD COLUMN client_id UUID REFERENCES public.clients (id) ON DELETE CASCADE;
ALTER TABLE public.document_paragraphs ADD COLUMN client_id UUID REFERENCES public.clients (id) ON DELETE CASCADE;
ALTER TABLE public.chat_documents      ADD COLUMN client_id UUID REFERENCES public.clients (id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Indexes covering what the policies compare
--
-- Gate's manifest validation asks for an index on the declared orgColumn, and a
-- composite on (orgColumn, scope column) for each scope. Both matter for more
-- than passing validation: an RLS predicate is evaluated per row, so these are
-- on the hot path of every query against these tables.
-- ---------------------------------------------------------------------------

CREATE INDEX client_settings_org_idx        ON public.client_settings (org_id);
CREATE INDEX client_group_members_org_idx   ON public.client_group_members (org_id);
CREATE INDEX documents_org_client_idx       ON public.documents (org_id, client_id);
CREATE INDEX document_folders_org_client_idx ON public.document_folders (org_id, client_id);
CREATE INDEX document_chunks_org_client_idx ON public.document_chunks (org_id, client_id);
CREATE INDEX document_pages_org_client_idx  ON public.document_pages (org_id, client_id);
CREATE INDEX document_paragraphs_org_client_idx ON public.document_paragraphs (org_id, client_id);
CREATE INDEX chats_org_client_idx           ON public.chats (org_id, client_id);
CREATE INDEX chat_messages_org_client_idx   ON public.chat_messages (org_id, client_id);
CREATE INDEX chat_documents_org_client_idx  ON public.chat_documents (org_id, client_id);
CREATE INDEX ingest_jobs_org_client_idx     ON public.ingest_jobs (org_id, client_id);
CREATE INDEX embedding_batches_org_client_idx ON public.embedding_batches (org_id, client_id);
CREATE INDEX usage_events_org_client_idx    ON public.usage_events (org_id, client_id);
CREATE INDEX rag_traces_org_client_idx      ON public.rag_traces (org_id, client_id);
CREATE INDEX portal_source_bindings_org_idx ON public.portal_source_bindings (org_id);
CREATE INDEX alert_deliveries_org_idx       ON public.alert_deliveries (org_id);
