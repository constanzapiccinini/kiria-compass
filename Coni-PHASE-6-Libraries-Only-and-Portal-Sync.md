# PHASE 6 — Libraries are the only way in, and FuseBase is the source of truth

**Change specification — delta against the shipped Phase 5 state** (`apps/compass-ai/PHASE-5-COMPLETE.md`, schema v14).

Author: Coni · Date: 2026-09-08 · Apps: `apps/compass-ai` (client), `apps/compass-admin` (staff) · Store alias `compasses`

---

## 0. Read first

Before any code: `CLAUDE.md`, `AGENTS.md`, skills `fusebase-gate` (`portals.md`, `portal-embed-context.md`, `isolated-sql.md`), `fusebase-cli`, `app-backend`, `app-e2e-tests`. Verify the MCP connection. Migration discipline unchanged. `isolatedStores` stays undeclared in `fusebase.json`.

**Prerequisite, not optional:** land `Coni-FIX-library-documents-invisible-to-staff.md` first. After this phase every document is library-owned, so the staff branch of `GET /api/documents` (`WHERE client_id = $1`) would return **nothing for every portal**, not just for libraries.

**Order:** 6A (code + data migration) → confirm → 6B (schema pruning). Do not prune columns in the same release that stops writing them.

| # | Change |
|---|---|
| 6A.1 | **Sources and Documents screens are deleted.** A file enters the system through a library and no other way. |
| 6A.2 | **Folders live inside a library**, created and organised there. |
| 6A.3 | **A portal's private files are a private library**, auto-created — so "just for this client" still exists, through the same door. |
| 6A.4 | **FuseBase is the source of truth for portals**: names follow the platform, and a portal deleted there stops serving here. |
| 6B | Prune the source-sync schema once 6A has run for a release. |

---

## 1. Why deleting Sources is safe

Production, today:

```
sources by kind:   app_upload  6      library  1
                   compasses_table  0        ← the entire table-source feature is unused
documents:         client-owned 3            library-owned 1
folders:           4  (across 2 clients)
chats:             1
```

Nothing in production has ever used a `compasses_table` source. The sync scheduler, `source-config.ts`, the preview, the `source_sync` job kind and the unreachable `dashboard_view` reader are all machinery for a path nobody takes. This phase removes them rather than carrying them — the third time this codebase has paid for code that looks supported and is not.

### Delete

**Admin app:** `backend/src/routes/sources.ts`, `backend/src/lib/source-config.ts`, `src/screens/SourcesScreen.tsx`, `src/screens/DocumentsScreen.tsx` (its useful parts move into the library detail screen), and every nav entry pointing at them.

**Client app:** `backend/src/lib/sources.ts` sync machinery — row readers, `readDashboardViewRows`, `syncSource`, the `source_sync` scheduler branch. Keep `ensureFolderPath` only if §2 still needs it; if not, it goes too.

**Config:** the `dashboardView` permission block in `fusebase.json` (dashboard `c4be2ed2…`), since nothing reads a dashboard any more. Re-run the analyzer afterwards and confirm `usedOps` shrinks accordingly.

**Before deleting each route, list its callers** across both SPAs, `tests/`, `scripts/` and the drain webhook. `apps/compass-admin/backend/src/routes/indexing.ts` and the ingest worker must keep working — this removes ingestion *sources*, not the pipeline.

Screens after this phase: **Portals · Libraries · Settings · Alerts · Usage · Audit**.

---

## 2. Folders belong to the library

Today `document_folders` is keyed on `client_id`. Since every document will belong to a library, so does every folder.

`0015_library_folders.sql`:

```sql
ALTER TABLE public.document_folders
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE CASCADE;
ALTER TABLE public.document_folders ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.document_folders ADD CONSTRAINT document_folders_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));

-- sibling-name uniqueness, per owner, NULL parent included
DROP INDEX IF EXISTS document_folders_sibling_name_key;  -- confirm the real name first
CREATE UNIQUE INDEX document_folders_library_sibling_key
  ON public.document_folders (library_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE library_id IS NOT NULL;
CREATE UNIQUE INDEX document_folders_client_sibling_key
  ON public.document_folders (client_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE client_id IS NOT NULL;
```

