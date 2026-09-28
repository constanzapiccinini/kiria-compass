# Compass AI — Phase 4 complete

Final state of the Phase 4 portal model. Companion to [PHASE-4A.md](./PHASE-4A.md),
[PHASE-4BC.md](./PHASE-4BC.md), [PHASE-4D.md](./PHASE-4D.md) and
[PHASE-4D-PLUS.md](./PHASE-4D-PLUS.md).

## §14 phase checklist

| Phase | State |
| --- | --- |
| **4A** portal tenancy | Done. Cross-portal exit criterion is manual — see below |
| **4B** sources, sync, folders | Done, both source modes verified against real data |
| **4C** admin app, 8 screens | Done. Screens confirmed in a browser; every read route tested |
| **4D** alerts, 12 codes, channels | Done. Email proven end to end |
| **§4.3** row-level security | Done, v7→v10, Postgres-enforced, measured both directions |
| **§9.4** admin upload | **Done this session** — with delete, verified end to end |

## Admin upload — §9.4, the last functional gap

`POST /api/documents?clientId=…` (multipart) and `DELETE /api/documents/:id`, plus an
upload panel and a delete action on screen 4. **Verified end to end against
production**, not just typechecked:

```
upload  → 201, results[0].status = "queued"
pipeline → indexed, 2 pages, 2 chunks, source_kind app_upload, visible: 1
re-upload same bytes → "duplicate", not re-embedded
non-PDF → 207 with per-file reason, request not failed
delete  → 202, row leaves the client's live set
```

Design points worth keeping:

- **The client id comes from the query string**, which would be a `TENANCY_PROBE` in
  the client app. Correct here: the authorization question is "is this caller staff",
  answered by `requireAdmin`.
- **`%PDF` header, not the extension.** A renamed `.docx` would otherwise be stored,
  queued and fail in the parser, where the message is far less clear.
- **Dedupe on content hash, not filename** — the same document re-sent under a new name
  would otherwise be embedded twice at full cost and answer questions twice over.
- **207, never 4xx, for per-file refusals.** The admin client throws on any non-2xx and
  keeps only the message, so a 400 would discard exactly the detail the operator needs.
  Per-item outcomes belong in the body; the status describes the request.
- **Delete soft-deletes first, then enqueues the purge.** The soft delete is what
  revokes client access, in the same request; the purge is the client worker's job,
  using the same `purgeDocument` the client app uses. If the worker never runs the
  document stays invisible rather than half-deleted and readable.
- **No pipeline logic in this app.** Upload and delete enqueue into the shared
  `ingest_jobs` table; parsing, chunking and purging stay in one place.

### A bug I introduced and shipped, found by testing it

The first upload attempt returned **500**. `ensureAppUploadSource` filtered on
`archived_at IS NULL`, and **`document_sources` has no such column** — I invented it.

The important part is where else it was: I had written the same function in the
**client app** an hour earlier and deployed it, so **the client portal's upload was
broken in production too** — every upload 500ing. Nothing caught it because the client
upload had not been exercised since. Both are fixed and both redeployed; the admin
upload test now covers the shared shape.

The lesson is the one this session keeps producing: a helper that only runs on a path
nobody exercises is indistinguishable from a broken one.

## The suite, and a self-inflicted failure worth recording

**31 passed, 29 skipped, 0 failures** at `--retries=0`, stable across two consecutive
runs.

Getting there required undoing something I had done wrong earlier in the session. I
switched six specs from the `owner` fixture to `staff`, believing it unblocked 17
tests. It did not: those specs need a **portal-bound** session, so all it did was turn
17 clean skips into 14 raw `401 PORTAL_SESSION_ANONYMOUS` failures.

Worse, the fix I applied first — adding `portalBoundSessionOrSkip` — still signed in
*before* skipping. Each sign-in mints a magic link, the platform serves a limited
number for one address, and the result was **five `waitForSelector('#root')` timeouts
across unrelated specs** that read exactly like a broken deployment. Lowering the
worker count made it worse: the problem was total activations, not concurrency.

