# PHASE 8 — Conversation intelligence

**New app `apps/compass-insights`, plus the analysis jobs behind it.**

Author: Coni · Date: 2026-09-08 · Store alias `compasses` · Decisions taken: client-scoped verbatim + anonymised cross-client themes · separate insights app · flag-for-review queue

---

## 0. The starting point is better than expected

**The conversations are already being stored.** `chat_messages` has carried, since `0001`: the question text, the answer, `citations`, `retrieved_chunk_ids`, `grounded`, `model`, input/output tokens, `latency_ms`, `truncated`, `created_by_user_id`, `created_at`. `chats` carries the document scope; `usage_events` the cost; `rag_traces` the per-step timings.

So this phase does not add capture. It adds **reading, structure and governance** — plus two small signals that are missing.

Two findings to deal with first:

1. **`retention_days` is a setting nothing enforces.** It can be set per client in the admin, it is validated, it is audited — and no job anywhere deletes a single row. Nothing in this codebase has ever deleted a conversation. Before building a programme on mining conversations, make that promise true or stop making it (§6).
2. **`grounded` is the content-gap metric**, and the whole headline value of this phase rests on it. Verify it is written on **every** assistant message before trusting any number derived from it; if it is null anywhere, the gap rate silently undercounts.

---

## 1. What this is for

The product question is not "how many questions did they ask". It is:

- **What do our clients ask that our material does not answer?** → `grounded = false`. That list is the brief for the next Compass chapter.
- **Which parts of what we produce actually get read?** → citation frequency by document and page.
- **What do we produce that nobody ever opens?** → documents with zero citations after N days.
- **What themes recur across the whole book of business?** → anonymised cross-client clustering.

Those four answers are the deliverable. Charts of message counts are decoration; build them last if at all.

---

## 2. Boundaries — decided, and enforced in the schema

**Verbatim question text never leaves its client.** Client-scoped screens may show questions in full to KIRIA staff. Org-scoped screens may show **only** labels, summaries and counts, and only for themes carried by **three or more distinct clients**.

Enforce it in the database, not only in code:

```sql
CONSTRAINT insight_themes_scope_check CHECK (
  (scope = 'client' AND client_id IS NOT NULL)
  OR (scope = 'org' AND client_id IS NULL
      AND sample_message_ids = '{}'::uuid[]
      AND client_count >= 3)
)
```

A guard written only in a handler survives until the next refactor. A CHECK constraint survives everything.

**Opt-out.** `clients.analytics_opt_out BOOLEAN NOT NULL DEFAULT FALSE`, honoured by every job and every query, for accounts whose contract does not permit this. Set it before the first run for any client you are unsure about.

**Identity.** The analysis tables store a per-client salted hash of `created_by_user_id`, never the raw id or an email. "Which person asked this" is an operational question, answerable in the audit log; it is not an analytics question, and mixing them is how a usage dashboard becomes a surveillance tool.

**Before the first cross-client theme is published:** check what your MSAs say about use of client data, and put a line in the portal where clients can see it — that conversations are stored, reviewed by the KIRIA team, and used to improve the material. I'm not a lawyer, and this is the part where you want one, or at least the contracts in front of you. It is much cheaper to decide now than after a client asks.

---

## 3. Two signals to add

**Feedback.** A thumbs up/down on each answer, optional comment. One table, one control in the chat panel. It is the cheapest high-value signal there is, and without it "was this answer good" is guesswork over latency and token counts. This is the one addition to the client app, and it belongs to chat rather than to configuration, so it does not break the view-and-chat rule.

**Question embeddings.** Reuse `text-embedding-3-large`, the model already in the pipeline. A question is ~20 tokens; embedding every question ever asked costs less than indexing one Compass PDF. Backfill through the existing Batch API path.

---

## 4. Schema — `0017_insights.sql`

```sql
ALTER TABLE public.clients ADD COLUMN analytics_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE public.chat_message_feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  message_id UUID NOT NULL REFERENCES public.chat_messages (id) ON DELETE CASCADE,
  client_id  UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  rating     SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  comment    TEXT,
  user_hash  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_message_feedback_once UNIQUE (message_id, user_hash)
);

CREATE TABLE public.question_embeddings (
  message_id UUID PRIMARY KEY REFERENCES public.chat_messages (id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  client_id  UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  embedding  DOUBLE PRECISION[] NOT NULL,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.insight_themes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  scope         TEXT NOT NULL CHECK (scope IN ('client','org')),
  client_id     UUID REFERENCES public.clients (id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  label         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  question_count INTEGER NOT NULL,
  client_count  INTEGER NOT NULL DEFAULT 1,
  unanswered_share NUMERIC(5,4),
  sample_message_ids UUID[] NOT NULL DEFAULT '{}',
  model         TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT insight_themes_scope_check CHECK ( /* as §2 */ )
);

CREATE TABLE public.insight_theme_members (
  theme_id   UUID NOT NULL REFERENCES public.insight_themes (id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES public.chat_messages (id) ON DELETE CASCADE,
  similarity REAL NOT NULL,
  PRIMARY KEY (theme_id, message_id)
);

CREATE TABLE public.review_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  message_id  UUID NOT NULL REFERENCES public.chat_messages (id) ON DELETE CASCADE,
  client_id   UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  code        TEXT NOT NULL CHECK (code IN ('adverse_event','off_label','complaint','privacy','other')),
  confidence  REAL,
  model       TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','dismissed','escalated')),
  reviewed_by_user_id TEXT,
  reviewed_at TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT review_flags_once UNIQUE (message_id, code)
);
CREATE INDEX review_flags_open_idx ON public.review_flags (status, created_at DESC);

CREATE TABLE public.insight_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      TEXT NOT NULL DEFAULT current_setting('app.org_id', true),
  kind        TEXT NOT NULL CHECK (kind IN ('embed','cluster','flag','rollup','purge')),
  period_start DATE, period_end DATE,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  counts      JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_error  TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
```

