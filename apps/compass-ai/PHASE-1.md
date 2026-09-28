# Compass AI — Phase 1 handoff

Foundations and RAG core. This document is the record of what exists, what was
decided and why, and what is required before Phase 2.

## Platform artifacts

| Item | Value |
| --- | --- |
| App id | `jkbjijn0ndnorxzp` |
| App path | `apps/compass-ai` |
| Subdomain | `compass-ai` |
| Org id | `u27b70` |
| FuseBase PostgreSQL Database | alias **`compasses`**, store `a1174ace-30d0-449c-b438-00df75d2cccf` |
| Stages | `dev` and `prod`, both at migration **v1 `init`** |
| Migration checksum | `9038b3b1fa8d05d984e645b0ac674bba93edb82a6a8c31c115bbc4bb8bc4fff1` |
| Gate permissions (browser) | `files.write` |
| Gate permissions (backend-only) | `isolated_store.read`, `isolated_store.data.write` |

`storeId` lives in `fusebase.json` (`apps[].isolatedStores.sql[]`) for the CLI
migration command only. Runtime code never reads it: the backend resolves the
store through Gate by the stable alias `compasses`.

## Decisions that shaped the build

### pgvector is not available — vectors are 256-dim arrays scored in SQL

`vector` 0.8.2 exists on the managed host, but `azure.extensions` is empty and the
runtime role is not `azure_pg_admin`. A probe apply confirmed it:

> extension "vector" is not allow-listed for "azure_pg_admin" users in Azure Database for PostgreSQL

(The failed apply rolled back without consuming migration slot v1.)

So embeddings are stored as `DOUBLE PRECISION[]`, unit-normalized on write, and
scored with `public.vec_dot()` — an in-database dot product, which equals cosine
for unit vectors. To keep that scan fast, `text-embedding-3-large` is truncated to
**256 dimensions** via its `dimensions` parameter.

Measured on this server (5,000 chunks, one query):

| Dimensions | Scan time |
| --- | --- |
| 256 | ~370 ms |
| 1024 | ~1,470 ms |

Cost is linear in dimensions, so 256 is the point where an exact scan stays inside
the latency budget. The scan is additionally filtered by workspace and the chat's
active document set, so it is proportional to the documents in the conversation,
not the whole corpus.

**Consequence to plan for:** this is an exact scan with no ANN index. It is fine
for the thousands-of-chunks range. Past roughly 50k chunks in one chat scope,
either pgvector must be enabled by the platform or a coarse prefilter added.

### Chunks never span a page boundary

Citation exactness is the product promise, and a chunk covering pages 4–5 can only
cite one of them — silently mis-attributing the other half. Chunks are therefore
page-bounded, so `[Document, Page X]` is correct for every sentence in the chunk.
Section titles do carry across pages, because a section genuinely continues.

### Citations are enforced, not requested

The model is told to mark each key statement with `[^N]` referring to a numbered
context passage. The backend then rewrites those markers into
`[Document, Page N]` **by looking up the passage that was actually retrieved**, and
**deletes any marker pointing at a passage that was not in the context**. A
fabricated citation cannot reach the UI.

When retrieval returns nothing above the relevance threshold, the fixed sentence is
returned *without calling the model at all* — no tokens spent, no chance of an
ungrounded answer.

### The whole write path avoids `isolated_store.execute`

Runtime app tokens are not normally granted `isolated_store.execute`. Testing
against the live store confirmed the structured row API binds `double precision[]`
and `text[]` natively, so every write goes through structured row operations and
only `isolated_store.data.write` is needed. Reads use `queryIsolatedStoreSql`
(parameterized, never interpolated) because the similarity scan needs real SQL.

### Ingestion is queued, not inline

A long document exceeds the platform's 30s request ceiling, so upload stores the
file, enqueues a job, and returns `202`. Jobs are claimed with a compare-and-set
`UPDATE ... WHERE status = 'queued'`, so multiple replicas can drain the queue
without double-processing. `backend.minReplicas: 1` keeps a replica warm;
`POST /api/webhooks/ingest-drain-8fbc21d7a4e35b90` is an idempotent safety net for
jobs orphaned by a recycled replica.

Transient failures retry with exponential backoff (30s, 60s, 120s) up to 3
attempts before the document is marked failed — so an OpenAI or Textract outage
does not look permanent.

## Schema map (`compasses`, schema `public`)

15 tables plus `fusebase_schema_migrations`.

| Table | Purpose |
| --- | --- |
| `workspaces` | Tenant boundary. `retention_days` drives the retention policy. |
| `workspace_members` | `role` ∈ owner/admin/member/viewer, unique per (workspace, user). |
| `workspace_settings` | Cost caps, OCR feature flags, default retrieval mode. |
| `documents` | One row per PDF. `stored_file_uuid` + `read_url` only — never bytes. |
| `document_pages` | Extracted text per page, with `extracted_by` and OCR confidence. |
| `document_paragraphs` | Stable `paragraph_key` (`p<page>-<index>`) plus normalized `bbox`. |
| `document_chunks` | The retrieval index: text, `embedding`, page/paragraph provenance, `fts`. |
| `ingest_jobs` | Pipeline queue with attempts, backoff and worker lease. |
| `chats`, `chat_documents`, `chat_messages` | Sessions, active document scope, transcript with `citations`. |
| `usage_events` | Per-workspace token/OCR metering with cost computed at write time. |
| `audit_logs` | Immutable trail of uploads, deletions, membership and settings changes. |
| `rag_traces` | Per-step pipeline timings (`embed_query`, `retrieve`, `generate`, `ingest`). |

Key column mapping for the retrieval index:

