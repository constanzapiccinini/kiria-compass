# PHASE 5 — The portal is the tenant, libraries, and one place to configure

**Change specification — delta against the shipped Phase 4 state** (`apps/compass-ai/PHASE-4-COMPLETE.md`, schema v11).

Author: Coni · Date: 2026-09-08 (**revision 2** — supersedes revision 1 in full) · Apps: `apps/compass-ai` (client), `apps/compass-admin` (staff) · Store alias `compasses`

> **What changed in revision 2.** Revision 1 asked staff to assign each portal to a client in the admin app. That step is removed: **one client = one portal**, and that relationship is already managed in FuseBase workspaces. The admin app now speaks only in portals, and a library says which **portals** its files go to. `source_grants` from revision 1 is dropped — bindings already do that job.

---

## 0. Read first

Phase 4 is shipped and working. This document changes three things and cleans up four. Everything not named here stays exactly as it is.

Before writing code: `CLAUDE.md`, `AGENTS.md`, and skills `fusebase-gate` (references `portals.md`, `portal-embed-context.md`, `isolated-sql.md`), `fusebase-cli`, `app-backend`, `app-e2e-tests`. Verify the MCP connection first. Migration discipline unchanged: files in `postgres/migrations/` → checksum → `--status` → apply to dev → verify → prod. `isolatedStores` stays undeclared in `fusebase.json` (see the store hazard in PHASE-4-COMPLETE); `scripts/sql-migrate.mjs` resolves the store by alias through Gate.

**Build 5A first and stop.** It is a live bug. 5B–5D follow on confirmation.

| # | Problem today | Phase 5 |
|---|---|---|
| 5A | **Nothing anywhere inserts a row into `portals`.** A portal created in FuseBase is invisible to the admin app and refuses its first visitor with `PORTAL_NOT_BOUND`. Rows were inserted by hand. | A portal registers itself and provisions its own tenant. **No assignment step exists** — staff never connect a portal to anything. |
| 5B | Files reach a client only through a source pointing at a table that already exists; admin upload attaches to that client's private `app_upload` source, shareable with nobody. | **Libraries.** Upload PDFs into a named library once, then tick which **portals** receive it. One copy, one embedding cost, many portals. |
| 5C | The client app also contains upload, indexing, settings and source management, gated by capability. Two code paths for the same job; one 500'd in production for an hour unnoticed. | The client app becomes **view + chat only**, for everyone including staff. |
| 5D | Folder logic duplicated verbatim in both apps; a `dashboard_view` reader no UI can reach; 7 of 12 alert codes never exercised. | Cleanup, each item resolved rather than carried. |

---

## 1. The tenancy decision, and why the schema barely moves

**In the interface there is one entity: the portal.** A portal is a client. There is no client picker, no client list, no "assign this portal to…". The admin app's scope selector is a **portal** selector, and every screen reads "this portal".

**In the database, `clients` stays exactly as it is** — one row per portal, created automatically, never edited by hand, never shown. It is the tenancy key that `documents.client_id`, `document_chunks.client_id`, `chats.client_id`, the `app.req_client_id` RLS setting and twenty-odd proven policies are built on.

That split is deliberate. Renaming the tenancy column across every table, view, policy and both apps would be a week of mechanical risk against a row-level security layer that was measured in both directions and is currently at 0 warnings — to change a word nobody outside the code will ever read. **Do not rename `clients` or `app.req_client_id`.** Change what the screens say, and make the row appear by itself.

Two consequences to accept knowingly:

- **A client with two portals is two tenants.** Their documents, chats and usage do not merge, and a library must be ticked for both. That is correct for KIRIA today — one portal per client — and the model still permits pointing two portals at one tenant later, because `portals.client_id` remains a real column.
- **Client groups leave the interface.** A library ticks portals directly, which is what a group was for. The `client_groups` tables stay in the schema, unused and unexposed; nothing reads them after this phase. Do not delete them in 5A — deciding that is 5D.