The old constraint was `UNIQUE (client_id, parent_id, name)`, which does **not** catch two root folders with the same name, because `NULL` parents never compare equal. Fixing that here is deliberate; check for existing duplicates before applying, or the index creation fails on live data.

**Reading:** folder RLS follows the same shape as documents — add `OR public.scope_may_read_source(library_id)` to the USING clause of `document_folders_tenancy`, WITH CHECK unchanged. `document_folders` was deliberately left client-scoped in 0014; that decision is now reversed and must be, or a client sees library documents with no tree to put them in.

**Editing:** in the admin, on the library detail screen — the `FolderTreePanel` that exists, retargeted from client to library. Same cycle and depth guards; do not rewrite them.

**Client sidebar:** each library the portal receives is a **top-level node** carrying its own tree; documents with `folder_id IS NULL` sit under an "Unfiled" child of their library. This supersedes Phase 5's "library documents land in the portal's Unfiled". Two libraries may both contain a folder called *Compass* and that must render unambiguously — the library name is the disambiguator, so it is never collapsed away, even when a portal receives exactly one library.

---

## 3. A portal's private files are a private library

Removing `app_upload` must not remove the ability to give one client one document. `ensurePortalTenant` (§5A.2) stops creating an `app_upload` source and creates instead a library named `<Portal> — files`, ticked to that portal only, flagged `is_private = true` (new boolean on `document_sources`).

A private library:

- is created automatically, and appears in the Libraries list marked as belonging to that portal;
- **cannot be ticked to a second portal** — the API refuses it (409), because "private" is the only promise it makes. Staff who want to share those files move them to a shared library, which is an explicit, audited action;
- is otherwise an ordinary library: same upload, same folders, same pipeline.

So the answer to "where do I put a file for just this client" is the same as for everything else, and the model stays one thing rather than two.

---

## 4. FuseBase is the source of truth for portals

### 4.1 Reconcile

A `portal_reconcile` job, every 15 minutes, on the admin Portals screen load, and behind a **Sync now** button:

1. Read **every page** of Gate `listPortals`. Pagination matters: reading only the first page makes everything on page two look deleted.
2. **Abort the whole reconcile** — changing nothing — if the call errors, times out, or returns an empty list. A transient failure must never be read as "the client deleted all their portals". Raise `PORTAL_RECONCILE_FAILED` and leave the previous state exactly as it was.
3. For each portal present in both: update `label` from the platform name. **The manual rename action is removed** — the platform name wins, always, so the two can never disagree.
4. Present in Gate, absent here: list it as discovered (§5A.3). Do not provision automatically.
5. Present here, absent from Gate: set `status = 'missing'` and stamp `missing_since` (new column). Raise `PORTAL_MISSING` with the portal label and what will happen next.

`0016_portal_reconcile.sql` adds `missing_since TIMESTAMPTZ`, extends the `portals` status check with `'missing'`, and adds `document_sources.is_private BOOLEAN NOT NULL DEFAULT FALSE`.

### 4.2 What "deleted in FuseBase means deleted here" means exactly

A missing portal stops serving immediately: `portal_visible_documents` already filters `p.status = 'active'`, so a visitor gets nothing, and the app refuses the resolve with a clear message. That is the deletion the client experiences, and it happens within one reconcile cycle.

What does **not** happen automatically is destroying rows. Deleting a portal row deletes its chats, its message history, its usage record and its audit trail — and the trigger for it would be the absence of a row in an API response. Absence is exactly what a partial page, a permission change, a renamed org or a five-second outage also look like.

So: **removal is staff-confirmed.** A portal that has been `missing` for more than 7 days (configurable in `app_settings`) offers a **Remove permanently** action in the admin, which states what will be deleted, requires typing the portal name, writes an audit row, and then deletes the portal, its tenant, its chats and its private library. Shared libraries are untouched — they belong to other portals too.

