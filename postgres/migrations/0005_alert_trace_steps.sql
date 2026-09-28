-- ---------------------------------------------------------------------------
-- 0005 — trace step for repeated answer timeouts (Phase 4D, §10.4)
--
-- `LLM_TIMEOUT_REPEATED` is the one alert code that must not fire on a single
-- failure: one slow answer is weather, several in half an hour is an outage.
-- That threshold needs a count of recent timeouts, and the count has to be
-- durable rather than per-process — the backend runs on up to three replicas,
-- so an in-memory counter would need three times the failures before any one
-- replica reached the threshold.
--
-- `rag_traces` is already the durable per-client record of what the answer
-- pipeline did, so the timeout goes there as one more step rather than in a
-- new table. `step` carries a CHECK constraint, which is why this migration
-- exists at all: inserting 'answer_timeout' without it fails, and it would
-- fail inside the error path of a request that has already failed — the
-- hardest place to notice a bug.
--
-- Same shape as 0003's extension of the same constraint: a CHECK cannot be
-- altered in place, so drop and re-add with the full list.
-- ---------------------------------------------------------------------------

ALTER TABLE public.rag_traces DROP CONSTRAINT rag_traces_step_check;

ALTER TABLE public.rag_traces
  ADD CONSTRAINT rag_traces_step_check CHECK (step IN (
    'embed_query', 'retrieve', 'rerank', 'generate', 'ingest', 'resolve_portal',
    'answer_timeout'
  ));

-- The threshold query filters on (client_id, step, created_at). The existing
-- rag_traces_client_created_idx covers the leading columns, but every retrieval
-- step for that client falls inside the same window, so a scan of it reads far
-- more rows than it returns. Partial on the one step that is counted: tiny,
-- because timeouts are rare, and it stays that way.
CREATE INDEX rag_traces_timeout_idx
  ON public.rag_traces (client_id, created_at DESC)
  WHERE step = 'answer_timeout';
