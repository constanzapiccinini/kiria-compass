-- ---------------------------------------------------------------------------
-- 0014 — a portal scope may read the libraries ticked for it
--
-- After 0013 a library document has `client_id IS NULL`, and every client-scoped
-- policy from 0009 reads `client_id::text = current_setting('app.req_client_id')`.
-- NULL is not equal to anything, so a portal scope currently sees **nothing** of a
-- library it was granted. This adds the one missing clause.
--
-- ---------------------------------------------------------------------------
-- Why a SECURITY DEFINER helper and not a subquery in the policy
--
-- The grant lives in `portal_source_bindings` joined to `portals`, and both carry
-- their own RLS. A subquery written inline in the policy would be evaluated under
-- the *caller's* privileges, so a portal scope would have to be able to read the
-- bindings table to find out what it may read — which either fails or forces the
-- bindings open to every tenant.
--
-- The function is owned by `isolated_pg_migrator` (which holds BYPASSRLS), so its
-- body sees the bindings regardless of who called it. That makes it the single
-- controlled door: a caller learns *whether* a source is theirs and nothing else —
-- not who else holds it, not what other bindings exist.
--
-- `search_path` is pinned. A SECURITY DEFINER function that inherits the caller's
-- search_path can be pointed at a shadowed table, which is the standard escalation
-- against exactly this pattern.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.scope_may_read_source(p_source UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_source IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.portal_source_bindings b
      JOIN public.portals p ON p.id = b.portal_row_id
     WHERE b.source_id = p_source
       AND p.status = 'active'
       AND p.client_id::text = current_setting('app.req_client_id', true)
  );
$$;

COMMENT ON FUNCTION public.scope_may_read_source(UUID) IS
  'True when the portal scope in app.req_client_id is bound to this source. The one '
  'controlled door from a tenant scope to the bindings table; used in the USING '
  'clause of the library-aware policies and never in a WITH CHECK.';

-- ---------------------------------------------------------------------------
-- the seven policies gain the library clause
--
-- The clause goes INSIDE the `org_id` conjunction, never beside it: a library
-- belonging to another organization must stay unreadable even if a binding row
-- somehow named it.
--
-- **WITH CHECK deliberately does not change.** A portal scope must never write a
-- library row — not its documents, not its chunks, not its usage. Library writes run
-- under `app.rls_admin`, which is the admin app's service path. Adding the clause
-- here as well would let a tenant insert rows into a library that five other portals
-- read, and nothing downstream would notice.
--
-- Written out per table rather than generated in a DO block, matching 0009: the
-- policy on any given table stays greppable and reviewable on its own.
-- ---------------------------------------------------------------------------

DROP POLICY documents_tenancy ON public.documents;
CREATE POLICY documents_tenancy ON public.documents FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true)
                  OR public.scope_may_read_source(library_id))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

DROP POLICY document_chunks_tenancy ON public.document_chunks;
CREATE POLICY document_chunks_tenancy ON public.document_chunks FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true)
                  OR public.scope_may_read_source(library_id))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

DROP POLICY document_pages_tenancy ON public.document_pages;
CREATE POLICY document_pages_tenancy ON public.document_pages FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true)
                  OR public.scope_may_read_source(library_id))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

DROP POLICY document_paragraphs_tenancy ON public.document_paragraphs;
CREATE POLICY document_paragraphs_tenancy ON public.document_paragraphs FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true)
                  OR public.scope_may_read_source(library_id))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

DROP POLICY ingest_jobs_tenancy ON public.ingest_jobs;
CREATE POLICY ingest_jobs_tenancy ON public.ingest_jobs FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true)
                  OR public.scope_may_read_source(library_id))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

DROP POLICY embedding_batches_tenancy ON public.embedding_batches;
CREATE POLICY embedding_batches_tenancy ON public.embedding_batches FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true)
                  OR public.scope_may_read_source(library_id))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

DROP POLICY usage_events_tenancy ON public.usage_events;
CREATE POLICY usage_events_tenancy ON public.usage_events FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true)
                  OR public.scope_may_read_source(library_id))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));

-- ---------------------------------------------------------------------------
-- the visibility views resolve library documents too
--
-- One extra join path and nothing else, because the binding already carries the
-- grant: a document is visible to a portal when the portal is bound to the source
-- that syncs it, OR to the library that owns it.
--
-- Written as UNION ALL rather than as `ON d.source_id = b.source_id OR
-- d.library_id = b.source_id`. An OR in a join predicate defeats index selection —
-- the planner falls back to a hash or nested loop over the whole of `documents` —
-- and the spec flags it as a hazard to check. Two clean joins each use their own
-- index (`documents_source_idx` and the new `documents_library_idx`), and the two
-- arms are disjoint by construction: 0013's XOR check means a document has either a
-- client or a library, and a library document is not synced by a source, so no row
-- can be produced twice. UNION ALL is therefore correct AND cheaper than UNION.
-- ---------------------------------------------------------------------------

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
   AND d.sync_status <> 'orphaned'
   AND p.status = 'active';

-- The employee variant: same resolution, but keeps the rows an employee needs in
-- order to fix things — still processing, failed, or orphaned by a removed binding.
-- Client-facing reads must never use this one.
CREATE OR REPLACE VIEW public.portal_documents_admin AS
SELECT p.portal_id,
       d.id AS document_id,
       d.client_id,
       d.status,
       d.sync_status,
       NULL::UUID AS library_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.source_id = b.source_id
 WHERE d.deleted_at IS NULL
UNION ALL
-- `library_id` is carried here so the admin preview can say HOW a document reached
-- a portal — its own upload, its table source, or library X (§5B.6). Without it the
-- screen can list 40 documents and explain none of them.
SELECT p.portal_id,
       d.id AS document_id,
       d.client_id,
       d.status,
       d.sync_status,
       d.library_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.library_id = b.source_id
 WHERE d.deleted_at IS NULL;
