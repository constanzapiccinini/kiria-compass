-- ---------------------------------------------------------------------------
-- 0006 — the alert dedupe key constrains OPEN alerts only
--
-- 0004 created `UNIQUE (org_id, dedupe_key, status)` and its comment claimed
-- this let "a resolved alert not block an identical new one when the same
-- failure recurs later". It does allow that — but it also allows only ONE row
-- per status, which is not the same property, and the difference bites on the
-- second occurrence of any recurring failure:
--
--   1. Failure happens  -> row A (status 'new')
--   2. Staff resolve it -> row A (status 'resolved')
--   3. Failure recurs   -> row B (status 'new')       <- fine, as intended
--   4. Staff resolve it -> row B -> 'resolved' ...    <- VIOLATION: row A is
--                                                       already (key,'resolved')
--
-- So step 4 fails. The admin "Resolve" button 500s, permanently, for every
-- alert that has ever been resolved once before. Nothing warns anybody: the
-- inbox keeps working and only the resolve transition is broken, and only
-- after a recurrence — which is exactly the case the dedupe design exists to
-- handle.
--
-- Found while resolving a test-generated alert on prod, not by review. Worth
-- recording, because a status column inside a uniqueness key almost always
-- means "one per state" when the author meant "one while in these states".
--
-- The property actually wanted is a partial unique index: at most one OPEN
-- alert per dedupe key, and an unbounded resolved history — the history being
-- what makes recurrence over time visible at all.
-- ---------------------------------------------------------------------------

ALTER TABLE public.system_alerts DROP CONSTRAINT system_alerts_dedupe_key;

-- Matches `raiseAlert`'s lookup (`status IN ('new','acknowledged')`) exactly, so
-- the read and the constraint cannot disagree about what "open" means. Also lets
-- new -> acknowledged happen without tripping over itself, since the row simply
-- stays the single open one.
CREATE UNIQUE INDEX system_alerts_open_dedupe_key
  ON public.system_alerts (org_id, dedupe_key)
  WHERE status IN ('new', 'acknowledged');
