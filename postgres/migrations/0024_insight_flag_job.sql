-- ---------------------------------------------------------------------------
-- 0024 — the flagging job kind, and a reviewed flag must say who (Phase 8D, §5, §7)
--
-- `review_flags` itself arrived with 0020. This adds the last analysis kind and one
-- constraint the spec implies without stating.
--
-- ---------------------------------------------------------------------------
-- Why a reviewed flag must carry a reviewer
--
-- §7 screen 5: "flags with the question in context, and reviewed / dismissed /
-- escalated with a note. **Escalation is a human deciding, not a webhook.**"
--
-- A flag that has left `new` without a `reviewed_by_user_id` is a flag nobody can be
-- shown to have decided. For an adverse-event mention in a pharmaceutical account that
-- is not a tidiness problem: "this was dismissed" and "we cannot say who dismissed it
-- or when" are very different sentences to have to say later.
--
-- So the transition out of `new` requires both a person and a timestamp, checked by the
-- database rather than by the handler that happens to write it today. `new` requires
-- neither, because a flag the model has just raised has genuinely not been decided.
--
-- ---------------------------------------------------------------------------
-- The five codes are still a guess, deliberately
--
-- §10.5: "The five listed are a starting guess; the people who would action them should
-- choose them." They stay a CHECK rather than a lookup table so that changing them is a
-- visible migration someone has to write, rather than a row someone can add — which is
-- the right friction for a list that decides what gets escalated in a regulated
-- industry.
--
-- One question is open and larger than this phase: if a client's employee describes an
-- adverse event in a chat, KIRIA may have a pharmacovigilance reporting obligation. If
-- so, this queue is not merely a convenience and its codes are not merely a guess. That
-- is recorded in `WHAT-WE-NEED-AND-WHY.md` as a question for counsel.
-- ---------------------------------------------------------------------------

ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT IF EXISTS ingest_jobs_kind_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_kind_check
    CHECK (kind IN ('parse', 'ocr', 'embed', 'reindex', 'delete', 'embed_batch_poll',
                    'insight_embed', 'insight_purge', 'insight_cluster', 'insight_flag'));

ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT IF EXISTS ingest_jobs_owner_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_owner_check CHECK (
    CASE
      WHEN kind IN ('insight_embed', 'insight_purge', 'insight_cluster', 'insight_flag')
        THEN client_id IS NULL AND library_id IS NULL
      ELSE (client_id IS NULL) <> (library_id IS NULL)
    END
  );

COMMENT ON CONSTRAINT ingest_jobs_owner_check ON public.ingest_jobs IS
  'A document job has exactly one owner — a tenant or a library. An analysis job has '
  'neither, because it reads across the whole organisation; the CASE makes that an '
  'explicit exemption per kind rather than a hole in the rule.';

ALTER TABLE public.review_flags
  ADD CONSTRAINT review_flags_decided_by_a_person CHECK (
    status = 'new'
    OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  );

COMMENT ON CONSTRAINT review_flags_decided_by_a_person ON public.review_flags IS
  'A flag can only leave ''new'' with a named reviewer and a timestamp. Escalation — and '
  'dismissal, which matters more — is a person deciding, and the record has to show '
  'which person and when.';

-- ---------------------------------------------------------------------------
-- Finding an open flag is the queue's only hot path
--
-- `review_flags_open_idx` (0020) covers (status, created_at DESC), which serves "show
-- me everything new". The screen also groups by account, and an unreviewed
-- adverse-event flag is the one row that must never be hard to find.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS review_flags_client_open_idx
  ON public.review_flags (client_id, status, created_at DESC);