**RLS:** every table here is staff-only. Add org-scoped policies in the shape of `0007`, with **no** client-scope read path and no `scope_may_read_source` term — the client app must never be able to read a single row. Add them to `rls-manifest.json` so the warning count stays at 0.

---

## 5. The jobs run in the existing worker

This is the load-bearing decision, given that the insights app is separate. `apps/compass-ai/backend` already owns the pipeline, the queue and the cron. **The analysis runs there**, as three new `ingest_jobs` kinds:

- `insight_embed` — embed new user questions (Batch API above a threshold, same as documents).
- `insight_cluster` — nightly per client, monthly per org. Greedy cosine-threshold clustering over `question_embeddings` (no pgvector in this store; a few thousand vectors in JS is fine — measure before assuming otherwise), then one completion per cluster for a label and summary. Store `prompt_version` so two months are comparable.
- `insight_flag` — classify each new question against the review codes. Tuned for **recall**: a missed adverse-event mention costs far more than a false positive a human dismisses in two seconds. Never notifies the client, never reports anywhere automatically, never blocks the answer.

`compass-insights` therefore contains **no pipeline code at all** — it reads and it manages queues. That is what keeps a third app from becoming a third copy of the helpers that have already caused two production incidents here. The helpers it does need (`auth`, `admin-auth`, `store`, `config`) are copied verbatim, like `folders.ts` was, and get the byte-comparison drift test alongside them.

Every run writes an `insight_runs` row; a failure raises `INSIGHT_RUN_FAILED` through the existing alert path with cause and remediation.

---

## 6. Retention — make the promise real

`retention_days` must actually do something before conversations become an asset you keep forever by accident.

A nightly `purge` run deletes chats and messages older than the client's `retention_days` (null = keep). Decide, explicitly and in writing, what happens to derived rows:

- `question_embeddings`, `insight_theme_members` and `review_flags` cascade — they reference the message.
- `insight_themes` **survive**, because they are aggregates. That is defensible, but "we deleted your conversations and kept the themes" must be a documented decision on the day it is made, not a discovery a year later.
- `sample_message_ids` must be scrubbed of ids that no longer exist, or the client screen shows blanks that look like a bug.

---

## 7. `apps/compass-insights`

`fusebase app create`, `--access=orgRole:member`, Gate permissions `isolated_store.read` plus `isolated_store.data.write` (its own tables) in `backendOnlyGatePermissions`. No `files.write`.

Screens:

1. **Overview** — org-level, k-anonymised: questions and clients active over time, answer-gap rate, top themes, open flags.
2. **Client** — picker, then that client's numbers, themes with real questions, most- and never-cited documents, adoption since each library was granted.
3. **Content gaps** — the actionable one. Unanswered questions grouped by theme, ranked by frequency × clients affected, each row exportable and each traceable to the questions behind it. This is the screen that pays for the phase.
4. **Themes** — explore and compare periods.
5. **Review queue** — flags with the question in context, and reviewed / dismissed / escalated with a note. Escalation is a human deciding, not a webhook.
6. **Runs** — what ran, what it cost, what failed.

Charts follow the `dataviz` guidance; the palette matches KIRIA's, not Chakra's defaults.

**Export:** a monthly xlsx per client and one org-wide, plus optionally an item on a monday board so a gap becomes work with an owner. Build it after screen 3 proves useful, not before.

---

## 8. Tests

- Opt-out client: no embeddings, no themes, no flags, no rows anywhere — assert by count, not by absence of a screen.
- The `insight_themes` CHECK refuses an org-scope row with a `client_id`, with samples, or with `client_count = 2`. Test the constraint, not the handler.
- The client app cannot read any insights table with a portal-scoped session — the same direct-query proof used for `0009`/`0014`.
- A purge deletes messages, cascades embeddings and flags, keeps themes, and scrubs the sample ids.
- Clustering is deterministic for a fixed input and `prompt_version` — or, if it is not, say so and pin what varies; two months that cannot be compared are not a trend.
- Feedback: one rating per person per message; a second submit updates rather than duplicating.

---

## 9. Sequencing

**8A** — feedback control, question embeddings, retention purge, `insight_runs`. No new app; the signals start accumulating while the rest is built.
**8B** — `compass-insights` scaffold, Overview and Client screens on the metrics that need no LLM (gap rate, citations, never-cited, adoption).
**8C** — clustering, themes, Content gaps screen.
**8D** — flagging and the review queue.

8A first matters: themes need history, and the sooner questions are being embedded the sooner 8C has something to say.

---

## 10. Open items

1. **Contracts and disclosure** — the §2 paragraph. This gates 8C, not 8A.
2. **Retention default.** Today: infinite, for everyone. Choosing a number is a policy decision and it should be yours, not the absence of a job.
3. **Do clients see any of this?** A "what your team asked this month" page in the portal is a genuine product in its own right — and a different, larger decision than an internal dashboard.
4. **Cross-client threshold of 3 clients** — right number for a book of seven or eight pharma accounts, or should it be higher?
5. **Flag codes.** The five listed are a starting guess; the people who would action them should choose them.
