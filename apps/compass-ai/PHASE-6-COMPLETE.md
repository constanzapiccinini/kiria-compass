# Phase 6 — Libraries are the only way in, and FuseBase is the source of truth

**6A** shipped to production on 2026-09-08; **6B**, the schema prune, on 2026-09-09.
Schema at **v19** in both `dev` and `prod`; both apps deployed and serving.

§6 below covers 6B — read it with §2, because the prune found a fourth bug and a
fifth, and one of those had been live for a day.

This is what changed, what it cost, and the **six** bugs the phase found — three of
which were already in production and invisible, and one of which this phase shipped
itself and then caught a day later.

---

## 1. What a document is now

Before: a document belonged to a **tenant** (`client_id`) and reached a portal through
a **source binding**. Every portal got an `app_upload` source whose only job was to be
the thing `documents.source_id` pointed at, because a document with no source was
visible in zero portals.

After: a document belongs to a **library**, and a library reaches a portal because
someone ticked it. There is one mechanism, not two.

The whole of §6A follows from that sentence:

| | before | after |
| --- | --- | --- |
| a document is owned by | `client_id` | `library_id` |
| a folder is owned by | `client_id` | `library_id` (0015) |
| a portal's private files | an `app_upload` source | a private library, `<Portal> — files` |
| documents are listed by | `GET /api/documents?clientId=` | `GET /api/libraries/:id/documents` |
| indexing health is read by | `?clientId=` | `?portalRowId=` |
| the client sidebar groups by | folder, with one Unfiled bucket | **library**, each with its own tree and its own Unfiled |

### The migration

`scripts/migrate-uploads-to-libraries.mjs`, run on `dev` then `prod`. Its own
before/after assertion is the product; everything else it prints is bookkeeping:

```
== per-portal visible documents, before ==   == after ==
  client-a-portal: 1                           client-a-portal: 1
  client-b-portal: 0                            client-b-portal: 0
  Compass Client B: 0                           Compass Client B: 0
  kiria-template: 0                             kiria-template: 0
  (embedded chunks in total: 176)               (embedded chunks in total: 176)

PASS — every portal sees exactly what it saw before
```

One tenant (`CLIENTE B`) owns two portals, so its library was created **shared** rather
than private — `is_private` promises one portal, and a private library ticked twice is
a promise broken through a path the API would refuse with a 409. The script decides
this per tenant and says so.

`Client Portal Template` ended up with two documents and no ticks. Those were invisible
before the migration and still are, which is correct — §6.5.5 asks for exactly that —
and the script reports them so nobody has to discover it later.

Afterwards, `scripts/retire-app-upload-sources.mjs` removed the four remaining
`app_upload` bindings and archived all six sources. Archived, not deleted: they are
inert either way, `documents.source_id` is still a live column for a tenant-owned row,
and **6B is the release that prunes what stopped being written** — deleting them now
would be that pruning under another name.

---

## 2. Bugs 1-4, and where each was hiding

### 2.1 The migration doubled a portal's visible count (caught on dev)

A document moved into a library kept its old `source_id` and gained a `library_id`. Both
arms of `portal_visible_documents` then matched it and the portal saw it **twice**.

0014 shipped that view with a comment asserting the arms were disjoint, reasoning that
"0013's XOR check means a document has either a client or a library". The first half is
true; the second half was an assumption. The XOR check constrains `client_id` against
`library_id` and says nothing about `source_id`.

Fixed three ways, because a convention that has already failed once is not a guarantee:

- the migration clears `source_id` when it moves a document;
- a repair pass runs on every invocation and fixes rows an earlier run left behind;
- **`0018_library_has_no_source.sql`** makes it impossible:
  ```sql
  CHECK (library_id IS NULL OR source_id IS NULL)
  ```

Verified against production before applying: zero violating rows.

### 2.2 A duplicate folder name returned a raw 500 — and the fix was wrong (see §7)

`0015` dropped `document_folders_sibling_name_key` and replaced it with **two** partial
indexes over `COALESCE(parent_id, '000…')` — which is what finally catches two *root*
folders of the same name, since NULL parents never compare equal.

Both `catch` blocks in `lib/folders.ts` were still matching the old constraint name. So
the 409 the UI knows how to render never fired, and creating a folder with a name a
sibling already had produced an unexplained server error. Found by writing the test the
phase asks for (`§7 · duplicate-sibling refusals, root folders included`) and watching
it fail on the wrong status code.

### 2.3 The indexing screen showed nothing at all

`GET /api/indexing` was scoped `WHERE client_id = $1` throughout — documents, status
counts, jobs and cost. **A library document has `client_id = NULL` by design.** So the
moment §6.5 moved every upload into a library, the screen reported zero documents, zero
jobs and zero spend for a portal that was actively indexing.