---

## 5A — Portals register themselves (build now)

### A.1 Why it is broken

`portals` has no INSERT anywhere in either backend: `grep -rn "INSERT INTO .*portals\|insertRow('portals'" apps/*/backend/src` returns nothing. `portalRoutes` exposes list, preview, rebind-client and pause — no create. `findBoundClient()` in `apps/compass-ai/backend/src/lib/portal.ts` looks the portal up by `(org_id, portal_id)` and raises `PORTAL_NOT_BOUND` when it misses. So a new portal is a dead end until someone writes SQL.

### A.2 Provisioning, in one function

`ensurePortalTenant(portalId, workspaceId, label)` — idempotent, `SECURITY`-sensitive, called from exactly two places (A.3 and A.4):

1. `SELECT` the `portals` row for `(org_id, portal_id)`. Found → return it.
2. Not found → in one transaction: insert a `clients` row named after the portal, insert its `client_settings` row, insert the `portals` row pointing at it, insert its own `app_upload` source and bind it to the portal.
3. Return the row. Two concurrent first visits must produce one tenant — rely on the `portals_portal_id_key` unique constraint and re-read on conflict, not on a check-then-insert.

Step 2's last part matters: without an `app_upload` source bound to it, a brand-new portal cannot receive a direct upload, which is the same trap the Phase 4 backfill script had to repair by hand.

The portal's **name comes from the platform**, never from a form: `listPortals` when discovery is available, otherwise the label carried on the sighting, otherwise the portal id. Staff can rename the label afterwards; the rename is cosmetic and touches nothing else.

### A.3 Discovery

Gate `listPortals` returns every portal in the org (`portals.read`, org-scoped).

```
GET  /api/portals            → bound and unbound, merged from Gate + the table
POST /api/portals/:portalId/provision   → ensurePortalTenant, 201
```

> **Verify the join key before building on it:** confirm the id `listPortals` returns is the same identifier as the `portalId` claim in the portal context token. Check against a portal already working in production — if they differ, every portal reads as unregistered. The platform uses several id shapes and the embed doc calls its value the "portal global id". Do not assume.

`portals.read` must be added to the admin app's Gate permissions; run the analyzer, then `fusebase app show`. If it cannot be granted to an app token, discovery degrades to A.4 and the screen says so rather than rendering an empty list.

Provisioning every discovered portal automatically is tempting and wrong: an org may hold portals that have nothing to do with this app, and each one would acquire a tenant, a settings row and a place in every list. **Discovery lists; a person provisions.** One click, no data to type.

### A.4 Self-registration — the path that always works

When `resolvePortalContext` verifies a token and finds no `portals` row, call `ensurePortalTenant` **and continue serving the request**. A portal that a real person has opened, through a verified platform token, is a portal that exists; there is nothing for a human to decide. The visitor sees an empty document list rather than a refusal, and `PORTAL_NO_SOURCE` tells staff to grant it a library.

This replaces `PORTAL_NOT_BOUND` as the normal path. Keep the code — it still fires when provisioning itself fails — but it stops being the thing that greets every new portal.

Order matters: the token is verified **first**, always. Provisioning happens only after Gate has confirmed the portal belongs to this org and this app. An unverified token provisions nothing.

### A.5 Screen 1 — Portals

The merged list, one row per portal: name, portal id, registered / discovered-not-registered, documents visible, libraries received, last seen, status. Actions: rename label, pause/resume, preview what it sees, provision (for discovered ones).

**Delete** `PUT /portals/:portalRowId/client`, `POST /portals/clients`, `PUT /portals/clients/:clientId/status` and the "Clients & groups" screen. The client picker in the shell becomes the portal picker, reading `GET /api/portals`. `GET /session/clients` becomes `GET /session/portals` and returns portal rows.

