-- ---------------------------------------------------------------------------
-- 0023 — the clustering job kind (Phase 8C, §5)
--
-- 0020 added only the two kinds 8A dispatched, on the rule this codebase has paid for
-- three times: a kind in a CHECK that nothing dispatches is code that looks supported
-- and is unreachable. 8C dispatches `insight_cluster`, so this is where it arrives.
--
-- 0022 gave the analysis kinds an exemption from the owner rule — a document job
-- belongs to exactly one tenant or library, an analysis job belongs to the
-- organisation — and that CASE has to name this kind too, or an ownerless clustering
-- job is refused.
--
-- `insight_flag` is still absent. It arrives with 8D, for the same reason.
--
-- ---------------------------------------------------------------------------
-- What 8C deliberately does not enable
--
-- §5 describes clustering as "nightly per client, monthly per org". Only the per-client
-- half ships. §2 permits it outright — "client-scoped screens may show questions in
-- full to KIRIA staff" — while the cross-client half is gated on a question no
-- migration can answer:
--
-- > Before the first cross-client theme is published: check what your MSAs say about
-- > use of client data, and put a line in the portal where clients can see it.
--
-- So no org-scope theme is ever written by this release, and the code to write one is
-- not present either — an unreachable branch waiting on a legal answer is exactly the
-- trap above. The **schema** is ready: `insight_themes_scope_check` already refuses an
-- org row with a client, with sample ids, or below three clients, and
-- `verify-insights-guards.mjs` proves all three. When the contracts question is
-- answered, the work is a clustering pass and a screen, not a schema change.
-- ---------------------------------------------------------------------------

ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT IF EXISTS ingest_jobs_kind_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_kind_check
    CHECK (kind IN ('parse', 'ocr', 'embed', 'reindex', 'delete', 'embed_batch_poll',
                    'insight_embed', 'insight_purge', 'insight_cluster'));

ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT IF EXISTS ingest_jobs_owner_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_owner_check CHECK (
    CASE
      WHEN kind IN ('insight_embed', 'insight_purge', 'insight_cluster')
        THEN client_id IS NULL AND library_id IS NULL
      ELSE (client_id IS NULL) <> (library_id IS NULL)
    END
  );

COMMENT ON CONSTRAINT ingest_jobs_owner_check ON public.ingest_jobs IS
  'A document job has exactly one owner — a tenant or a library. An analysis job has '
  'neither, because it reads across the whole organisation; the CASE makes that an '
  'explicit exemption per kind rather than a hole in the rule.';

-- ---------------------------------------------------------------------------
-- Re-running a period must replace it, not duplicate it
--
-- A clustering run for September, run twice, must leave one set of themes. Without a
-- key the second run doubles every theme and the Content gaps screen shows each one
-- twice — which reads as "this was asked twice as often" and is the most misleading
-- possible failure for a screen whose whole job is ranking by frequency.
--
-- Partial and per scope: two clients legitimately have a theme with the same label in
-- the same month, and the client id is what separates them. An org row has no client,
-- so `COALESCE` gives it a fixed stand-in — the same technique 0015 used for root
-- folders, where NULL parents never compared equal.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS insight_themes_period_label_key
  ON public.insight_themes (
    scope,
    COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::UUID),
    period_start,
    period_end,
    label
  );