This is the **third** instance of the same mistake in this codebase:

| | what was hidden | how it looked |
| --- | --- | --- |
| Phase 4 | an upload with no `source_id` | indexed, paid for, visible in zero portals |
| Phase 5 | the staff document list | 0 documents for staff, 1 for the client |
| Phase 6 | the whole indexing screen | a healthy, empty screen |

Each was invisible at runtime. The invariant §6.5 draws from them is now the one applied
everywhere and asserted statically:

> **a tenancy predicate may be a UNION term, never the whole scope.**

The route takes a `portalRowId` now and resolves both ids from one row — deriving the
portal from a caller-supplied `clientId` would be ambiguous, because production has a
tenant that owns two portals.

While fixing it: `reindex-unsearchable` copied the *portal's* `client_id` onto every job
it enqueued. For a library document that is a row with both columns set, which violates
0013's XOR check and fails the request outright. It reads the owner off the document now.

### 2.4 The admin SPA was calling routes that no longer existed

Folder mutations had been retargeted to `libraryId` on the backend while `lib/client.ts`
still sent `clientId`; `PortalsScreen` still called the rename route that §6A.4 deleted.
TypeScript cannot see any of this — a fetch URL is a string.

Guarded now, in `apps/compass-ai/backend/tests/invariants.test.ts`: every `.ts`/`.tsx`
file in both SPAs is scanned for the URL shapes the phase removed. Verified by
reintroducing a `/api/sources` call and watching it fail:

```
FAIL (§6A.1: a screen calls a route that no longer exists — the source
      routes were deleted by §6A.1) src/lib/client.ts:579
```

---

## 3. What was deleted

The table-source feature, entirely. Nothing in either environment had ever used it: six
`app_upload` sources, one library, **zero** `compasses_table` sources.

- **Admin:** `routes/sources.ts`, `lib/source-config.ts`, `lib/app-upload-source.ts`,
  `SourcesScreen.tsx`, `DocumentsScreen.tsx`, the failing-sources badge and its count.
- **Client:** `lib/sources.ts` in full — the row readers, `syncSource`,
  `enqueueDueSources`, the `source_sync` job kind and its dispatch branch, and
  `ensureFolderPath` with its private `createFolder` (its only caller was the sync).
- **Tests:** the eleven `parseSourceConfig` cases went with the parser. They were the
  codebase's one SQL-injection surface — `config.filter` was a boolean expression that
  could not be parameterised — and the surface was removed rather than defended. The
  file is now `tests/invariants.test.ts`, which is what it had actually become.

`DocumentsScreen`'s useful parts moved into the library detail view: the folder panel,
the per-document folder picker, re-index and version history. Screens are now
**Portals · Libraries · Indexing · Settings · Alerts · Usage · Audit**.

---

## 4. FuseBase is the source of truth for portals

Loading the Portals screen reconciles against the platform list, at most once every
fifteen minutes; **Sync now** forces one. The screen always states whether it ran, when
it last succeeded, and what changed — a screen that reconciles invisibly leaves an
operator unable to tell "nothing changed" from "it has not run since Tuesday".

Three decisions worth restating, because each is the opposite of the obvious one:

1. **A failed read changes nothing.** `readPlatformPortals` returning an empty list is
   reported as `{ok: false}`, not treated as "every portal was deleted".
2. **Absence never deletes.** A portal FuseBase stops listing becomes `missing` and
   keeps its tenant, documents and chats. Absence is also what a half-loaded page, a
   changed permission and a five-second outage look like.
3. **There is no rename.** The name is rewritten from the platform on every reconcile,
   so an edit made in the admin would revert within the quarter-hour — and an edit that
   silently reverts is worse than none, because it looks like it worked. The route is
   gone, and a test asserts it stays gone.

`Remove permanently` is the only destructive action in the app, behind four guards: the
portal must be `missing`, the grace period (7 days, configurable) must have elapsed, the
name must be typed exactly, and the audit row is written **before** the delete so the
record survives a failed one. Shared libraries are untouched — the tick is removed with
the portal, not the library with the tick.

---

## 5. Tests

