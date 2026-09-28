-- ---------------------------------------------------------------------------
-- 0009 — client-level row-level security (§4.3, step 3 of 3)
--
-- v7 gave org isolation on the seven tables that already had `org_id`. v8 added
-- tenancy columns to the sixteen that did not, and
-- `scripts/backfill-tenancy-columns.mjs` filled them in. This makes them NOT
-- NULL and switches on the policies that actually matter: a client-facing
-- request can only see its own client's rows.
--
-- **Do not apply this before running the backfill for the same stage.** A row
-- whose `org_id` or `client_id` is NULL satisfies no policy, so it would become
-- permanently invisible — the backfill script verifies and refuses to report
-- success while any NULL remains, for exactly this reason.
--
-- ---------------------------------------------------------------------------
-- The two settings, and why they are shaped differently
--
-- `app.org_id` is injected by Gate from the calling token. It cannot be forged:
-- it is a reserved setting that Gate refuses to accept through caller-supplied
-- `rlsContext`. Measured as "u27b70" on this backend's own service token before
-- any of this was written.
--
-- `app.req_client_id` is set by the app, from `lib/request-scope.ts`, and only
-- for the duration of a request whose portal token has been verified. It is a
-- custom key because every name that would be more natural — `client_id`,
-- `portal_id` — is reserved and refused, and the platform's blessed alternative
-- (`trustedRuntimeContext.portalId`) needs `isolated_store.rls.delegate`, which
-- this app does not hold. The documentation is explicit that a custom key here
-- is a reviewed temporary fallback, and that is what it is.
--
-- ---------------------------------------------------------------------------
-- Why an ABSENT client setting permits the whole org, and why that is not a hole
--
-- A large part of this backend is legitimately cross-client: the worker claims
-- whatever ingest job is due, `enqueueDueSources` scans every source, a single
-- embedding batch can carry several clients' chunks, and the alert engine and
-- settings are org-scoped by nature. None of that runs inside a request, so
-- none of it has a client context to offer.
--
-- The alternative — deny when the setting is absent — would stop the worker
-- dead, so the policies below treat "no client context" as org scope. The
-- reason that is defensible rather than a loophole:
--
--   * A client-facing request cannot reach a query without a client context.
--     `resolvePortalContext` is the single place tenancy is decided, it runs
--     before any data access on every such route, and it populates the scope on
--     both the fresh and the cached path. A route that skipped it would have no
--     portal at all and fail earlier, which is what the tenancy suite asserts.
--   * The org branch is still enforced, so nothing can reach another
--     organization's rows even with no client context.
--
-- This is defence in depth beneath the application-level checks, not a
-- replacement for them. The honest summary: **cross-client isolation now has a
-- database-enforced second layer for client-facing reads, and remains
-- application-enforced for anything running outside a request.**
--
-- ---------------------------------------------------------------------------
-- `org_id` gets a DEFAULT rather than sixteen code changes
--
-- `DEFAULT current_setting('app.org_id', true)` means every existing INSERT
-- keeps working untouched and still lands the correct org — one place to be
-- right instead of sixteen places to remember. If the setting were ever absent
-- the default yields NULL, the NOT NULL below rejects the row, and the failure
-- is loud rather than silent.
--
-- `client_id` deliberately gets no such default: it cannot come from
-- `app.req_client_id`, because the worker inserts pages, paragraphs and chunks
-- with no client context at all. Those call sites pass it explicitly.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. defaults, so future inserts fill org_id without code changes
-- ---------------------------------------------------------------------------

ALTER TABLE public.client_settings        ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.client_group_members   ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.documents              ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.document_folders       ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.document_chunks        ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.document_pages         ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.document_paragraphs    ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.chats                  ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.chat_messages          ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.chat_documents         ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.ingest_jobs            ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.embedding_batches      ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.usage_events           ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.rag_traces             ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.portal_source_bindings ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);
ALTER TABLE public.alert_deliveries       ALTER COLUMN org_id SET DEFAULT current_setting('app.org_id', true);

-- ---------------------------------------------------------------------------
-- 2. NOT NULL, now that the backfill has run
-- ---------------------------------------------------------------------------

ALTER TABLE public.client_settings        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.client_group_members   ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.documents              ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.document_folders       ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.document_chunks        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.document_pages         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.document_pages         ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE public.document_paragraphs    ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.document_paragraphs    ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE public.chats                  ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.chat_messages          ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.chat_documents         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.chat_documents         ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE public.ingest_jobs            ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.embedding_batches      ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.usage_events           ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.rag_traces             ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.portal_source_bindings ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.alert_deliveries       ALTER COLUMN org_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. client-scoped policies
--
-- One shape, applied to every table that carries a client. Written out per
-- table rather than generated in a DO block so the policy on any given table is
-- greppable and reviewable on its own.
-- ---------------------------------------------------------------------------

ALTER TABLE public.client_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_settings_tenancy ON public.client_settings FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.client_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_group_members_tenancy ON public.client_group_members FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_tenancy ON public.documents FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.document_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_folders_tenancy ON public.document_folders FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_chunks_tenancy ON public.document_chunks FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.document_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_pages_tenancy ON public.document_pages FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.document_paragraphs ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_paragraphs_tenancy ON public.document_paragraphs FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY chats_tenancy ON public.chats FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_messages_tenancy ON public.chat_messages FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.chat_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_documents_tenancy ON public.chat_documents FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.ingest_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_jobs_tenancy ON public.ingest_jobs FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.embedding_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY embedding_batches_tenancy ON public.embedding_batches FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_events_tenancy ON public.usage_events FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

ALTER TABLE public.rag_traces ENABLE ROW LEVEL SECURITY;
CREATE POLICY rag_traces_tenancy ON public.rag_traces FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

-- ---------------------------------------------------------------------------
-- 4. org-only policies
--
-- These two carry no client of their own. `portal_source_bindings` maps portals
-- to sources — the mapping itself is org configuration, and a client-scoped
-- policy on it would break portal resolution, which has to read the binding
-- *before* any client is known. `alert_deliveries` records how staff were
-- notified, which is not client data.
-- ---------------------------------------------------------------------------

ALTER TABLE public.portal_source_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_source_bindings_org ON public.portal_source_bindings FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR org_id = current_setting('app.org_id', true))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR org_id = current_setting('app.org_id', true));

ALTER TABLE public.alert_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_deliveries_org ON public.alert_deliveries FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR org_id = current_setting('app.org_id', true))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR org_id = current_setting('app.org_id', true));