| Column | Type | Notes |
| --- | --- | --- |
| `embedding` | `double precision[]` | 256 dims, unit-normalized |
| `embedding_model` / `embedding_dims` | `text` / `int` | recorded per chunk for re-index safety |
| `page_number` | `int` | the citation page; equals `page_start` and `page_end` |
| `paragraph_key` | `text` | primary highlight target |
| `paragraph_keys` | `text[]` | every paragraph in the chunk |
| `fts` | `tsvector` (generated, GIN) | unused in Phase 1; unblocks Phase 5 hybrid retrieval |

Deletion integrity: pages, paragraphs and chunks all cascade from `documents`, so
no index entry can outlive its document.

## Role matrix (enforced in the backend, verified end to end)

| Action | Minimum role |
| --- | --- |
| Read documents, chat, read settings | viewer |
| Upload, delete documents, delete chats | member |
| Change cost caps, re-index, read audit log | admin |
| Manage members, set retention | owner |

A non-member receives `404`, not `403`, so workspace existence is not leaked.

## What was verified against live infrastructure

- Migrations applied to **dev and prod**; both journals at v1, no drift.
- RLS status: `bypassRls=false`, `superuser=false` — native enforcement *is*
  available on this host (see Phase 4 note below).
- Store resolution by alias from the backend service token.
- Identity from the app token, auto-creation of a default workspace, owner role.
- PDF parse: 2-page PDF → correct per-page text, 7 paragraphs with plausible
  normalized bounding boxes, `needsOcr=false`, page-bounded chunks with correct
  section titles.
- Upload → Gate file service → `documents` row → job enqueued.
- Content-hash deduplication returns the existing document instead of re-indexing.
- Retrieval SQL end to end via `vec_dot` (score matched the hand-computed dot
  product exactly).
- Zero-hallucination path: the fixed sentence, no model call, no tokens billed.
- Role matrix: viewer blocked from upload / caps / audit / retention, allowed to
  read.
- Tenant isolation: another workspace's documents are invisible on list, read,
  delete and page endpoints, **and** cannot be pulled into a chat's document scope.
- Cost caps: out-of-range settings rejected with a specific message; an exhausted
  monthly token budget returns `429` before any paid call.
- Retry then fail: the embed step retried on backoff and finally surfaced an
  actionable error.
- Deletion cascade: pages, paragraphs, chunks and jobs all removed; audit row
  written.
- `fusebase api validate` (26 operations), root `npm run lint`, root
  `npm run typecheck` — all clean. No `any` or broad casts on SDK JSON.

## Not verified — requires credentials

`OPENAI_API_KEY` is registered but has no value, so **embedding, indexing and
answer generation have not been executed against the real APIs**. Everything up to
the embed call is verified; the embed call itself, the generation call, and
therefore a real cited answer are not.

The same applies to OCR: `isOcrConfigured()` is currently `false`, so scanned PDFs
are reported as not indexable rather than failing obscurely.

Set the values here — the CLI prints this URL on `fusebase deploy` /
`fusebase dev start`:

- `OPENAI_API_KEY` — required for any indexing or answering
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `TEXTRACT_S3_BUCKET` — required only for scanned-PDF OCR

The Textract path uses the **asynchronous** API (`StartDocumentTextDetection`),
which reads from S3. That is why a bucket is needed: it avoids rasterizing pages
in-process, which would require a native canvas build. PDFs are staged there and
deleted in a `finally` block after OCR.

## Known gaps and follow-ups

1. **`files.write` is still in the browser token.** The SPA never calls the file
   service directly — uploads are brokered on the backend — but
   `--declare-backend-only-gate-permissions` only moves `isolated_store.*`. The
   store permissions are backend-only, so app data is safe; this is worth raising
   with the platform.
2. **RLS policies are not written yet.** Access control is enforced at the single
   backend choke point, which is sound because the browser token has no store
   access. But `bypassRls=false` means real PostgreSQL enforcement is available, so
   Phase 4 should add policies keyed on the platform-injected `app.user_id` as
   defence in depth. Until then, do not describe this app as row-level-secured.
3. **Token counting for chunk sizing is an approximation** (character/word
   heuristic). It only affects chunk sizes and the retrieval budget — all billing
   and metering use the token counts OpenAI returns.
4. **Retention is stored but not enforced.** `workspaces.retention_days` is
   settable and audited; the job that purges expired documents is Phase 4.
5. **Batch embeddings API is not used yet.** Bulk ingest currently uses the
   synchronous embeddings endpoint in batches of 96. The Batch API is Phase 3.
6. **Paragraph detection is geometry-based.** It handles headings and uniform
   leading well, but multi-column layouts and tables will merge imperfectly.
   Textract's structural output is a better source for those (Phase 5).

## Phase 2 readiness

The data contracts the viewer needs already exist and are populated:

- `GET /api/documents/{id}/paragraphs?page=N` returns `paragraph_key` plus a
  normalized top-left-origin `bbox`, ready for a PDF.js overlay.
- Every citation carries `documentId`, `page`, `paragraphKey` and `chunkId`, so a
  click can jump to the page and highlight the exact region.
- `documents.read_url` is a stable public URL for the PDF.js document source.

## Commands

```bash
# schema (repo-owned, SDK path — avoids the MCP body-size limit)
node scripts/sql-migrate.mjs status  --stage dev
node scripts/sql-migrate.mjs apply   --stage prod
node scripts/sql-migrate.mjs rls     --stage dev

# run locally
fusebase dev start apps/compass-ai

# publish (permissions must be synced separately from deploy)
fusebase app update jkbjijn0ndnorxzp --sync-gate-permissions --declare-backend-only-gate-permissions
fusebase deploy
```