**Last seen** is the most useful column on the screen — a portal registered but never opened is the commonest "why doesn't it work". Confirm `last_seen_at` is actually written on every successful resolve; if it is not, that is part of this phase.

### A.6 Exit criteria

Create a portal in FuseBase, embed the app, open it. It appears in the admin list by itself, already usable, with zero staff action and zero SQL. Deleting the portal in FuseBase leaves its row visible and marked missing at the next discovery, never orphaning documents.

---

## 5B — Libraries

### B.1 The model

A **library** is a named set of documents belonging to no portal. Staff upload PDFs into it; the pipeline parses, chunks and embeds them **once**. Then they tick the portals that receive it. A portal shows the union of its own documents and every library ticked for it.

That is the offer shape: build it once, hand it to whoever should have it. The cost argument is real too — a library on five portals is embedded once, not five times.

**Bindings are the only access mechanism.** `portal_source_bindings` already means "this portal reads this source"; a library grant is that row and nothing new. Revision 1's `source_grants` table is dropped — two mechanisms answering one question is how a client ends up seeing a document nobody can explain.

### B.2 Migration `0013_libraries.sql`

```sql
ALTER TABLE public.document_sources DROP CONSTRAINT document_sources_kind_check;
ALTER TABLE public.document_sources ADD CONSTRAINT document_sources_kind_check
  CHECK (kind IN ('compasses_table','app_upload','library'));

ALTER TABLE public.document_sources DROP CONSTRAINT document_sources_owner_check;
ALTER TABLE public.document_sources ADD CONSTRAINT document_sources_owner_check CHECK (
  (owner_kind = 'client'  AND client_id IS NOT NULL AND group_id IS NULL) OR
  (owner_kind = 'group'   AND group_id  IS NOT NULL AND client_id IS NULL) OR
  (owner_kind = 'library' AND client_id IS NULL     AND group_id IS NULL)
);
ALTER TABLE public.document_sources DROP CONSTRAINT IF EXISTS document_sources_owner_kind_check;
ALTER TABLE public.document_sources ADD CONSTRAINT document_sources_owner_kind_check
  CHECK (owner_kind IN ('client','group','library'));

ALTER TABLE public.document_sources
  ADD COLUMN description TEXT,
  ADD COLUMN archived_at TIMESTAMPTZ;   -- the column ensureAppUploadSource once assumed existed

-- a document belongs to a portal's tenant OR to a library, never both, never neither
ALTER TABLE public.documents
  ADD COLUMN library_id UUID REFERENCES public.document_sources (id) ON DELETE RESTRICT;
ALTER TABLE public.documents ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.documents ADD CONSTRAINT documents_owner_check
  CHECK ((client_id IS NULL) <> (library_id IS NULL));
CREATE INDEX documents_library_idx ON public.documents (library_id) WHERE library_id IS NOT NULL;
```

Apply the same `library_id` + nullable `client_id` + XOR check to every document-derived table that carries `client_id` today — **enumerate them from `0009_rls_client_isolation.sql`, not from this list** (`document_chunks`, `document_pages`, `document_paragraphs` at least; check `chat_documents` and `usage_events` and decide deliberately for each). A table you miss will read as "no rows" for a library document, which looks like an ingest failure and is not.

`ON DELETE RESTRICT` on `library_id` is deliberate: deleting a library must be refused while documents exist, not cascade them away.

### B.3 RLS

Every document-derived policy today is `client_id::text = current_setting('app.req_client_id', true)`. A library row has no `client_id`, so a portal scope currently sees nothing. Add one helper and use it in the **USING** clause of each affected policy (`0014_rls_library_reads.sql`):

```sql
CREATE OR REPLACE FUNCTION public.scope_may_read_source(p_source UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT p_source IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.portal_source_bindings b
      JOIN public.portals p ON p.id = b.portal_row_id
     WHERE b.source_id = p_source
       AND p.status = 'active'
       AND p.client_id::text = current_setting('app.req_client_id', true)
  );
$$;
```

