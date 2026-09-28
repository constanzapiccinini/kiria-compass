-- ---------------------------------------------------------------------------
-- 0025 — remember that a question was screened and found clean (Phase 8D)
--
-- The flagging job's first version selected questions with
-- `NOT EXISTS (SELECT 1 FROM review_flags WHERE message_id = m.id)`, which reads
-- correctly and is wrong: a question screened and found **clean** leaves no row, so it
-- is selected again on the next run, and the next. Every clean question in the window
-- would be sent to the model again every night, forever, for an answer already known.
--
-- With seven questions that is invisible. At a few hundred a day it is the entire cost
-- of the feature, spent repeatedly on nothing — and it would never look like a bug,
-- because the queue would be correct the whole time.
--
-- ---------------------------------------------------------------------------
-- Why a column rather than the alternatives
--
--   * **A sentinel `review_flags` row** meaning "clean" would put a row nobody wants to
--     see into the table whose entire purpose is rows somebody must look at.
--   * **A high-water mark in `insight_runs`** — screen only what is newer than the last
--     successful run — needs no schema change and silently loses every question created
--     during a run that then failed. Questions skipped forever, with nothing to show it.
--   * **A narrower window** makes the re-screening cheap and makes a backfill
--     impossible: anything older than the window is never screened at all.
--
-- A column says the true thing: this message was looked at, at this time. It also makes
-- "how much of the history has been screened" answerable, which a queue that claims to
-- catch adverse events should be able to answer.
--
-- Nullable, with no backfill. A NULL means "not yet screened", which is exactly what is
-- true of every message written before this migration.
-- ---------------------------------------------------------------------------

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS flag_screened_at TIMESTAMPTZ;

COMMENT ON COLUMN public.chat_messages.flag_screened_at IS
  'When the compliance screen last looked at this question. NULL means never. A clean '
  'question produces no review_flags row, so without this the screen would re-pay for '
  'the same answer on every run.';

-- Partial: the job only ever asks for the unscreened, and after the first backfill that
-- is a small tail of a large table.
CREATE INDEX IF NOT EXISTS chat_messages_unscreened_idx
  ON public.chat_messages (created_at DESC)
  WHERE role = 'user' AND flag_screened_at IS NULL;
