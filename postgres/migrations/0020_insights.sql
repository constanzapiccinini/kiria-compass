-- ---------------------------------------------------------------------------
-- 0020 — conversation intelligence (§4)
--
-- The spec calls this `0017_insights.sql`; Phase 6 took 15–19, so it lands at 20.
--
-- **This phase adds no capture.** `chat_messages` has carried the question, the
-- answer, the citations, `grounded`, the model, the token counts and the latency since
-- 0001. What is missing is structure, governance, and two signals — a rating and a
-- question embedding. Everything here is one of those three.
--
-- ---------------------------------------------------------------------------
-- Two findings the spec asks to settle before building on them
--
-- **`grounded` is trustworthy.** Measured before writing a line of this: it is NULL on
-- zero assistant messages in either stage (dev 1/1, prod 7/7), and NULL on every user
-- message, which is correct — the column only means something for an answer. The write
-- is unconditional in `rag.ts` (`!isRefusal && citations.length > 0`, with `false` on
-- both refusal paths), so it is not luck of a small sample. Production already reads
-- 5 grounded / 2 not, so the content-gap metric has real signal on day one.
--
-- **`retention_days` is a promise nothing keeps.** It can be set per client, it is
-- validated, it is audited — and no job has ever deleted a row. §6 says make it true
-- or stop making it. This migration is the schema half; `insight_purge` is the job.
-- Every client is currently NULL (keep forever), so the first run deletes nothing:
-- choosing a number is a policy decision and stays open (§10.2).
--
-- ---------------------------------------------------------------------------
-- Where this deviates from §4, and why
--
-- 1. **`chat_message_feedback` is client-scoped, not staff-only.** §4 says "every
--    table here is staff-only … the client app must never be able to read a single
--    row", but §3 puts the thumbs control **in the client chat panel** — so the client
--    app must be able to insert, and to read back its own rating. Those two sentences
--    cannot both hold. Feedback is scoped exactly like `chat_messages`: a client sees
--    its own and nothing else. The staff-only rule is applied to the five *analysis*
--    tables, which is what it was protecting.
--
-- 2. **"Staff-only" cannot be org-scoped alone.** Both apps run in the same org and
--    both hold `app.org_id`, so an org policy in the shape of 0007 would let the
--    client backend read every insight row. The barrier that actually exists is the
--    one `store.ts` already documents: "a client-facing request carries its resolved
--    client and a background job carries nothing". So these policies additionally
--    require **no** `app.req_client_id` — readable by staff calls and by the worker,
--    never by a portal-scoped request. That is the direct-query proof §8 asks for.
--
-- 3. **`insight_theme_members` gains `org_id`.** §4's DDL omits it, but then the table
--    has no column any RLS classification can be declared against, and its policy
--    would have to reach through its parent. Every other table here carries one.
--
-- 4. **`ingest_jobs.kind` gains only the two kinds 8A dispatches.** `insight_cluster`
--    and `insight_flag` arrive with 8C and 8D. A kind in the CHECK that nothing
--    dispatches is the "looks supported, is unreachable" trap this codebase has paid
--    for three times.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. opt-out (§2)
--
-- Honoured by every job and every query. Defaults to FALSE because that is what the
-- existing accounts are; §2's instruction is to set it for any client whose contract
-- is unclear **before the first run**, which is a decision for a person, not a default.
-- ---------------------------------------------------------------------------

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS analytics_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.clients.analytics_opt_out IS
  'When true, no conversation of this client is embedded, clustered, flagged or '
  'counted anywhere. Set it before the first analysis run for any account whose '
  'contract does not clearly permit this.';

-- ---------------------------------------------------------------------------
-- 2. feedback (§3)
--
-- `user_hash`, never a user id or an email: "which person asked this" is an
-- operational question the audit log answers, and mixing it into analytics is how a
-- usage dashboard becomes a surveillance tool (§2). One rating per person per message,
-- enforced by the unique constraint, so a second submit updates rather than duplicates.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.chat_message_feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  message_id UUID NOT NULL REFERENCES public.chat_messages (id) ON DELETE CASCADE,
  client_id  UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  rating     SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  comment    TEXT,
  user_hash  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_message_feedback_once UNIQUE (message_id, user_hash)
);