Each policy's USING becomes `… OR client_id::text = <scope> OR public.scope_may_read_source(library_id)`.

**WITH CHECK does not get the library clause.** A portal scope must never write a library row; library writes run under `app.rls_admin`.

Then prove it the way `0009`/`0011` were proven, both directions, with the counts written into the phase doc: portal A ticked sees the library's chunks; portal B not ticked returns 0; untick A and A returns 0 on the next request.

### B.4 Visibility view

`portal_visible_documents` needs one extra join path — documents owned by a library the portal is bound to — and nothing else, because bindings already carry the grant:

```sql
CREATE OR REPLACE VIEW public.portal_visible_documents AS
SELECT p.portal_id, d.id AS document_id, d.client_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d
    ON d.source_id = b.source_id OR d.library_id = b.source_id
 WHERE p.status = 'active'
   AND d.deleted_at IS NULL
   AND d.status = 'indexed'
   AND d.sync_status <> 'orphaned';
```

An `OR` in a join predicate is a planner hazard. Check the plan against a portal with a large library before shipping; if it degrades, split it into a `UNION ALL` of two clean joins rather than leaving it. `portal_documents_admin` gets the same treatment and keeps returning the rows staff need to fix things. Retrieval in `lib/rag.ts` keeps joining the view and nothing else.

### B.5 Routes

```
GET    /api/libraries                          list: documents, pages, portals receiving it
POST   /api/libraries                          { name, description }
PATCH  /api/libraries/:id                      rename, describe, archive
POST   /api/libraries/:id/documents            multipart, identical contract to POST /api/documents
DELETE /api/libraries/:id/documents/:docId     soft-delete + enqueue purge
PUT    /api/libraries/:id/portals/:portalRowId  tick   → writes portal_source_bindings
DELETE /api/libraries/:id/portals/:portalRowId  untick → deletes it
```

Reuse the Phase 4 upload path exactly — `%PDF` header not extension, dedupe on content hash, 207 with per-file reasons never a 4xx for the request, soft-delete then enqueue the purge. The only difference is which column the row is stamped with. **Parameterise the existing handler on its owner; do not fork it.** The last forked helper in this codebase broke production on the path nobody exercised.

Archiving hides a library from pickers and stops its sync; it revokes nothing and keeps everything readable. **Deleting** is refused while any portal is ticked (409, listing them) — a client's document list emptying silently is the worst failure this app can produce.

### B.6 Admin UI

**New screen: Libraries.**

- List: name, documents, total pages, **"goes to" — the portals receiving it**, status.
- Detail: upload panel (drag-and-drop, multi-file, per-file result), document table with status and delete, and a **portal checklist** headed *"Which portals receive these files?"* — each tick writes immediately, with undo, not a save button.
- Every tick and untick writes an audit row naming who gave what to which portal. This is the permission surface of the product; it must be reconstructable a year later.

**Portals screen** gains, per portal, the list of libraries it receives — the same relationship from the other side, so "why does this portal show 40 documents" has one place to answer it. **Preview** must label each document with how it arrived: this portal's own upload, its table source, or library *X*.

---

## 5C — The client app becomes view + chat

For everyone, staff included. A staff member who needs to change something goes to Compass Admin; a small ribbon in the client app says so, with a link.

**Delete from `apps/compass-ai`:**

- `src/components/DocumentUpload.tsx`, `IndexingPanel.tsx`, `SettingsPanel.tsx`, and the buttons that open them in `App.tsx`.
- `backend/src/routes/sources.ts` entirely, `backend/src/routes/indexing.ts` entirely.
- From `routes/documents.ts`: `POST /`, `POST /:documentId/reindex`, `DELETE /:documentId`.
- From `routes/folders.ts`: `POST /`, `PATCH /:folderId`, `DELETE /:folderId`, `PUT /documents/:documentId`. `GET /` stays.
- `EnvPanel.tsx` — keep only if it is the dev-only diagnostic it appears to be, and only behind the dev flag.

