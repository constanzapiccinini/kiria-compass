# Compass AI — Phase 3 handoff

Multi-document sessions, cost controls, batch embeddings and the indexing dashboard.
Builds on [PHASE-1.md](./PHASE-1.md) and [PHASE-2.md](./PHASE-2.md).

## Where Phase 3's scope actually landed

Two of the four Phase 3 items were already built and verified earlier, so this phase
is mostly the remaining two plus the e2e harness:

| Phase 3 item | State |
| --- | --- |
| Multi-document sessions with correct per-doc citations | Built in Phase 2; **proven** by the cross-document e2e spec |
| Server-side caps (answer tokens, retrieved tokens, OCR pages) | Built and verified in Phase 1 |
| **Batch embeddings for bulk uploads** | **New in Phase 3** |
| **Indexing status dashboard** | **New in Phase 3** |
| Permanent e2e regression suite | **New in Phase 3** (was the outstanding Phase 2 gap) |

## Schema — migration v2

`postgres/migrations/0002_batch_embeddings.sql`, checksum
`498ac94f14ad6d6da6a2c1040eb77a3d1c21252177e26031659f13450b506c38`. Applied to
**dev and prod**; both journals at v2, no drift.

| Object | Purpose |
| --- | --- |
| `embedding_batches` | One row per OpenAI batch: provider id, file ids, status, chunk/embedded counts, the documents it covers, request counts, error |
| `document_chunks.embedding_batch_id` | Links a vector-less chunk to the batch that will fill it, so a stuck batch is traceable from either end |
| `ingest_jobs.kind` += `embed_batch_poll` | The poll job |
| `workspace_settings.batch_embedding_enabled` / `_min_chunks` | Opt-in and threshold |
| `document_index_health` (view) | Per-document `chunks_present` / `chunks_embedded`, used by the dashboard |

## Batch embeddings

The OpenAI Batch API is roughly half the price of the synchronous endpoint, with a
completion window of up to 24 hours. That trade only makes sense for bulk ingest, so
it is **opt-in per workspace and gated on a chunk-count threshold** (default 400) —
a small upload should be searchable in seconds, and the saving on one would be
trivial. The default remains the synchronous path verified in Phase 1.

Flow, when it applies:

1. Chunks are written **with a NULL embedding**, so each row's id can serve as the
   batch `custom_id`. That id is what matches a returned vector back to its exact
   chunk.
2. A JSONL request file is uploaded, a batch created, and an `embed_batch_poll` job
   enqueued.
3. The poll runs every 5 minutes. While the batch is open it re-queues itself; a
   still-open batch is not a failure, so `attempts` stays meaningful for real errors.
4. On completion the output JSONL is streamed line by line, vectors are normalized
   exactly as on the synchronous path (so batched and synchronous embeddings stay
   comparable by dot product), and applied to their chunks.
5. Documents are settled: `indexed` only if they actually have embedded chunks,
   otherwise `failed` with a retry hint.

**A document mid-batch is never searchable and never "ready."** Every retrieval query
already filters `embedding IS NOT NULL`, so a half-embedded document contributes
nothing rather than returning unembedded passages — and the document stays in
`embedding` status until its vectors land.

Cancelling keeps whatever vectors already arrived; a document left with none is
marked failed with a retry hint.

## The bug this phase surfaced

**A job claimed as `running` by a replica that dies was never recovered.**

I hit it by accident: `tsx watch` restarted the backend mid-parse and the job sat in
`running` forever, with its document stuck in `queued`. This is not a dev-only
curiosity — **`fusebase deploy` rolls the backend**, so any job in flight during a
deploy would have stranded its document permanently, and the batch path makes it
worse because a batch legitimately outlives any single replica.

Fixed with `reclaimStaleJobs()`: a `running` job whose `locked_at` is older than 20
minutes goes back to `queued`. `attempts` is deliberately **not** incremented — the
job never got a fair run, so charging it an attempt would burn the retry budget on an
infrastructure event. Textract's own ceiling is 10 minutes, so 20 sits clear of the
longest legitimate run.

There is a matching `requeueOrphanedBatches()` for batches whose poll job vanished.
Both run on a 10-minute sweep in the worker and on the drain webhook.

Verified live: a stranded job was aged past the threshold, the drain reported
`reclaimed: 1`, the job requeued, re-ran, and resumed its normal retry sequence.

## A second bug: the OCR heuristic rejected readable documents

The old rule sent a document to OCR when **half its pages had under 80 characters**.
A two-page report whose conclusion page held 63 characters therefore tripped it — and
because OCR is unconfigured, the document was **rejected outright** rather than
indexed from the text layer it plainly had. Found while verifying the pipeline: the
same PDF extracted fine directly but failed inside `ingestDocument`.