CREATE INDEX IF NOT EXISTS chat_message_feedback_client_idx
  ON public.chat_message_feedback (client_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. question embeddings (§3)
--
-- `DOUBLE PRECISION[]`, matching `document_chunks.embedding` — there is no pgvector in
-- this store, and §5 is explicit that a few thousand vectors compared in JS is fine
-- and should be measured rather than assumed.
--
-- `model` and `dims` are stored so a model change is visible rather than silently
-- mixing two vector spaces in one cosine comparison.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.question_embeddings (
  message_id UUID PRIMARY KEY REFERENCES public.chat_messages (id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  client_id  UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  embedding  DOUBLE PRECISION[] NOT NULL,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS question_embeddings_client_idx
  ON public.question_embeddings (client_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. themes (§2, §4)
--
-- The CHECK is the point of this table. §2's rule — verbatim question text never
-- leaves its client, and an org-scope theme needs three or more distinct clients — is
-- written here rather than in a handler, because a guard in a handler survives until
-- the next refactor and a CHECK survives everything.
--
-- An org-scope row therefore cannot carry a client, cannot carry sample message ids
-- (which would be a route back to verbatim text), and cannot exist below the
-- k-anonymity threshold. All three in one constraint, so none can be relaxed by
-- accident.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.insight_themes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  -- Named explicitly. An inline column CHECK is auto-named `<table>_<column>_check`,
  -- which for this column is `insight_themes_scope_check` — the exact name §2 gives
  -- the anonymity constraint below. Postgres refuses the duplicate, and the spec's own
  -- DDL carries the collision. The anonymity rule keeps the documented name because
  -- §2 and §8 both refer to it; the enum check is the one that moves.
  scope            TEXT NOT NULL,
  client_id        UUID REFERENCES public.clients (id) ON DELETE CASCADE,
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  label            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  question_count   INTEGER NOT NULL,
  client_count     INTEGER NOT NULL DEFAULT 1,
  unanswered_share NUMERIC(5, 4),
  sample_message_ids UUID[] NOT NULL DEFAULT '{}',
  model            TEXT NOT NULL,
  prompt_version   TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT insight_themes_scope_values_check CHECK (scope IN ('client', 'org')),
  CONSTRAINT insight_themes_period_check CHECK (period_end >= period_start),
  CONSTRAINT insight_themes_scope_check CHECK (
    (scope = 'client' AND client_id IS NOT NULL)
    OR (scope = 'org' AND client_id IS NULL
        AND sample_message_ids = '{}'::UUID[]
        AND client_count >= 3)
  )
);

CREATE INDEX IF NOT EXISTS insight_themes_scope_idx
  ON public.insight_themes (scope, period_start DESC);
CREATE INDEX IF NOT EXISTS insight_themes_client_idx
  ON public.insight_themes (client_id, period_start DESC);

COMMENT ON CONSTRAINT insight_themes_scope_check ON public.insight_themes IS
  'Verbatim question text never leaves its client. An org-scope theme carries no '
  'client, no sample message ids — which would be a route back to the text — and no '
  'fewer than three distinct clients.';

CREATE TABLE IF NOT EXISTS public.insight_theme_members (
  theme_id   UUID NOT NULL REFERENCES public.insight_themes (id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES public.chat_messages (id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  similarity REAL NOT NULL,
  PRIMARY KEY (theme_id, message_id)
);

-- ---------------------------------------------------------------------------
-- 5. review flags (§4)
--
-- Tuned for recall by the job, not by the schema: a missed adverse-event mention costs
-- far more than a false positive a human dismisses in two seconds. The schema's part
-- is that a flag is a queue item with a human decision on it — `reviewed_by_user_id`
-- and a note — and that escalation is a status a person sets, never a webhook.
--
-- The five codes are §4's starting guess and §10.5 says the people who would action
-- them should choose them. They are a CHECK rather than a lookup table so changing
-- them is a visible migration rather than a silent row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.review_flags (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  message_id     UUID NOT NULL REFERENCES public.chat_messages (id) ON DELETE CASCADE,
  client_id      UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  code           TEXT NOT NULL CHECK (
                   code IN ('adverse_event', 'off_label', 'complaint', 'privacy', 'other')),
  confidence     REAL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new' CHECK (
                   status IN ('new', 'reviewed', 'dismissed', 'escalated')),
  reviewed_by_user_id TEXT,
  reviewed_at    TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT review_flags_once UNIQUE (message_id, code)
);

CREATE INDEX IF NOT EXISTS review_flags_open_idx
  ON public.review_flags (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. runs (§5, §6)
--
-- Every analysis run writes a row here, and a failure raises `INSIGHT_RUN_FAILED`
-- through the existing alert path. `counts` is JSONB rather than columns because each
-- kind counts different things and a run log that needs a migration to report a new
-- number stops reporting new numbers.
--
-- A failed run must say why, for the same reason `portal_reconcile_runs` must (0017):
-- "it failed" with no cause is a row that tells an operator to go and read logs.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.insight_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  kind         TEXT NOT NULL CHECK (kind IN ('embed', 'cluster', 'flag', 'rollup', 'purge')),
  period_start DATE,
  period_end   DATE,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (
                 status IN ('running', 'succeeded', 'failed')),
  counts       JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_error   TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  CONSTRAINT insight_runs_failure_has_error CHECK (
    status <> 'failed' OR last_error IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS insight_runs_recent_idx
  ON public.insight_runs (kind, started_at DESC);

-- ---------------------------------------------------------------------------
-- 7. the two new job kinds (§5, §6)
--
-- 0019 narrowed this check by removing `source_sync`, whose handler Phase 6 deleted.
-- This widens it by exactly the two kinds 8A dispatches.
-- ---------------------------------------------------------------------------

ALTER TABLE public.ingest_jobs
  DROP CONSTRAINT IF EXISTS ingest_jobs_kind_check;

ALTER TABLE public.ingest_jobs
  ADD CONSTRAINT ingest_jobs_kind_check
    CHECK (kind IN ('parse', 'ocr', 'embed', 'reindex', 'delete', 'embed_batch_poll',
                    'insight_embed', 'insight_purge'));

-- ---------------------------------------------------------------------------
-- 8. RLS
--
-- `chat_message_feedback` is scoped like `chat_messages`: org, plus the client when a
-- portal-scoped request carries one. A client rates its own answers and sees nothing
-- else.
--
-- The five analysis tables are staff-and-worker only. The clause that does that work
-- is `current_setting('app.req_client_id', true)` being absent or empty — see the
-- deviation note at the top for why org isolation alone would not have kept the client
-- app out.
-- ---------------------------------------------------------------------------

ALTER TABLE public.chat_message_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_message_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_message_feedback_tenancy ON public.chat_message_feedback
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         AND (COALESCE(current_setting('app.req_client_id', true), '') = ''
              OR client_id::TEXT = current_setting('app.req_client_id', true))
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              AND (COALESCE(current_setting('app.req_client_id', true), '') = ''
                   OR client_id::TEXT = current_setting('app.req_client_id', true))
              OR current_setting('app.rls_admin', true) = 'true');

ALTER TABLE public.question_embeddings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_embeddings   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.insight_themes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insight_themes        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.insight_theme_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insight_theme_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.review_flags          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_flags          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.insight_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insight_runs          FORCE ROW LEVEL SECURITY;

CREATE POLICY question_embeddings_staff_only ON public.question_embeddings
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         AND COALESCE(current_setting('app.req_client_id', true), '') = ''
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              AND COALESCE(current_setting('app.req_client_id', true), '') = ''
              OR current_setting('app.rls_admin', true) = 'true');

CREATE POLICY insight_themes_staff_only ON public.insight_themes
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         AND COALESCE(current_setting('app.req_client_id', true), '') = ''
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              AND COALESCE(current_setting('app.req_client_id', true), '') = ''
              OR current_setting('app.rls_admin', true) = 'true');

CREATE POLICY insight_theme_members_staff_only ON public.insight_theme_members
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         AND COALESCE(current_setting('app.req_client_id', true), '') = ''
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              AND COALESCE(current_setting('app.req_client_id', true), '') = ''
              OR current_setting('app.rls_admin', true) = 'true');

CREATE POLICY review_flags_staff_only ON public.review_flags
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         AND COALESCE(current_setting('app.req_client_id', true), '') = ''
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              AND COALESCE(current_setting('app.req_client_id', true), '') = ''
              OR current_setting('app.rls_admin', true) = 'true');

CREATE POLICY insight_runs_staff_only ON public.insight_runs
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         AND COALESCE(current_setting('app.req_client_id', true), '') = ''
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              AND COALESCE(current_setting('app.req_client_id', true), '') = ''
              OR current_setting('app.rls_admin', true) = 'true');

-- ---------------------------------------------------------------------------
-- 9. indexes the RLS manifest asks for
--
-- A `scoped` table needs `(orgColumn, scope.column)`; a `tenant` table needs the org
-- column. Added here rather than left to a later warning, because the warning count
-- is only as good as the manifest — `portal_reconcile_runs` was missing from it since
-- 0017 and the validator reported zero warnings the whole time, since it checks what
-- is declared rather than what exists.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS chat_message_feedback_org_client_idx
  ON public.chat_message_feedback (org_id, client_id);
CREATE INDEX IF NOT EXISTS question_embeddings_org_idx
  ON public.question_embeddings (org_id);
CREATE INDEX IF NOT EXISTS insight_themes_org_idx
  ON public.insight_themes (org_id);
CREATE INDEX IF NOT EXISTS insight_theme_members_org_idx
  ON public.insight_theme_members (org_id);
CREATE INDEX IF NOT EXISTS review_flags_org_idx
  ON public.review_flags (org_id);
CREATE INDEX IF NOT EXISTS insight_runs_org_idx
  ON public.insight_runs (org_id);
