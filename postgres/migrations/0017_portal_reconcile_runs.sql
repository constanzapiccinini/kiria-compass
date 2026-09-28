-- ---------------------------------------------------------------------------
-- 0017 — a durable record of every portal reconcile
--
-- §4 asks the reconcile to raise `PORTAL_RECONCILE_FAILED` when `listPortals`
-- errors, times out or comes back empty. The reconcile runs in the **admin** app, and
-- the alert engine — dedupe key, compare-and-set counter, 30-minute notification
-- throttle, email delivery, delivery retry — lives in the **client** app. Backends are
-- not shared on this platform.
--
-- The three ways out of that, and why this is the one:
--
--   1. Duplicate the engine into the admin. It is ~500 lines of the most carefully
--      tuned code in this project — the counter took a compare-and-set plus eight
--      attempts with jitter to stop losing raises, and the throttle was misread once
--      already. Two copies of that will drift, and the drift will be invisible.
--   2. Insert into `system_alerts` directly from the admin, without the engine. A
--      missing portal reconciles every 15 minutes, so that is 96 identical alerts a
--      day and an inbox nobody reads.
--   3. **Record the outcome; let the worker alert on it.** The admin decides state,
--      and the client app's worker — which already notices conditions and raises for
--      failed jobs, stuck batches and exhausted budgets — reads that state on its
--      sweep. One engine, no duplication, and the alert survives a worker that was
--      down when the reconcile ran, because the row is still there.
--
-- The table pays for itself beyond the alert routing: the Portals screen can say when
-- it last reconciled and what changed, and "when did this portal go missing" has an
-- answer that is not an inference from `missing_since` alone.
-- ---------------------------------------------------------------------------

CREATE TABLE public.portal_reconcile_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  -- False when the platform could not be read. A failed run changes nothing, so this
  -- is also the flag that says "the state you are looking at is the previous state".
  ok            BOOLEAN NOT NULL,
  portals_seen  INTEGER NOT NULL DEFAULT 0,
  renamed       INTEGER NOT NULL DEFAULT 0,
  marked_missing INTEGER NOT NULL DEFAULT 0,
  restored      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  -- 'schedule' | 'screen' | 'button' — so a burst of runs can be attributed rather
  -- than guessed at.
  triggered_by  TEXT NOT NULL,
  CONSTRAINT portal_reconcile_runs_trigger_check
    CHECK (triggered_by IN ('schedule', 'screen', 'button')),
  -- A failed run must say why; a successful one has nothing to say.
  CONSTRAINT portal_reconcile_runs_error_check
    CHECK ((ok IS TRUE AND error IS NULL) OR (ok IS FALSE AND error IS NOT NULL))
);

-- The two reads this table gets: "the latest run" on every screen load, and "the
-- latest failure" on the worker's sweep.
CREATE INDEX portal_reconcile_runs_recent_idx
  ON public.portal_reconcile_runs (org_id, started_at DESC);

ALTER TABLE public.portal_reconcile_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_reconcile_runs FORCE ROW LEVEL SECURITY;

-- Org-scoped, like every other operational table. Deliberately not client-scoped: a
-- reconcile is about the whole organization's portals, and no tenant owns it.
CREATE POLICY portal_reconcile_runs_org_isolation ON public.portal_reconcile_runs
  FOR ALL
  USING (current_setting('app.rls_admin', true) = 'true'
         OR org_id = current_setting('app.org_id', true))
  WITH CHECK (current_setting('app.rls_admin', true) = 'true'
              OR org_id = current_setting('app.org_id', true));
