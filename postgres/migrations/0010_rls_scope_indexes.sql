-- ---------------------------------------------------------------------------
-- 0010 — the two composite indexes Gate's RLS manifest still asked for
--
-- v8 gave `client_settings` and `client_group_members` a single-column index on
-- `org_id`, which is what a `tenant` table needs. v9 then made them `scoped` on
-- `client_id`, and a scoped table needs a composite `(orgColumn, scope column)`
-- — Gate's validation caught the gap after the fact: `rls_manifest_index_missing`
-- on exactly these two, and nothing else.
--
-- Not cosmetic. An RLS predicate is evaluated for every row a query touches, so
-- these two tables were about to compare `org_id` and `client_id` per row with
-- an index covering only the first of them. They are small today, which is
-- precisely why this is worth fixing now rather than when they are not.
--
-- The single-column org indexes are dropped rather than left alongside: the
-- composite serves every query the single one did, since `org_id` is its leading
-- column, and a redundant index costs write throughput for nothing.
-- ---------------------------------------------------------------------------

DROP INDEX public.client_settings_org_idx;
DROP INDEX public.client_group_members_org_idx;

CREATE INDEX client_settings_org_client_idx
  ON public.client_settings (org_id, client_id);

CREATE INDEX client_group_members_org_client_idx
  ON public.client_group_members (org_id, client_id);
