-- ---------------------------------------------------------------------------
-- 0022 — an analysis job belongs to the org, not to an owner (Phase 8 §5)
--
-- 0013 gave `ingest_jobs` the same owner rule as every derived table:
--
--   CHECK ((client_id IS NULL) <> (library_id IS NULL))
--
-- "exactly one owner", checked by the database rather than by convention. That is
-- right for every job that existed when it was written: a parse, an OCR, an embed, a
-- reindex, a delete and a batch poll are all *about one document*, which belongs to
-- one tenant or one library.
--
-- The two Phase 8 jobs are not about a document. `insight_embed` reads every client's
-- unembedded questions in one query; `insight_purge` walks every client that has a
-- retention setting. They belong to the organisation.
--
-- ---------------------------------------------------------------------------
-- Why the constraint changes rather than the jobs
--
-- The alternative was to give each run an owner and enqueue one job per client. That
-- is a design change made to satisfy a constraint rather than to serve the work: it
-- multiplies rows, it makes an org-wide purge into N partial purges whose failures
-- interleave, and it would have the embed job re-scan the same table N times.
--
-- Writing an arbitrary tenant into the column instead — which is what "just pick the
-- first client" amounts to — would be worse: the run would then *look* like it
-- belonged to one client in every list and every cost report, which is precisely the
-- kind of quiet mis-attribution 0013's check exists to prevent.
--
-- So the exception is named. A reader of the constraint can see exactly which kinds
-- are ownerless and why, and adding a third requires editing this line rather than
-- discovering that the rule was never really a rule.
--
-- `insight_cluster` and `insight_flag` will need the same exemption when 8C and 8D
-- add them. They are deliberately not listed here: a kind in a constraint that
-- nothing dispatches is the trap this codebase has paid for three times.
-- ---------------------------------------------------------------------------

ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT IF EXISTS ingest_jobs_owner_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_owner_check CHECK (
    CASE
      WHEN kind IN ('insight_embed', 'insight_purge')
        THEN client_id IS NULL AND library_id IS NULL
      ELSE (client_id IS NULL) <> (library_id IS NULL)
    END
  );

COMMENT ON CONSTRAINT ingest_jobs_owner_check ON public.ingest_jobs IS
  'A document job has exactly one owner — a tenant or a library. An analysis job has '
  'neither, because it reads across the whole organisation; the CASE makes that an '
  'explicit exemption per kind rather than a hole in the rule.';