If a missing portal reappears in a later reconcile, clear `missing_since`, return it to `active`, and resolve the alert. That path must be tested; it is the one that proves the caution above was worth it.

### 4.3 Names of everything else

- **Portal names** follow FuseBase (4.1.3).
- **Library and folder names** are the app's own — nothing in FuseBase names them, and staff rename them in the admin.
- **Document names** come from the uploaded file and are editable in the library; the rename is one row, so every portal receiving that library sees it at once.

If you want document names to follow rows in a FuseBase database instead, that is the dashboard-source model set aside in Phase 5 — see Open items.

---

## 5. Migration

Small and exact. Production holds **3 client-owned documents across 2 clients, and 4 folders**.

`scripts/migrate-uploads-to-libraries.mjs`, idempotent, `--dry-run` first, dev before prod:

1. For each client with at least one document or folder, create (or reuse) a private library `<Client> — files`, ticked to that client's portals.
2. Move the documents: set `library_id`, clear `client_id` — **and do the same for every derived table**. The seven were enumerated in `0013`: `documents`, `document_chunks`, `document_pages`, `document_paragraphs`, `ingest_jobs`, `embedding_batches`, `usage_events`. Re-enumerate them from the migration file rather than trusting this list; a table left client-owned makes its rows unreadable to the very portal that owns them.
3. Move the folders the same way.
4. Verify, before and after: per client, count of documents, chunks, folders; and `portal_visible_documents` count per portal. **The per-portal visible count must not change.** Print both and fail loudly if they differ.
5. `Client Portal Template — uploads` holds 2 documents and has **zero ticks** — nothing sees them today. Migrate them, then decide deliberately whether that library gets ticked anywhere; do not silently make previously invisible files visible.

Retire the `app_upload` sources only once their documents have moved and the counts match.

---

## 6B — Schema pruning (after a release)

Once 6A has run and nothing writes them: drop `document_sources.sync_enabled`, `sync_interval_minutes`, `status`, `last_sync_at`, `last_success_at`, `last_error`, `sync_cursor`; drop `documents.external_id`, `external_updated_at`, `folder_pinned`, `sync_status` (simplify both visibility views accordingly); collapse `document_sources.kind` to `'library'` and `owner_kind` to `'library'`; remove `'source_sync'` from the `ingest_jobs` kind check.

Take a checkpoint first. Keep `description` and `archived_at`. Leave the `client_id` columns and their policies in place even though every row will be `NULL` — they are the second half of the tenancy guard, they cost nothing, and unwinding them is a separate decision with its own risk.

---

## 7. Tests

**Libraries as the only door**
- Every deleted route 404s for a signed-in caller; no SPA calls them.
- Upload into a library → indexed → visible in the ticked portal, **as staff and as a client** (the gap the last bug lived in).
- A private library refuses a second tick with 409.

**Folders**
- Create a nested tree inside a library; the portal renders it under that library's node.
- Two libraries with an identically named folder both render, distinguishably.
- Cycle, depth and duplicate-sibling refusals still hold, root folders included.

**Reconcile**
- Renamed in FuseBase → renamed here on the next reconcile.
- Absent from FuseBase → `missing`, portal serves nothing, alert raised, **nothing deleted**.
- `listPortals` errors or returns empty → reconcile changes nothing and raises `PORTAL_RECONCILE_FAILED`.
- A missing portal reappears → restored, alert resolved.
- Remove permanently → portal, tenant, chats and private library gone; shared libraries intact and still visible to their other portals.

**Migration**
- Dry run on a copy: per-portal visible counts identical before and after; chunk counts unchanged; the one existing chat still resolves its citations.

---

## Open items

1. **Document names from FuseBase.** Only relevant if files should live in a FuseBase database rather than being uploaded into a library. That is the model set aside in Phase 5 — confirm it stays set aside.
2. **Grace period** before a missing portal can be removed: 7 days assumed.
3. **Private library naming** — `<Portal> — files`, or something you would rather see in the list.
4. Whether staff should be able to **move a document between libraries**, or only re-upload. Moving is cheap (one column) and avoids paying to embed the same PDF twice.
