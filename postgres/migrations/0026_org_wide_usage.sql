-- ---------------------------------------------------------------------------
-- 0026 — an org-wide analysis call has no owner to charge (Phase 8D)
--
-- The flagging job's first production run screened seven questions, succeeded, and
-- recorded **no usage event at all**. `recordUsage` never throws by design — a metering
-- failure must not fail the pipeline it is measuring — so the insert was refused, the
-- error went to the log, and the run reported success. Real model spend, unmetered, and
-- nothing on any screen said so.
--
-- The refusal was `usage_events_owner_check` from 0013:
--
--     CHECK ((client_id IS NULL) <> (library_id IS NULL))
--
-- which is the same XOR that 0022 had to relax on `ingest_jobs`, for the same reason
-- and with the same lesson: a rule written when every row had exactly one owner does
-- not survive the arrival of work that belongs to the whole organisation. I hit it
-- twice; the second time is on me for not looking.
--
-- ---------------------------------------------------------------------------
-- Why not charge it to the clients in the batch
--
-- `insight_embed` already splits a batch's tokens across the questions in it, so the
-- pattern exists and would have needed no migration. It is the wrong answer here.
--
-- Screening is KIRIA's own compliance activity. §5 is explicit that it "never notifies
-- the client, never reports anywhere automatically" — it is not work done for the
-- account, and a client's cost line should not carry it. Embedding a client's questions
-- to answer them is that client's cost; reading their questions to check whether KIRIA
-- has a reporting obligation is not.
--
-- So the row keeps no owner, and the accounting stays true: per-client totals exclude
-- it, and the org-wide total includes it.
--
-- ---------------------------------------------------------------------------
-- Why keyed on `via` rather than on a new column
--
-- `metadata->>'via'` is already how every analysis event identifies itself, and naming
-- the exempt jobs one by one means a new org-wide job has to write a migration to
-- become exempt. That friction is the point: "this call belongs to nobody" should be a
-- decision someone made on purpose, not a default that a null slips through.
-- ---------------------------------------------------------------------------

ALTER TABLE public.usage_events
  DROP CONSTRAINT IF EXISTS usage_events_owner_check;

ALTER TABLE public.usage_events
  ADD CONSTRAINT usage_events_owner_check CHECK (
    CASE
      WHEN metadata->>'via' IN ('insight_flag')
        THEN client_id IS NULL AND library_id IS NULL
      ELSE (client_id IS NULL) <> (library_id IS NULL)
    END
  );

COMMENT ON CONSTRAINT usage_events_owner_check ON public.usage_events IS
  'A metered call has exactly one owner — a tenant or a library — unless it is an '
  'org-wide analysis call, which has none because it was made on behalf of the whole '
  'organisation rather than for any account. The CASE names those jobs explicitly so a '
  'missing owner is always a decision and never an oversight.';

-- The org-wide rows have neither owner, so neither of 0013's partial indexes reaches
-- them and the (org_id, client_id) composite cannot. Small, and it is what a "what did
-- the analysis cost this month" question scans.
CREATE INDEX IF NOT EXISTS usage_events_org_wide_idx
  ON public.usage_events (org_id, created_at DESC)
  WHERE client_id IS NULL AND library_id IS NULL;