(The first suspicion was file-service corruption, so the round trip was checked:
upload -> fetch came back **byte-identical**, sha256 matching, and re-extracted
cleanly. Storage was never at fault.)

The rule is now: a page counts as empty under **24** characters — a scanned page
yields ~0, a short real page yields a few dozen — and OCR requires **60%** of pages
to be empty **and** the whole document to hold under **200** characters. Both
conditions must hold, so a short document with one blank page is still indexed. Pages
with no text layer are reported in the document's status detail instead of being
silently dropped.

Remaining limitation: this is a whole-document decision. A genuinely mixed PDF (some
scanned pages, some text) is indexed from its text pages, and the scanned ones are
counted in the status detail but not OCR'd. Per-page OCR is what `source_kind: 'hybrid'`
in the schema is reserved for.

## Indexing dashboard

`GET /api/indexing/{workspaceId}` — readable by any workspace member, because knowing
why your document is not searchable is not privileged information. Maintenance
actions require admin.

The snapshot is **one batched read** (`runIsolatedStoreSqlBatch`), for two reasons:

- Every isolated-store call pays a ~250 ms floor, and the panel polls every 4 s while
  work is in flight — 5 sequential reads would cost over a second per poll.
- All five result sets come from **one transaction**. My first version used separate
  calls and I caught it reporting `statusCounts: {embedding: 1}` next to a document
  row saying `parsed` — the same table read at two different moments. A dashboard
  that contradicts itself is worse than a slow one.

The UI surfaces `chunksEmbedded / chunksPresent` per document rather than hiding
behind a status word, because that ratio is what actually decides whether a document
can be cited. Actions: retry all failed jobs (resets attempts), re-index everything
unsearchable, check or cancel a batch.

## Permanent e2e suite

Scaffolded with `fusebase scaffold --template e2e`, per the `app-e2e-tests` skill.
**29 tests in 10 files**, one Playwright project per app.

App environments had to be adopted first (`fusebase config set-flag environments`
then `fusebase env init --name prod`) because the harness resolves base URLs from
`environments/<name>.json`. `prod` is marked `protected: true` — it is a real org.

| Spec | Covers |
| --- | --- |
| `specs/common/**` (scaffolded) | Stage guard, deployed env contract, anonymous auth flow |
| `citations.spec.ts` | Citation jump + highlight; **cross-document routing** asserting the highlighted paragraph belongs to the right report |
| `viewer.spec.ts` | Canvas **pixel sampling** (a blank raster fails), thumbnails, page count, byte-proxy 404 |
| `chat-widget.spec.ts` | Ctrl+J, Escape, drag persistence across reload, off-screen geometry clamping |
| `access-control.spec.ts` | Viewer denied upload/caps/audit/retention; tenant isolation on every path; foreign document rejected from chat scope |
| `grounding.spec.ts` | Exact refusal sentence with nothing in scope; budget `429`; out-of-range caps |
| `indexing.spec.ts` | Snapshot self-consistency; an `indexed` document must have embedded passages |
| `grounded-answer.spec.ts` | The real model path — **self-skips** unless the deployment reports `openAiConfigured` |

Design notes:

- Specs sign in via a platform **magic link** (no password). A Gate token cannot
  stand in for an app session — I verified it 401s against `/v4/api/users/me` — so
  the harness's fixture path is the only option.
- Every spec **self-skips** when the `owner` fixture is absent, per the skill's
  fixtures-roll-out-per-env rule.
- Assistant messages with citations are **seeded** via Gate SQL, clearly marked as a
  fixture: only the model can produce that row through the product, and seeding lets
  the citation UI contract be tested on every run without spending tokens. The real
  path is covered separately by `grounded-answer.spec.ts`.
- Tests clean up everything they create.
- Two stable hooks were added to app code for assertions: `data-rendered` on a page
  (a completed raster, so tests wait on fact rather than timing) and
  `data-highlight-key` on the overlay.

CI: `.gitlab-ci.yml` at the repo root. A `static` job (lint + typecheck) runs on MRs
and the default branch. The `e2e` job runs **on a schedule or manual trigger only**,
because the only environment is protected production. Add a non-protected env
(`fusebase env add prod-test …`) and it can run per-MR.

## What is verified, and what is not

**Verified live** (dev stage, real store):

- Migration v2 applied to both stages, no drift.
- Indexing snapshot: pipeline health, job queue, usage totals; self-consistent after
  the batching fix.
- Batch settings validated end to end, including the two rejection paths
  (`batchEmbeddingMinChunks` out of range, non-boolean `batchEmbeddingEnabled`).