New or rewritten: `portal-sync.spec.ts` (reconcile reporting, a forced reconcile deletes
nothing, removal refused for a live portal even with the right name typed, a private
library refuses a second tick, the rename route is gone), `folders.spec.ts` (now
library-scoped, plus duplicate roots refused and two libraries holding an identically
named folder), `upload.spec.ts` (rewritten against the library route; asserts the portal
**preview** resolves the document and names its library, which is the replacement for
the old `sourceKind === 'app_upload'` assertion), `indexing.spec.ts` (a library document
must appear in a portal's snapshot — the exact case that was returning nothing), and
`admin-smoke.spec.ts` (the deleted routes 404 for a signed-in caller).

`tests/e2e/helpers/compass.ts` — `uploadPdf` keeps its signature and now resolves the
portal's **private** library from the tenancy key. Private specifically: a shared
library would make the fixture's document visible to other portals, and a tenancy spec
asserting portal B cannot see portal A's document would then be asserting something the
fixture had made false.

### Still not covered, on purpose

- **"As a client"** for anything. Gate exposes no way to mint a portal-bound session,
  so ~25 e2e tests skip permanently; `tests/manual/portal-isolation.md` is the coverage.
  This is the gap the Phase 5 visibility bug lived in, and it is still open.
- **The reconcile transitions that need the platform to change** — renamed → renamed
  here, reappeared → restored + alert resolved. The suite cannot rename a portal in
  FuseBase. What it asserts instead are the properties that hold on every run:
  reported, and never destructive.

  **The absent → `missing` transition proved itself in production**, which no test
  here could do. `Compass Client B` (`eq94vsqm69l3ty8op0krcn5i7`) stopped being listed
  by FuseBase, and on 2026-09-09 at 09:54 the reconcile marked it `missing` and set
  `missing_since`, starting the seven-day clock. Verified afterwards, all four parts:
  `listPortals` genuinely no longer returns it; the row says `missing`; the portal
  serves nothing, because both views filter `p.status = 'active'`; and **nothing was
  deleted** — its tenant, its tick and its history are all still there. A
  `PORTAL_MISSING` alert was raised, five occurrences.

---

## 6. 6B — the prune

A separate release from 6A, which is the one rule §6B states outright: **do not prune
columns in the same release that stops writing them.** 6A shipped and served for a day
first, so if it had been wrong about something the columns were still there to roll
back into.

Physical checkpoints were taken on both stages before anything ran —
`createIsolatedStoreCheckpoint`, which produces a real `pg_dump` snapshot, not just a
revision marker. Prod is revision 18, dev revision 1.

### What went

| table | columns |
| --- | --- |
| `document_sources` | `sync_enabled`, `sync_interval_minutes`, `status`, `last_sync_at`, `last_success_at`, `last_error`, `sync_cursor` |
| `documents` | `external_id`, `external_updated_at`, `folder_pinned`, `sync_status` |

Plus `document_sources_due_idx` (the index the scheduler scanned),
`documents_source_external_key` (what made a sync idempotent), `kind` and
`owner_kind` collapsed to `'library'`, and `'source_sync'` removed from the
`ingest_jobs` kind check. Both visibility views were rebuilt without `sync_status` —
`CREATE OR REPLACE VIEW` cannot change a column list, so they are dropped and
recreated.

Losing `sync_status` also retires **orphaning**: the mechanism by which a document
whose source row vanished stopped being visible without being destroyed. Nothing wrote
it after 6A, and a library document cannot be orphaned that way — `documents.library_id`
is ON DELETE RESTRICT, so the library cannot disappear from under it. Every row in both
stages read `'managed'`.

### The DML had to be a script, not the migration

Gate rejects top-level `INSERT` / `UPDATE` / `DELETE` inside a migration bundle:
bundles are schema-only by contract. That is not a detail — **three of the schema
changes are validated against existing rows and fail without the data step first**,
because a CHECK constraint is checked against the table as it is:

- `kind = 'library'` — six archived `app_upload` rows still existed;
- `owner_kind = 'library'` — those six carried `owner_kind = 'client'`;
- the `ingest_jobs` kind check — eleven completed `source_sync` jobs across the two
  stages.

So `scripts/prune-6b-preflight.mjs` runs first. It deletes the six sources only after
verifying that **nothing** references them — not a document, a binding, an alert, a
job, a usage row or an embedding batch — and refuses by name if anything does. It
deletes only terminal `source_sync` jobs and **aborts** if one is still `queued` or
`running`, because that would mean a worker is about to look for a handler this release
deleted. And it normalises `retrieval_mode` to `'precision'`, which Phase 7 §5 asked
for: one dev settings row and one prod chat row still said `'economy'`.

Per-portal visible counts before and after, both stages, unchanged. `verify-library-rls.mjs`
is 19/19 on dev after the prune; it refuses to run on prod by design.

### Two more bugs

**A duplicate folder name was still a raw 500 — the §2.2 fix was wrong.** Matching the
error text was never going to work: writes go through Gate's structured row API, and
the error it surfaces does **not** carry the constraint or index name. So correcting
the name in §2.2 fixed nothing, and the e2e folders spec caught it against production.
The real fix is `assertSiblingNameFree`, a pre-insert check mirroring 0015's
`COALESCE(parent_id, …)` indexes exactly, so the ordinary case is a clean 409 instead
of depending on a string the platform does not promise. The catch block stays as the
backstop for the genuine concurrent-create race, and now says that is all it is.

**`GET /api/indexing` returned 500 for a day — and I shipped it.** The §6A.2 rewrite
passed all three scope arguments to every statement in the batched snapshot, while
three of those statements mentioned only two of them. Postgres refuses a prepared
statement with an unused parameter — `could not determine data type of parameter $1` —
so the whole read failed. It type-checks, it lints, the SQL reads correctly, and the
app turned Gate's 400 into a generic 500. The runtime logs named it in one line; the
guessing before that was wasted.

Fixed by giving each statement exactly the parameters it references, and guarded
statically: within one statement the placeholders used must be exactly `1..max` with
no gap. Verified by reintroducing the gap and watching it fail:

```
FAIL (a statement declares $2 but never uses $1 — Postgres cannot infer the type
      of an unused parameter and refuses the whole statement) src/routes/indexing.ts:153
```

Five guards now run on every commit: library ingest caps, §6.5 visibility, `${…}` in a
single-quoted string, calls to deleted routes, and placeholder gaps. Every one of them
exists because the thing it checks shipped broken at least once.

### A third thing the e2e run found: test data in a real client's portal

The folders spec used to borrow a portal's tenancy key, so the folders it built lived
in that client's own private library. Two of them — `e2e-mtswx86r-A` and
`e2e-mtswyu7v-A` — survived earlier runs and were sitting in `CLIENTE B — files`, a
library ticked to two real portals. A real client could see them.

They were empty and are now deleted, along with **17 leftover fixture libraries**, one
of which was still ticked to `client-a-portal` and inflating its visible count from 1
to 2. That inflated count is why the visible-count measurement is taken before and
after every operator script in this phase: it moved, and something had to say so.

`cleanup-e2e-libraries.mjs` had not been matching any of them. Its prefix guard was
`e2e-library-`, which covered only `libraries.spec.ts`, while Phase 6 gave four more
specs their own libraries (`e2e-upload-`, `e2e-indexing-`, `e2e-reject-`, and the
`e2e-<stamp>-lib` pair). Widened to `e2e-` — still a prefix nobody names a real
library with, so the safety argument is unchanged in kind.

The spec's own teardown was wrong too, and the assertion it ends with is what caught
it: folder deletes are owner-scoped, and the second library's folder was being deleted
with the first library's id — a 404 the teardown swallowed. It tracks
`{ id, owner }` per folder now.

### Also gone

`scripts/backfill-app-upload-sources.mjs` and `scripts/Coni-inventory-before-phase6.mjs`.
The first creates `app_upload` sources, a kind the CHECK no longer permits; the second
censuses non-library sources that cannot exist. Both would fail on their first
statement, which is the operator-tooling version of unreachable code — the trap this
whole phase was written to close. Git keeps them.

---

## 7. Open items

1. The open `TENANCY_PROBE` alert on production — 98 occurrences, `clientId` in the
   query string of the client app's `GET /api/documents` — **has not recurred since
   2026-09-08 18:32**, across two deploys and three full e2e runs since. That is the
   evidence for the theory that it was the e2e fixtures before §6A repaired them, and
   it is enough to close the alert. Left open rather than resolved from a script:
   acknowledging an alert is a decision for whoever owns the inbox, not a side effect
   of a migration.
2. `Compass Client B` is `missing` and its grace period ends **2026-09-16**. After
   that, **Remove permanently** appears on the Portals screen and will destroy its
   tenant, its chats and its private library. It holds no chats and no documents, so
   there is nothing to lose — but that is a decision to take deliberately, not to let
   the date make.
3. **6B is done** (§6). `documents.client_id`, `document_folders.client_id` and
   `documents.source_id` were **deliberately kept** — §6B says so outright: they are
   the second half of the tenancy guard, they cost nothing, and unwinding them is a
   separate decision with its own risk. Every row is NULL and that is fine.
4. Spec §Open items 1–4 remain unanswered: whether document names should come from a
   FuseBase database (set aside in Phase 5), the 7-day grace period, the private-library
   naming (`<Portal> — files`), and whether staff should be able to **move** a document
   between libraries rather than re-upload it. Moving is one column and avoids paying to
   embed the same PDF twice; it is the one of the four that is a feature rather than a
   confirmation.

---
