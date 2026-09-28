-- ---------------------------------------------------------------------------
-- 0015 — folders belong to a library
--
-- Phase 6 makes a library the only way a file enters the system, so a folder
-- follows its documents: it is owned by a library, not by a tenant. The same XOR
-- shape 0013 gave the seven document tables applies here — exactly one owner, checked
-- by the database.
--
-- This reverses a decision 0014 made deliberately ("document_folders is per tenant by
-- definition"). It has to: a viewer who receives a library sees its documents, and
-- without library-owned folders there is no tree to put them in.
--
-- ---------------------------------------------------------------------------
-- The uniqueness bug being fixed on the way past
--
-- The old rule was `UNIQUE (client_id, parent_id, name)`. In Postgres two NULLs are
-- never equal, so that constraint **does not catch two root folders with the same
-- name** — `parent_id IS NULL` for both, and the pair compares as distinct. Every
-- top-level folder could be duplicated, silently, and the tree would render two
-- identical nodes.
--
-- Replaced with partial unique indexes over `COALESCE(parent_id, <zero uuid>)`, which
-- makes the root case comparable. The zero uuid is a sentinel that cannot collide
-- with a real folder id, because `gen_random_uuid()` never produces it.
--
-- Checked before writing this: zero duplicate (client_id, parent_id, name) groups in
-- dev and in prod, so both indexes build on live data. That check is not optional —
-- a duplicate makes `CREATE UNIQUE INDEX` fail and takes the whole migration with it.
--
-- Note it is a **constraint**, not a bare index: `pg_constraint.contype = 'u'`. The
-- phase spec proposed `DROP INDEX IF EXISTS`, which would have failed with "cannot
-- drop index ... because constraint ... requires it".
-- ---------------------------------------------------------------------------

ALTER TABLE public.document_folders
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE CASCADE;

ALTER TABLE public.document_folders ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.document_folders ADD CONSTRAINT document_folders_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

-- ---------------------------------------------------------------------------
-- sibling-name uniqueness, per owner, root folders included
-- ---------------------------------------------------------------------------

ALTER TABLE public.document_folders DROP CONSTRAINT document_folders_sibling_name_key;

CREATE UNIQUE INDEX document_folders_library_sibling_key
  ON public.document_folders
     (library_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE library_id IS NOT NULL;

CREATE UNIQUE INDEX document_folders_client_sibling_key
  ON public.document_folders
     (client_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE client_id IS NOT NULL;

-- The existing (client_id, parent_id, position) index cannot serve a library folder,
-- whose client is NULL. Same shape for the other owner.
CREATE INDEX document_folders_library_idx
  ON public.document_folders (library_id, parent_id, "position")
  WHERE library_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS: a portal scope may read the folders of a library it is ticked for
--
-- Identical treatment to the seven document tables in 0014: the clause goes inside
-- the `org_id` conjunction, and **WITH CHECK is unchanged** — a portal scope must
-- never write a library folder. Folder writes run under `app.rls_admin`, which is the
-- admin app's service path.
-- ---------------------------------------------------------------------------

DROP POLICY document_folders_tenancy ON public.document_folders;
CREATE POLICY document_folders_tenancy ON public.document_folders FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR (org_id = current_setting('app.org_id', true)
             AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                  OR client_id::text = current_setting('app.req_client_id', true)
                  OR public.scope_may_read_source(library_id))))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR (org_id = current_setting('app.org_id', true)
                  AND (coalesce(current_setting('app.req_client_id', true), '') = ''
                       OR client_id::text = current_setting('app.req_client_id', true))));