- `retry-failed`: a job exhausted at 3/3 was requeued with attempts reset to 0 and
  its document returned to the pipeline.
- `reindex-unsearchable`: enqueued the one document with zero embedded chunks.
- Stale-lock reclaim, described above.
- Unknown batch ids return 404, not 500.
- Lint, typecheck, build, `fusebase api validate` (32 operations) all clean.

**Verified against the real OpenAI API** (credits added; 17/17 checks, plus 10 more
on batch output):

- Embeddings: 256 dims, unit-normalized (|v| = 1.000000000), usage reported, and the
  space is semantically ordered (related 0.867 vs unrelated 0.135).
- Generation: the model answers from context and emits `[^N]` markers; usage reported.
- **A hallucinated citation marker is stripped** — `[^7]` pointing at a passage that
  was never supplied is removed, leaving only the real `[probe.pdf, Page 1]`.
- Full synchronous ingest: 2 pages -> 2 chunks -> 2/2 vectors at 256 dims.
- A real cited answer, grounded, citing the correct document and page (score 0.774).
- **Page-exactness**: a fact on page 2 is cited as page 2, not page 1.
- The zero-hallucination refusal, verbatim, on an unanswerable question.
- **Batch API, end to end against the provider**: submission accepted
  (`batch_6a9a00f0…`), chunks written with no vector so they cannot be retrieved,
  status readable, batch reached `completed` (2/2, 0 failed), and the JSONL output
  parsed into 2 vectors of 256 dims with `custom_id` round-tripping as the chunk uuid.
  Batch vectors normalize to unit length (raw 0.999957 -> 1.000000000), so they are
  directly comparable with synchronous ones, and two distinct passages produced
  distinct vectors (cosine 0.5744).

**Still not verified:**

- The e2e suite **has never been run**: it targets a deployed app, and the app has not
  been deployed. `npx playwright test --list` resolves the environment and discovers
  all 29 tests, so the harness is wired correctly, but that is not the same as green.
- The **in-database apply step** of the batch path (writing returned vectors onto
  chunk rows) was not observed on a completed batch: transient Gate `408`s aborted the
  run while the batch was still in progress, and by the time it completed the probe
  chunks had been cleaned up. Every piece around it is verified.
- OCR remains unconfigured.
- `OPENAI_API_KEY` is still **not set in the FuseBase UI**, so the app itself
  (`openAiConfigured: false`) cannot yet index or answer. `fusebase secret` only
  declares key names; values are UI-only, and `fusebase dev start` builds the backend
  env from platform secrets rather than the shell.

## Known gaps and follow-ups

1. **Batch token metering is incomplete.** OpenAI does not report per-line token
   counts in batch output, so a completed batch records `inputTokens: 0` with the
   chunk count and the halved unit price in metadata. Month-to-date token totals
   therefore understate bulk ingest. Fix by reading the batch's own usage field if
   the API exposes one, or by estimating from chunk `token_count`.
2. **Quota errors are now permanent, not retried.** OpenAI returns both rate limiting
   and "out of credits" as 429. Retrying an exhausted balance is pointless and burned
   the whole retry budget (3 attempts plus 30s/60s backoff) before the actionable
   message reached the user, so `insufficient_quota` / `credit_balance_exhausted` /
   `billing_hard_limit_reached` now fail the job immediately. Found by hitting it.
3. **One batch per document.** `embedding_batches.document_ids` is an array and the
   settlement logic already handles several, but submission currently creates one
   batch per document. Coalescing a burst upload into a single batch would cut the
   per-batch overhead; the schema is ready for it.
4. **Batch polling depends on a warm replica or the drain webhook.** With
   `minReplicas: 1` the in-process worker covers it, and the reaper plus the webhook
   are the safety nets. A `fusebase job create` cron calling the drain endpoint would
   make it independent of the live backend entirely — worth adding for a 24-hour
   window.
5. **The e2e suite needs a non-protected environment** to be genuinely useful in CI.
   Right now it can only be run manually against production.
6. **`files.write` remains in the browser token** (Phase 1 carry-over; the CLI flag
   only moves `isolated_store.*`).
7. Retention is still stored but not enforced (Phase 4), and RLS policies are still
   unwritten even though `bypassRls=false` makes them possible (Phase 4).

## Running it

```bash
# schema
node scripts/sql-migrate.mjs status --stage prod
node scripts/sql-migrate.mjs apply  --stage prod

# locally
fusebase dev start apps/compass-ai

# publish (permissions are not published by deploy)
fusebase app update jkbjijn0ndnorxzp --sync-gate-permissions --declare-backend-only-gate-permissions
fusebase deploy

# e2e, once deployed
cd tests/e2e && npx playwright install chromium
FUSEBASE_ENV=prod npm test
```