The gate is now at describe level, **before** sign-in
(`portalBoundSessionAvailable()`), with the reason written out and
`COMPASS_PORTAL_BOUND_SESSION=1` to attempt them anyway. The specs are one env var
away from running the day a portal session becomes obtainable.

Also fixed: the admin upload spec built identical PDF bytes every run, so the second
run deduplicated against the first and failed. Content is now stamped per run — and
the spec deletes what it uploads, **asserted rather than best-effort**, because this
runs against a live organisation and an accumulating test PDF would be visible to a
real client.

## The store hazard — root cause, finally

Six times I reported that `fusebase deploy` "re-selected" a stray store. That was
wrong. Deleting the stray proved it: the next deploy **created another**.

Deploy's provisioning step looks for the alias `<declared>-<environment>` —
`compasses-prod` for the prod environment — and, not finding it, provisions a brand new
empty store and rewrites `environments/prod.json` to point at it. The real store is
aliased plain `compasses`, and Gate exposes no rename.

Closed by removing the vote rather than the symptom:

- `scripts/sql-migrate.mjs` resolves the store **by alias through Gate**;
  `fusebase.json` is a hint, and a disagreement is warned about, not obeyed.
- `isolatedStores` is no longer declared for either app, so deploy provisions nothing.
  Nothing is lost: what it was applying migrations to was the phantom.
- Both stray stores deleted after verifying they were empty in every table.

**Verified:** two consecutive deploys provision nothing, one store remains, and the
environment file is no longer rewritten.

## Folder organisation moved to the admin, where it belongs

Folders are organised **only** from the admin — a product decision that corrected
something I had built wrong. I had put a drag-to-reorder interaction in the client
sidebar, and discovered while trying to verify it that **no UI anywhere could create a
folder**: the client backend had `POST /api/folders` and no caller, there were zero
folders on prod, and the reorder I had just shipped sat on top of a feature a user
could not reach.

Now:

- `apps/compass-admin/backend/src/lib/folders.ts` — create, rename, reparent, reorder,
  delete, with the cycle and depth rules. A **verbatim copy** of the client app's,
  because the two apps share no code by platform design. `ensureFolderPath` stays only
  in the client, where sync needs it. **A correctness fix to either must be applied to
  both**; they were copied rather than rewritten precisely so they cannot diverge on
  day one.
- `FolderTreePanel` on admin screen 4: create with a parent picker, rename inline,
  reparent via a select, reorder with up/down buttons, delete with a confirmation that
  says what happens to the children.
- The client sidebar's drag interaction and the `PUT /api/folders/order` route it
  called are **removed**. Two places able to reorder the same tree is one more than
  there should be, and dead interactive code is worse than none — someone rewires it
  believing it is supported.

**Buttons, not drag-and-drop.** A pointer-only tree editor excludes keyboard users, and
arrow buttons are unambiguous about which sibling set is being reordered, which a drop
indicator between two nested rows is not. The parent picker also omits the folder's own
descendants, so an operator cannot choose a move the backend will refuse.

### Verified against the real database

`specs/compass-admin/folders.spec.ts`, passing:

```
create at root and nested   → depth 0 and 2
cycle (A under descendant C) → REFUSED, and nothing changed
folder as its own parent     → refused
reorder                      → positions actually change
partial sibling list         → refused
legal reparent               → accepted, depth recomputed
delete                       → child lifted to grandparent, depth recomputed
cleanup                      → asserted, no folder left for a client to see
```

The "nothing changed" assertions matter more than the refusals. A move that validates
late writes some rows before failing, and a half-applied reparent detaches a subtree
from the root permanently — the rows survive with nothing able to list them again.

## Three alert codes fired for real

On prod, with email temporarily switched off so a test did not mail a real inbox, then
restored. Deliberately broken sources, synced, verified, deleted:

| code | cause it produced |
| --- | --- |
| `SOURCE_CONFIG_INVALID` | named the exact bad item key and explained keys are opaque ids, not labels |
| `SOURCE_SYNC_FAILED` | named the source and the underlying query failure, with the partial counts |
| `OCR_BUDGET_REACHED` | "used 0 of its 0 OCR pages this month", plus the client-safe message |