**Keep:** the entire ingest pipeline (`lib/ingest.ts`, `lib/sources.ts`, `lib/chunk.ts`, `lib/openai*.ts`, `lib/textract.ts`, the drain webhook, the worker). This phase removes an HTTP surface, not the engine. `lib/folders.ts` keeps only `ensureFolderPath`, which sync needs; the mutation helpers go, and the admin copy becomes the only one — closing the duplication flagged in PHASE-4-COMPLETE.

**Before deleting any route, list its callers** across both SPAs, `tests/`, `scripts/`, the drain webhook and any cron. Anything the worker needs becomes an internal function call, not an endpoint nobody renders.

`capabilitiesFor()` collapses to `{ viewDocuments, chat, exportAnswers }`, true for both actors. Keep `actor` in the session payload: audit rows need it and the staff ribbon keys off it.

**Exit criterion:** `grep -rn "capabilities\." apps/compass-ai/src` returns only those three, and the client bundle contains no admin API path.

---

## 5D — Cleanup, each item closed

1. **`dashboard_view` sources.** The reader exists in `apps/compass-ai/backend/src/lib/sources.ts`; the admin's `source-config.ts` refuses the mode, so no UI can create one. Query production for `document_sources WHERE config->>'mode' = 'dashboard_view'`. **None → delete the reader and the `dashboardView` permission from `fusebase.json`.** Any → finish the admin side. Unreachable code that looks supported has already bitten this project twice.
2. **Client groups.** Nothing reads them after 5B. Decide explicitly: drop the tables in a migration, or keep them documented as unused. Do not leave them half-wired.
3. **Folder duplication** — resolved by 5C. Add a test that fails if the surviving `folders.ts` loses any cycle or depth guard.
4. **Untested alert codes.** Add a dev-only `POST /api/alerts/test { code }` behind `requireAdmin` **and** a non-production environment check, raising through the real path. Assert in a test that it is unreachable in prod — a comment is not an assertion.
5. **`archived_at`** exists because a helper assumed it and shipped a 500. Wire it: archived sources and libraries drop out of pickers and sync, and stay readable for what they already ingested.

---

## Test cases

**Portals**
- Open the app in a brand-new portal → the portal serves an empty list, a tenant exists, an `app_upload` source is bound, and the row appears in the admin. No staff action, no SQL.
- Two simultaneous first visits → one tenant, not two.
- An unverified or foreign-app token → nothing provisioned.
- Discovery unavailable → the screen says so and still lists self-registered portals.
- The removed routes (`PUT /portals/:id/client` and the client CRUD) return 404 and no SPA calls them.

**Libraries**
- Upload 3 PDFs into a library, tick portal A → A shows 3, portal B shows 0.
- Tick B as well → B shows 3 **with no re-embedding** (assert on `usage_events`).
- Untick A → A shows 0 on the next request; documents and chunks still exist.
- RLS proof, both directions, counts recorded.
- Delete a ticked library → 409 naming the portals.
- One chat answer citing both a library document and the portal's own document resolves both correctly.

**Client app**
- Every deleted route 404s; staff see the read-only ribbon and no configuration control in the DOM.
- The Phase 2/4 suite passes unchanged: chat, citations, folders, export.

---

## Open items

1. **Do libraries need their own folders,** or do library documents land in the portal's "Unfiled"? The spec assumes Unfiled — decide before B.6 is built.
2. **A grant is all-or-nothing.** Eight of ten documents for one portal means a second library, not a filter. Confirm that is acceptable.
3. **Wording in the interface** — "Library", or "Offer"? Only labels change; the column stays `owner_kind = 'library'`.
4. Whether `portals.read` can be granted to the admin app's token, which decides whether discovery or self-registration is the primary path.
