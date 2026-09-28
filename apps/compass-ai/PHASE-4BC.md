# Compass AI — Phase 4B & 4C handoff

Sources, folders, the client sidebar, and the admin app. Implements 4B and 4C of
[Coni-PHASE-4-Portal-Model.md](./Coni-PHASE-4-Portal-Model.md) §14. Builds on
[PHASE-4A.md](./PHASE-4A.md).

## Exit criteria

| Criterion | State |
| --- | --- |
| **4B:** pointing a portal at a table populates it end to end | **Proven on dev** — see [The smoke test](#the-smoke-test) |
| **4B:** citations resolve correctly | Inherited from Phase 2; the retrieval path changed, and the change is covered below |
| **4C:** all §9 screens exist | Built — 8 screens, 35 operations |
| Verified in a browser | **No.** Builds, typechecks, and every query is exercised against real data — but no screen has been opened |

## Schema — migration v4

`postgres/migrations/0004_sources_folders_alerts.sql`, checksum
`6c5cead748509f8719ea7b7340e9648ba158c03cb52e440ea0156e58dbe52145`.
Applied to **dev and prod** (prod at 2026-09-07T16:46Z).

New: `document_sources`, `portal_source_bindings`, `document_folders`,
`system_alerts`, `alert_deliveries`, `app_settings`. `documents` gains `folder_id`,
`source_id`, `external_id`, `external_updated_at`, `folder_pinned`, `sync_status`.
`ingest_jobs.kind += source_sync`. Two views: `portal_visible_documents` and
`portal_documents_admin`.

The alert tables are created here, per §5.2, though nothing raises alerts until 4D.

### The trap in v4, and the required data step

`portal_visible_documents` resolves visibility by joining `documents.source_id`. Every
document that existed before v4 has `source_id = NULL`, so **applying the view and
switching reads to it makes every hand-uploaded document invisible to clients.**
Measured on dev straight after the apply: 1 live indexed document, 0 with a source,
0 visible.

§6.1's answer is that `app_upload` is an implicit per-client source. That is DML, which
Gate rejects inside a migration bundle, so it lives in
`scripts/backfill-app-upload-sources.mjs` — idempotent, and required before the
view-backed reads deploy. The requirement is also stated at the top of the migration
file so it cannot be missed by whoever applies v4 next.

**Ordering matters and is safe:** v4 and the backfill can land *before* the deploy,
because the currently-deployed code does not reference the new objects. Done that way
on prod, so there was no window in which a client saw an empty list.

## Reads are now portal-scoped (§6.5)

| Read | Before | Now |
| --- | --- | --- |
| Document list (client) | `WHERE client_id`, indexed only | join `portal_visible_documents` on `portalId` |
| Document list (employee) | `client_id` + indexed-only flag | `client_id`, **all statuses** |
| `loadOwnedDocument` | `id AND client_id` | client → view join; employee → `client_id` |
| Chat scope + default scope | `client_id` | portal visibility |
| **Retrieval (`lib/rag.ts`)** | `c.client_id = $1` | join the view on `portalId` |

`AskOptions.clientId` became `portalId`. Worth recording *why*: both are `string`, so
passing `chat.clientId` into a parameter that now means "portal id" **typechecked
silently**. Renaming the field is what made the compiler find every call site.

`d.status = 'indexed'` was removed from the retrieval SQL — the view already enforces
not-deleted, indexed and not-orphaned, and a second copy of that rule is how the two
drift apart.

**Employees are deliberately not view-scoped.** §6.5 gives them a client-scoped
variant, and §6.2 says an orphaned document stays visible to staff. A view-based
employee query needs a binding to exist, so removing the last binding would hide the
document from the people who fix it.

## The smoke test

4B's exit criterion, measured on dev rather than argued:

```
source.sync_ok  created:1              → parse enqueued
parse succeeded                        → 96 pages, 148 chunks, 148 embedded, indexed
bind source to portal                  → portal visible 1 → 2
source.sync_ok  created:0 unchanged:1  → idempotent, nothing re-embedded
row disappears → removed:1             → orphaned, soft-deleted, chunks purged, hidden
```

### Three bugs it caught that review had not

1. **`query()` used for writes.** `claimSource`, `moveFolder`'s depth rewrite and
   `deleteFolder` all used `query()`, which is **read-only** — it maps to
   `queryIsolatedStoreSql`, running in a `READ ONLY` transaction. Rewritten with the
   structured row API, which also keeps the backend on `data.write` and off the
   privileged `isolated_store.execute`. A structured update sets literals, so
   `depth = depth + shift` became one update per distinct depth (at most five).

2. **A stored-file uuid is not fetchable.** §6.1 assumed it was. The file service
   issues `readUrl` once at upload and it bears **no relation** to the uuid — checked
   on a real row, where the uuid appears nowhere in
   `.../apps/<user>/<timestamp>-<random>/<filename>` — and Gate exposes no
   uuid-to-URL lookup. So `columns.fileUrl` is now part of the config, and rows with
   no fetchable URL are skipped and counted rather than inserted as permanent
   failures.

3. **The sync was destroying data.** On a vanished row it called `purgeDocument`,
   which **hard-deletes the document row**, so one filter typo or transient empty read
   would permanently destroy an index that cost real money — exactly what §6.3.4
   forbids. Now `clearExtraction` (chunks, pages, paragraphs only), leaving the row
   soft-deleted and orphaned. Re-verified end to end.

All three would have shipped on code review alone.

## Folders (§7)

`lib/folders.ts` handles the two rules that carry the difficulty:

- **Cycles** — reparenting under your own descendant detaches that subtree from the
  root permanently; the rows survive but nothing can list them again.
- **Depth** — the moved folder carries its subtree, so what matters is its *deepest
  descendant* after the move. Checking the node alone writes rows that violate the
  CHECK constraint partway through, leaving the tree half-moved.

Descendant depths are rewritten in the same operation; stale depths would corrupt
every later calculation and only surface when someone hit the limit.

`deleteFolder` moves children up one at a time through `moveFolder` to reuse that
logic rather than duplicate it — several statements for a wide folder, fine at this
scale. **No reorder endpoint yet**: `position` exists and is maintained, but there is
no "put these siblings in this order" route.

## Sync scheduling and the OCR gate

Scheduled syncs ride the existing orphan sweep, inheriting its claiming, retries and
stale-lock recovery rather than growing a second scheduler. A source with a job
already queued is skipped, since the sweep runs far more often than most intervals.

`sync_enabled` governs **scheduling only** — "Sync now" still runs on a paused source.
Conflating the two made a paused source impossible to test, which is how the flaw was
found.

The OCR budget gate pauses a run before reading a row when
`monthly_ocr_page_budget` is already spent. **A trade-off worth naming:** it pauses
text-layer PDFs too, which consume no OCR pages. Whether a row needs OCR is only known
after parsing it, so "would exceed" cannot be evaluated per row up front, and §6.3 asks
for the conservative behaviour. Raising the budget resumes everything.

## Client sidebar (§8.1)

`src/components/DocumentSidebar.tsx` — tree, status dots, collapsible rail, resize
240–420px, `Ctrl/Cmd+B`, overlay drawer under 900px, search, tree semantics.

- **Selection is one control.** The checkboxes that set the chat's scope *are* the
  tree's selection, so "what I see" and "what the chat answers from" cannot disagree.
- **Search keeps the path visible**: a folder survives pruning if its own name
  matches, it holds a match, *or* a descendant survives. Branches auto-expand while
  searching, since a collapsed folder hiding a match makes search look broken.
- **The resize handle works without a pointer** — `role="separator"` with
  `aria-valuenow/min/max` plus arrow keys.

`DocumentPanel` was retired: the sidebar replaces its list, so the upload area moved to
`DocumentUpload.tsx` rather than either component growing a mode flag. Employee
delete/re-index were **kept** in the sidebar, capability-guarded — §8.2 moves them to
the admin app, but that is 4C and dropping them first would have left no way to delete
a document.

## Admin app — 4C

`apps/compass-admin`: own app, own backend, own origin (§9's preference), registered
`--access=orgRole:member` with store access confined to
`backendOnlyGatePermissions`.

`lib/admin-auth.ts` resolves the caller's org role from Gate per request and requires
`membershipStatus === 'ready'` **and** a role in `{member, manager, owner}`. It fails
closed — including when Gate is unreachable, which must never read as "allowed".

**This app is the inverse of the client app.** Admin routes *do* take a `clientId`,
which is a `TENANCY_PROBE` in the client app. That is correct here, because the
authorization question differs: "is this caller staff", not "which portal is this".

### Three decisions that reduce risk

- **No duplicated reconcile logic.** "Sync now" writes into the shared `ingest_jobs`
  table and the *client app's* worker runs it. Duplicating the algorithm that creates,
  updates and orphans documents would be a second chance to destroy an index — and
  three bugs were just found in that code.
- **No folder mutation in the admin.** Cycles and depth overflow are the subtle part;
  this screen files documents into folders that already exist.
- **`requireUser` was removed from the copied `auth.ts`.** It establishes only that a
  caller is authenticated — fine in the client app, dangerous here, since an admin
  route wired to it would be reachable by any signed-in user including a portal
  client. `requireAdmin` is now the only way to identify a caller in that backend.

Contract: `apps/compass-admin/openapi.json`, 32 paths, **35 operations** — verified
one-for-one against the registered routes, so nothing is undocumented and nothing is
declared that does not exist.

### Deviations from §9, stated rather than silent

- **No `isolated_store.rls.delegate`.** §9 lists it, but nothing uses
  `trustedRuntimeContext` and RLS is still unwired. Requesting unused elevated
  privilege is worse than following the letter of the spec.
- **No `files.write`.** The admin backend has no upload path yet.
- **Chakra, not the scaffold's Tailwind.** Two design systems in one product means an
  operator relearning what a colour means when they switch apps. The theme is copied
  with a note to extract a shared package if they diverge.

## A store-binding hazard, now closed

`fusebase app create` and `fusebase deploy` both rewrite `fusebase.json`, and on this
org they have **three times** replaced the `compasses` binding with a second store,
`compasses-prod` — same schema, zero rows.

That mattered most for `scripts/sql-migrate.mjs`, which resolved the store from that
file: the next `apply` would have run migrations against the empty store, reported
success, and left the real database behind, while `--status` compared against the wrong
journal. Silent, and hard to spot later.

Patching the value again would have been useless, so the runner now **verifies the
binding through Gate** before reading or writing anything, and refuses with the correct
id. Exact alias match, not a prefix — `compasses-prod` starts with `compasses`. The
e2e helper resolves by alias for the same reason.

**Recommendation:** delete the `compasses-prod` store. It is empty and unreferenced,
but CLI tooling keeps re-selecting it and it remains a trap for anything that does not
resolve by alias. Destructive, so it needs a human decision.

## Prod state

| | |
| --- | --- |
| Migration head | **v4**, no drift |
| `app_upload` sources | one per client, bound to each client's portal |
| Documents | 1 real (`brand guidelines - kiria.pdf`, Compass Client B), visible through the view |
| Deployed code | **still pre-4B** — the backend using the view has not shipped |

A fixture document seeded for the 4A isolation runbook
(`ISOLATION-TEST-portal-b-only.pdf`) was **deleted** during this preparation: the
backfill would have made it visible to a real client as a phantom document with no
content. `scripts/portal-isolation-check.mjs` recreates the check in one command when
the runbook is next run.

## Not done

1. **Nothing 4B/4C is deployed.** The client backend, the admin app and the SPA all
   need `fusebase deploy`; prod schema and data are ready for it.
2. **No UI verified in a browser** — client sidebar or admin screens.
3. **`dashboard_view` sources** refuse with a clear message rather than syncing
   nothing. Implementing them needs the dashboards data-patterns reference and
   `sdk_describe` first.
4. **Folder reorder** endpoint (§7.2).
5. **Admin upload** (§9.4 lists upload; the screen has none).
6. **§15 e2e for 4B/4C** — no specs cover sources, folders or the admin app.
7. **4D** — alert raising. The inbox reads a table nothing writes yet.