Each carried the right severity and its hand-written remediation. The first is
`readViewItemKeys` — the schema check added after a unit test caught that no regex can
tell an item key from a column label — surfacing through the alert path end to end.

**Two codes I had listed as fireable are not.** `TOKEN_BUDGET_REACHED` raises inside
the ask route, and `PORTAL_NOT_BOUND` / `PORTAL_NO_SOURCE` inside portal resolution;
all three need a portal-bound session, which cannot be obtained. I was wrong to say
otherwise.

**A consequence worth knowing:** deleting a source deletes its alerts, because
`system_alerts.source_id` is `ON DELETE CASCADE`. Convenient for cleanup here, but it
means removing a misconfigured source also removes the record that it was failing.

**And one about the tests:** the tenancy suite raises a real `TENANCY_PROBE` alert on
every run, since probing tenancy is exactly what it does. After a test run the inbox
shows a critical that is not an incident. Resolve it, or read the `cause` — it names
the route and says the request was refused.

## FORCE ROW LEVEL SECURITY — enabled, after answering the question

Deferred twice with a stated prerequisite: FORCE applies policies to the table owner,
and the owner runs migrations and platform checkpoints. `createIsolatedStoreCheckpoint`
takes a physical `pg_dump`, so a wrong answer meant a backup that silently captured
zero rows.

Answered from `pg_roles` rather than assumed:

| role | owns tables | `rolbypassrls` |
| --- | --- | --- |
| `isolated_pg_migrator` | **yes** (24 tables) | **true** |
| `isolated_pg_rls_bypass` | no | true |
| `isolated_pg_runtime` | no | false |

**BYPASSRLS outranks FORCE.** A role holding it is never subject to policies, forced or
not — so FORCE cannot affect migrations or `pg_dump`, both of which run as bypassing
roles, and the one role it could affect is already fully subject under plain ENABLE
because it does not own the tables.

So `0011_rls_force.sql` is behaviourally a no-op today, and worth applying anyway: it
clears 23 warn-level findings so a real future warning is not lost among them, and it
is the correct posture if a table is ever re-owned or the app ever runs as its owner —
at which point the absence of FORCE would silently disable every policy in the schema.

Applied to dev and prod. Reads still return rows, client scoping still filters in both
directions (client A: 0 chunks; client B: 148), and Gate's manifest validation is now
**0 warnings**, down from 15 unclassified-and-unprotected tables.

## What is genuinely left

1. **The manual runbook** (`tests/manual/portal-isolation.md`) — done and passing, per
   the operator. It stays the only possible coverage for cross-portal isolation and for
   client-visible-vs-employee-visible, because both need a session minted through the
   portal launcher and Gate exposes none. Reconfirmed with an org `manager` who is a
   member of both portals: still anonymous. That is the tenancy property working.
2. **7 of 12 alert codes have never fired.** Three need infrastructure failure
   (`STORE_UNAVAILABLE`, `LLM_TIMEOUT_REPEATED`, `BATCH_EXPIRED` — the last needs a
   24-hour OpenAI batch to expire), one needs an invalid OpenAI key
   (`DOC_EMBED_FAILED`), one needs OCR configured to fail rather than be absent
   (`DOC_OCR_FAILED`), and three need a portal-bound session. All are wired; none are
   exercised.
3. **`monday` channel** is a stub, which is what §10.3 asks for in v1.
4. **The admin folder panel has not been opened in a browser.** Every endpoint behind
   it is tested against the real database, which is not the same thing.

## Deployed

| App | Version |
| --- | --- |
| compass-ai | `vttljamifstovdsb` |
| compass-admin | `gvgkweyo9v2kimps` |

Schema **v11** on dev and prod, no drift, **0 RLS warnings**. Suite **32 passed, 29
skipped, 0 failed** at `--retries=0`. Lint, typecheck and the unit test clean.
`compass-admin` publishes **44 operations**, verified one-for-one against its routes.
