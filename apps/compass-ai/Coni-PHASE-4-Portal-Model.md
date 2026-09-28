# PHASE 4 — Portal Model (Compass AI)

**Change specification — delta against the original "Final Technical Specification — Humata-like Document Analysis Agent".**

Author: Coni · Date: 2026-09-05 · App: `apps/compass-ai` (org `u27b70`, product `sfqksmtybcsejlru`, store alias `compasses`)

---

## 0. How to read this document

This is **not** a new spec. Phases 1–3 are built (`PHASE-1.md`, `PHASE-2.md`, `PHASE-3.md`). Everything in the original specification stays in force **except** what this document changes. Where the two disagree, **this document wins**.

**Before writing any code:**

1. Read `CLAUDE.md`, then `AGENTS.md` (whole file).
2. Read skills `fusebase-gate` (references `portal-embed-context.md`, `membership.md`, `portals.md`, `emails.md`), `fusebase-cli`, `app-backend`, `app-dev-practices`, `app-e2e-tests`.
3. Verify the MCP connection (`tools_list()` non-empty) before any Gate or store operation. If it is unavailable, **stop** — do not write scripts or workarounds.
4. Schema discipline is unchanged and absolute: migration files in `postgres/migrations/` → checksum → `--status` → apply. No inline DDL except marked temporary smoke tests.

**Build Phase 4A only, then stop and wait for confirmation.** (§14.)

---

## 1. The change in one page

| Area | Today (Phases 1–3) | After Phase 4 |
|---|---|---|
| Tenancy | `workspaces` the user creates for themselves; a personal workspace is auto-created on first use | One **client** per KIRIA client, created by employees only. Auto-creation is removed. |
| Where the app runs | Standalone app URL | **Embedded in a client portal**, one portal per client. The portal decides what the app shows. |
| Roles | 4 stored roles: owner / admin / member / viewer | **2 derived roles: employee / client.** Nothing role-shaped is stored or editable. |
| Who configures | Workspace owner/admin, inside the app | **Employees only, in a separate admin app.** Clients cannot change one setting. |
| Where documents come from | Uploaded through the app into a workspace | **A source configured per portal** — a table/dashboard in the `compasses` database — synced by the backend. |
| Document organisation | Flat list | **Folder tree per client**, employee-managed, shown in a collapsible sidebar. |
| Failure handling | Job retries, `last_error` on rows | **`system_alerts` row with cause + remediation, plus notification to employees** on every failure a client could notice. |
| Sharing between clients | None | **Client groups**: several portals may read one shared source. |

---

## 2. Vocabulary (use these exact names in code, tables and UI)

| Term | Meaning |
|---|---|
| **Portal** | A FuseBase portal, one per client engagement. The app is embedded in it as a brick. Identified by the platform `portalId`. |
| **Client** | The KIRIA client (Sun Pharma, Gilead …). Row in `clients`. Owns documents, folders, chats, usage. |
| **Client group** | A named set of clients that share a document source. Row in `client_groups`. |
| **Source** | A configured origin of documents for one client or one group. Row in `document_sources`. |
| **Employee** | KIRIA staff. Org role `member` / `manager` / `owner`, or `isPortalManager === true`. Full access everywhere. |
| **Client user** | The client's people. Org role `client`. Read and chat only, in their own portal, forever. |

A portal maps to exactly one client. A client may have more than one portal (e.g. two brand teams) — the mapping table allows it, the UI does not need to expose it in 4A.

**Do not** use "workspace", "owner", "admin", "member" or "viewer" in new code, UI copy or table names. The FuseBase platform `workspaceId` still exists underneath a portal and is used for Gate membership calls only (§4).

---

## 3. Permission model — replaces the original §"Organizations and Workspaces" and §"Security & Access Control"

### 3.1 Two roles, derived, never stored

Delete the `Role = 'owner' | 'admin' | 'member' | 'viewer'` type, `ROLE_RANK`, and `requireWorkspaceRole` from `apps/compass-ai/backend/src/lib/auth.ts`. Replace with:

```ts
export type Actor = 'employee' | 'client'
```

Derivation, in `lib/portal.ts` (new), on every request — never cached beyond 60 s, never read from a request body:

1. Verify the portal context token (§4) → trusted `portalId`, `workspaceId`, and the caller's `userId` + `orgRole`.
2. If the verify response carries **no `userId`** → anonymous visitor → **401**. The app is never public.
3. `orgRole` in `{ member, manager, owner }`, or `isPortalManager === true` → **employee**.
4. `orgRole === 'client'` → **client**, scoped to the client bound to this portal.
5. Anything else (`guest`, unknown) → **403**.

Where `orgRole` is not present on the verify response, resolve it with Gate `listPortalMembers(workspaceId)` and match on `userId`; `orgRole` and `isPortalManager` come back on that call. Do not re-derive `isPortalManager` yourself — use the flag.

### 3.2 Capability matrix

| Capability | Employee | Client |
|---|---|---|
| Open the app in a portal | ✅ any portal | ✅ own portal only |
| Read documents / open the PDF viewer | ✅ | ✅ (own portal's visible set) |
| Ask questions in chat, export answers | ✅ | ✅ |
| See folders | ✅ | ✅ (read-only) |
| Create / rename / move / delete folders | ✅ | ❌ |
| Upload, re-index, delete documents | ✅ | ❌ |
| Configure a portal's source | ✅ | ❌ |
| Change caps, modes, OCR flags, retention | ✅ | ❌ |
| Create clients, groups, portal bindings | ✅ | ❌ |
| See alerts, usage, audit log | ✅ | ❌ |
| See other clients' anything | ✅ | ❌ (hard boundary, §4.3) |

Every client-visible read is filtered by portal. Every write route asserts `employee` **in the handler**, not in the router, and returns `403` with a stable machine code. There is no "read-only client with an exception".

### 3.3 Access principals (CLI)

```bash
# client app — clients and employees, only through a portal embed
fusebase app update jkbjijn0ndnorxzp --access=portalClient,portalManager

# admin app — employees only, never portalClient
fusebase app update <adminAppId> --access=orgRole:member
```

Run `fusebase app show <id>` **before** every `--access` change: the flag replaces the whole principal list, and a `!` line in the output means there are principals the CLI cannot express — in that case change the grants in the UI instead of running `app update --access` at all.

---

## 4. Portal resolution — the security boundary

### 4.1 The flow

1. The brick loads the app at `https://compass-ai.<host>/?fromFrame=true&portalFeatureContextToken=<JWT>`.
2. SPA reads `portalFeatureContextToken` **from `window.location.search` only** and keeps it in memory. Never from a body field, never from `localStorage`.
3. SPA sends it on every backend call as `x-portal-context: <token>` (alongside the existing `fbsfeaturetoken` cookie).
4. Backend `resolvePortalContext(c)`:
   - Gate `verifyPortalFeatureContextToken` (`POST /{orgId}/apps/{appId}/portal-feature-context/verify`) with the caller's app token. **Never** an unsigned local JWT decode.
   - Returns trusted `{ portalId, workspaceId, productId, appId }` plus `{ userId, orgRole }` when the caller's session is bound to this portal.
   - Look up `portals` by `portal_id` → `client_id`. No row → alert `PORTAL_NOT_BOUND` (§10) and return 409 with a client-safe message.
   - Cache the verify result for 60 s keyed by `hash(token) + userId`. Nothing longer: the token is static and long-lived, so it is a portal artifact, not a credential.
5. Result `{ portalId, clientId, actor, userId }` is attached to the request context. Every query in the request uses `clientId` from here.

### 4.2 Absolute rules

- **No route accepts `workspaceId`, `clientId` or `portalId` from the caller.** Delete those parameters from `/documents`, `/chats`, `/indexing`, `/workspaces`. A request that carries one is a 400, not a silent ignore — it is the signature of a tenancy probe and must also raise an audit entry.
- The portal context token is static and shared by every viewer of the portal page. It proves *where*, never *who*. Identity always comes from the user's `fbsfeaturetoken` session.
- The admin app does **not** use the portal token: employees pick a client explicitly, and the backend authorises by `actor === 'employee'`.

### 4.3 Store-level isolation

- Add `isolated_store.rls.delegate` to `backendOnlyGatePermissions` in `fusebase.json` (never to `app.permissions` — it would leak into the browser token) and pass `trustedRuntimeContext.portalId` on isolated-store SQL calls.
- **Independently of RLS**, every query keeps an explicit `WHERE client_id = $1` (or the visibility join of §6.5). `rlsContext` alone filters nothing — it only sets transaction-local settings, and `bypassRls=true` is the common case. Verify with `fusebase isolated-store sql bundle --app apps/compass-ai --rls-status`; if `bypassRls=true`, the app-level filter is the only real boundary, and the spec requires it regardless.

---

## 5. Data model

Two migrations. Follow the discipline in `CLAUDE.md`: write the files, compute checksums, `--status`, then apply.

### 5.1 `0003_portal_tenancy.sql` — tenancy rename and role removal

1. `ALTER TABLE workspaces RENAME TO clients;` and rename `workspace_id` → `client_id` on `workspace_settings` (→ `client_settings`), `documents`, `document_chunks`, `ingest_jobs`, `chats`, `chat_messages`, `usage_events`, `rag_traces`, `audit_logs`, `embedding_batches`. Rename indexes and constraints to match. This is mechanical; do it in one migration so no query is ever half-renamed.
2. `clients`: add `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived'))`, `notes TEXT`. Drop `created_by_user_id`'s implicit "owner" meaning (keep the column as provenance only).
3. **`DROP TABLE workspace_members;`** Roles are derived (§3.1) and membership lives in the portal, not in our schema. Anything that read it reads Gate now.
4. New tables:

```sql
CREATE TABLE public.client_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_groups_name_key UNIQUE (org_id, name)
);

CREATE TABLE public.client_group_members (
  group_id  UUID NOT NULL REFERENCES public.client_groups (id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, client_id)
);

CREATE TABLE public.portals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       TEXT NOT NULL,
  portal_id    TEXT NOT NULL,              -- platform portal global id
  workspace_id TEXT,                       -- platform workspace behind the portal (Gate calls)
  client_id    UUID NOT NULL REFERENCES public.clients (id) ON DELETE RESTRICT,
  label        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','paused')),
  settings_override JSONB NOT NULL DEFAULT '{}'::JSONB,  -- see §5.3
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT portals_portal_id_key UNIQUE (org_id, portal_id)
);
CREATE INDEX portals_client_idx ON public.portals (client_id);
```

`portals.portal_id` unique per org is the whole tenancy join. `ON DELETE RESTRICT` on `client_id` so a client with a live portal cannot be deleted by accident.

### 5.2 `0004_sources_folders_alerts.sql`

```sql
CREATE TABLE public.document_sources (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('compasses_table','app_upload')),
  owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('client','group')),
  client_id      UUID REFERENCES public.clients (id) ON DELETE CASCADE,
  group_id       UUID REFERENCES public.client_groups (id) ON DELETE CASCADE,
  config         JSONB NOT NULL DEFAULT '{}'::JSONB,
  sync_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
  status         TEXT NOT NULL DEFAULT 'idle'
                 CHECK (status IN ('idle','syncing','error','disabled')),
  last_sync_at   TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error     TEXT,
  sync_cursor    JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by_user_id TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_sources_owner_check CHECK (
    (owner_kind = 'client' AND client_id IS NOT NULL AND group_id IS NULL) OR
    (owner_kind = 'group'  AND group_id  IS NOT NULL AND client_id IS NULL)
  )
);

-- which sources feed which portal; a portal may read its client source plus group sources
CREATE TABLE public.portal_source_bindings (
  portal_row_id UUID NOT NULL REFERENCES public.portals (id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES public.document_sources (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (portal_row_id, source_id)
);

CREATE TABLE public.document_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES public.document_folders (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  depth       INTEGER NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 4),
  created_by_user_id TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_folders_sibling_name_key UNIQUE (client_id, parent_id, name)
);
CREATE INDEX document_folders_client_idx ON public.document_folders (client_id, parent_id, position);

CREATE TABLE public.system_alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL,
  code          TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  scope         TEXT NOT NULL CHECK (scope IN ('org','client','portal','source','document','chat')),
  client_id     UUID REFERENCES public.clients (id) ON DELETE CASCADE,
  portal_row_id UUID REFERENCES public.portals (id) ON DELETE CASCADE,
  source_id     UUID REFERENCES public.document_sources (id) ON DELETE CASCADE,
  document_id   UUID REFERENCES public.documents (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  cause         TEXT NOT NULL,        -- what went wrong, in plain English
  remediation   TEXT NOT NULL,        -- exactly what to do to fix it
  client_message TEXT,                -- safe text the client sees, if any
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','acknowledged','resolved')),
  dedupe_key    TEXT NOT NULL,
  occurrences   INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified_at TIMESTAMPTZ,
  acknowledged_by_user_id TEXT,
  resolved_at   TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT system_alerts_dedupe_key UNIQUE (org_id, dedupe_key, status)
);
CREATE INDEX system_alerts_open_idx ON public.system_alerts (status, severity, last_seen_at DESC);

CREATE TABLE public.alert_deliveries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id   UUID NOT NULL REFERENCES public.system_alerts (id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('email','in_app','monday')),
  target     TEXT,
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','sent','failed','skipped')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.app_settings (
  org_id     TEXT PRIMARY KEY,
  defaults   JSONB NOT NULL DEFAULT '{}'::JSONB,   -- same shape as client_settings
  alert_recipients JSONB NOT NULL DEFAULT '[]'::JSONB, -- [{userId,email,channels:[...]}]
  channels   JSONB NOT NULL DEFAULT '{"email":true,"in_app":true,"monday":false}'::JSONB,
  updated_by_user_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`documents` gains:

```sql
ALTER TABLE public.documents
  ADD COLUMN folder_id  UUID REFERENCES public.document_folders (id) ON DELETE SET NULL,
  ADD COLUMN source_id  UUID REFERENCES public.document_sources (id) ON DELETE SET NULL,
  ADD COLUMN external_id TEXT,
  ADD COLUMN external_updated_at TIMESTAMPTZ,
  ADD COLUMN folder_pinned BOOLEAN NOT NULL DEFAULT FALSE,   -- manual move wins over auto-foldering (§7.3)
  ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'managed'
    CHECK (sync_status IN ('managed','synced','orphaned'));
CREATE UNIQUE INDEX documents_source_external_key
  ON public.documents (source_id, external_id)
  WHERE source_id IS NOT NULL AND external_id IS NOT NULL AND deleted_at IS NULL;
```

Add the `touch_updated_at` trigger to every new table that has `updated_at`.

### 5.3 Settings precedence

`client_settings` keeps its Phase-1 columns (caps, modes, OCR flags). Effective value for a portal:

```
portal override (portals.settings_override JSONB, added in 0003)
  → client_settings
    → app_settings.defaults
      → hard-coded defaults in lib/settings.ts
```

Resolve once per request in `lib/settings.ts` and pass the resolved object down. Clients never see this resolution; employees see which layer a value came from in the admin UI.

---

## 6. Sources — "where each portal is fed from"

### 6.1 v1 source kind: `compasses_table`

The employee points a portal at a table or dashboard view inside the `compasses` store. `config` shape:

```jsonc
{
  "mode": "sql_table",          // or "dashboard_view"
  "tableName": "sunpharma_files",     // sql_table
  "dashboardId": null,                 // dashboard_view
  "viewId": null,                      // dashboard_view
  "columns": {
    "externalId": "id",
    "name": "file_name",
    "file": "file_uuid",              // stored file uuid or read url
    "updatedAt": "updated_at",
    "folderPath": "category",         // optional, drives auto-foldering (§7.3)
    "include": "publish_to_portal"    // optional boolean gate
  },
  "filter": "publish_to_portal = true"
}
```

Before writing any dashboard read: read `.claude/skills/fusebase-dashboards/references/data-patterns.md` and run `sdk_describe` on `getDashboardViewData` (`schemaMode: "output"`). Do not assume `response.data.rows`. Dashboard SDK calls take route params under `path`.

`app_upload` stays as an implicit per-client source so employees can still push a one-off PDF into a portal from the admin app. It has no sync and never overwrites synced rows.

> **Assumption to confirm (§16):** documents synced from a `compasses_table` source reference a stored file uuid the app can read. If the rows carry only external URLs, add a fetch-and-store step to the sync job before parsing.

### 6.2 Binding

- One portal → one *primary* source (its client's) + zero or more group sources, ordered by `position`.
- The admin UI shows a portal's bindings and a "Preview what this portal sees" panel that lists the resolved document set before saving.
- Changing a binding never deletes documents; it changes visibility. Documents whose last source binding is removed become `sync_status = 'orphaned'` and are hidden from clients but kept for employees.

### 6.3 Sync job

New `ingest_jobs.kind = 'source_sync'` (extend the kind check constraint the same way `0002` did for batch polling). Scheduled by the existing backend cron at the source's `sync_interval_minutes`; also triggered by a "Sync now" button (employee only).

Algorithm:

1. Claim the source (`status = 'syncing'`); skip if a run is already in flight.
2. List rows from the configured table/view, applying `filter`.
3. For each row, upsert `documents` on `(source_id, external_id)`:
   - new → insert `status='queued'`, enqueue `parse` (which chains OCR → chunk → embed exactly as today);
   - `external_updated_at` newer → re-ingest as a new `version`, `supersedes_document_id` set (the Phase-1 versioning path, unchanged);
   - unchanged → touch nothing (no embedding cost).
4. Rows that disappeared → soft-delete (`deleted_at`), purge chunks, write an audit entry. Never hard-delete on a sync — a source glitch must not destroy an index.
5. Success → `status='idle'`, `last_success_at`, auto-resolve any open `SOURCE_SYNC_FAILED` alert for this source.
6. Failure → `status='error'`, `last_error`, raise the alert (§10) with the code that matches the failure.

Respect caps while syncing: `max_ocr_pages_per_upload` applies per document, and a source run that would exceed the client's `monthly_ocr_page_budget` pauses the run and raises `OCR_BUDGET_REACHED` instead of burning the budget.

### 6.4 Bulk ingest

A first sync of a large source uses the Phase-3 Batch API path (`embedding_batches`) automatically above a threshold (default 200 chunks, in `app_settings.defaults`). Documents mid-batch simply do not participate in retrieval — that behaviour already holds and must not change.

### 6.5 Visibility resolution (retrieval scope)

The single place that answers "what can this portal see":

```sql
CREATE OR REPLACE VIEW public.portal_visible_documents AS
SELECT p.portal_id, d.id AS document_id, d.client_id
  FROM public.portals p
  JOIN public.portal_source_bindings b ON b.portal_row_id = p.id
  JOIN public.documents d ON d.source_id = b.source_id
 WHERE d.deleted_at IS NULL
   AND d.status = 'indexed'
   AND d.sync_status <> 'orphaned'
   AND p.status = 'active';
```

Every client-facing read — document list, PDF fetch, chat document scope, retrieval SQL in `lib/rag.ts` — joins this view on the trusted `portalId`. Employees use a client-scoped variant that also returns non-indexed and orphaned documents. **Retrieval must never filter on `client_id` alone**, or group sources break; and it must never filter on the chat's stored document list alone, or a removed binding stays readable.

---

## 7. Folders

### 7.1 Model
Tree per client, max depth 5 (`depth` 0–4), unique name among siblings, `position` for manual ordering. `documents.folder_id NULL` renders as **Unfiled** — a virtual node, not a row.

### 7.2 Operations (employee only)
Create, rename, move (reparent — reject cycles and depth overflow with 400 and a clear message), reorder, delete. Deleting a folder moves its documents to the parent (or Unfiled) and never deletes documents. Moving a document is a `folder_id` update; it never re-indexes.

### 7.3 Auto-foldering
If `config.columns.folderPath` is set on a source, the sync creates/reuses the folder path from that column value (`"Compass / 2026 / Q1"` → three nested folders). Employees can move a document afterwards; a manual move sets `documents.folder_pinned = true` (add the column in `0004`) so the next sync does not drag it back.

---

## 8. Client-facing UI changes (`apps/compass-ai/src`)

### 8.1 Sidebar
New `components/DocumentSidebar.tsx`, left of the viewer:

- Folder tree + documents, current document highlighted, per-document status dot (indexed / processing / unavailable).
- **Collapsible** — a rail with an expand affordance when collapsed. State persists in `localStorage` per `portalId` (`compass:sidebar:<portalId>`), wrapped in try/catch, defaulting to expanded.
- Resizable 240–420 px, drag handle, width persisted the same way.
- Keyboard: `Ctrl/Cmd+B` toggles. Focus ring on every interactive node, `aria-expanded` on folders, tree semantics (`role="tree"` / `treeitem`).
- Under 900 px it becomes an overlay drawer, closed by default.
- Search box filtering documents and folder names client-side.
- Multi-select checkboxes drive the chat's active document set (the existing multi-doc session behaviour), so "what I see" and "what the chat searches" are one control, not two.

### 8.2 Read-only means absent
For `actor === 'client'`, upload, delete, re-index, settings and folder-edit affordances are **not rendered** — not rendered disabled. `SettingsPanel.tsx`, `IndexingPanel.tsx` and `EnvPanel.tsx` become employee-only and move to the admin app; whatever remains in the client bundle must contain no admin API calls.

### 8.3 Error and empty states for clients
Clients never see stack traces, table names, provider names or job ids. They see the alert's `client_message`, or the default: *"Some documents are still being prepared. Your KIRIA team has been notified."* The detail goes to `system_alerts`.

---

## 9. Admin app — `apps/compass-admin` (new)

A second FuseBase app in the same project, sharing the `compasses` store and the same backend patterns (its own `backend/`, or a mounted `/admin` router on the existing backend — prefer **its own app with its own backend** so no admin route is reachable from the client app's origin).

Screens:

1. **Portals** — every portal, its client, its bindings, last seen, status. "Preview what this portal sees".
2. **Clients & groups** — create clients, group them, archive.
3. **Sources** — create/edit a `compasses_table` source: pick table or dashboard view, map columns, dry-run preview of the first 20 rows, save, Sync now, sync history.
4. **Documents & folders** — per client: folder tree editor, upload, move, re-index, delete, version history.
5. **Settings** — global defaults, per-client overrides, per-portal overrides; caps, Economy/Precision, OCR feature flags, retention. Shows which layer each effective value came from.
6. **Alerts** — inbox of `system_alerts` with cause, remediation, occurrences, acknowledge / resolve. This is a required v1 channel.
7. **Usage** — the Phase-3/4 dashboard, per client and per portal.
8. **Audit log** — filterable by client, actor, action.

Registration: `fusebase app create` (see `fusebase-cli`), `--access=orgRole:member`, backend permissions `isolated_store.read`, `isolated_store.data.write`, `files.write`, plus `isolated_store.rls.delegate` in `backendOnlyGatePermissions`. No isolated-store permission may appear in the browser-facing `app.permissions`.

---

## 10. Failure notification — new requirement

### 10.1 The rule
**Any failure that a client could notice, or that leaves a portal serving stale or incomplete content, writes a `system_alerts` row and notifies employees.** A silent retry is allowed only while attempts remain; on final failure, or on the first failure of anything a client is waiting for, raise the alert.

### 10.2 Raising

```ts
await raiseAlert({
  code: 'SOURCE_SYNC_FAILED',
  severity: 'error',
  scope: 'source',
  sourceId, clientId,
  title: `Sync failed for ${sourceName}`,
  cause: 'The compasses table "sunpharma_files" returned 42 rows but column "file_uuid" was missing on 7 of them.',
  remediation: '1. Open Sources → Sun Pharma → Column mapping. 2. Confirm "file" maps to the column holding the stored file id. 3. Fix the 7 rows listed below in the compasses table. 4. Press Sync now.',
  clientMessage: 'Some documents are still being prepared.',
  metadata: { rowIds: [...] },
})
```

`raiseAlert` lives in `backend/src/lib/alerts.ts`, is idempotent on `dedupe_key = sha256(code + scope ids)`, increments `occurrences` and `last_seen_at` on repeat, and re-notifies at most once every 30 minutes per alert. Every code has hand-written `cause` and `remediation` text — a generic "an error occurred" fails review.

### 10.3 Channels (pluggable, email first)

```ts
export interface AlertChannel {
  readonly name: 'email' | 'in_app' | 'monday'
  isEnabled(settings: AppSettings): boolean
  send(alert: SystemAlert, recipients: AlertRecipient[]): Promise<DeliveryResult>
}
```

- `in_app` — always on, writes nothing extra (the Alerts screen reads `system_alerts`); record a `sent` delivery for the audit trail.
- `email` — **build in v1.** Gate one-off email to org members (`fusebase-gate/references/emails.md`); one recipient per call, recipients from `app_settings.alert_recipients`. Subject `[Compass AI] <severity>: <title>`; body = cause, remediation, links to the portal and the alert.
- `monday` — **stub in v1**, `isEnabled` returns `app_settings.channels.monday`, `send` throws `NotImplemented`. Wire it later to a board item so a failure gets an owner and a due date.

Delivery failures are recorded in `alert_deliveries` and retried with backoff; a channel that is down must never block the pipeline or lose the alert row.

### 10.4 Seed alert codes

| Code | Severity | Raised when | Remediation must say |
|---|---|---|---|
| `PORTAL_NOT_BOUND` | error | A verified portal has no `portals` row | Bind the portal to a client in Admin → Portals |
| `PORTAL_NO_SOURCE` | warning | Bound portal with zero source bindings | Attach a source in Admin → Portals → Bindings |
| `SOURCE_SYNC_FAILED` | error | Sync run throws | The failing table/column and the exact fix |
| `SOURCE_CONFIG_INVALID` | error | Column mapping does not match the table | Which column is missing and where to remap it |
| `DOC_OCR_FAILED` | error | Textract fails after max attempts | Check the PDF, the OCR page cap, AWS credentials |
| `DOC_EMBED_FAILED` | error | Embedding fails after max attempts | Check the OpenAI key and quota; press Re-index |
| `BATCH_EXPIRED` | warning | An embedding batch expires | Re-submit the batch from Admin → Documents |
| `OCR_BUDGET_REACHED` | warning | Client OCR budget exhausted | Raise the cap or wait for the next period |
| `TOKEN_BUDGET_REACHED` | warning | Client token budget exhausted | Raise the cap in Settings |
| `LLM_TIMEOUT_REPEATED` | error | 3 chat timeouts in 10 min for one client | Check provider status; switch to Economy mode |
| `STORE_UNAVAILABLE` | critical | Isolated store unreachable | Check Gate health; the app is degraded until it returns |
| `TENANCY_PROBE` | critical | A request carried a foreign client/portal id | Investigate the audit entry immediately |

---

## 11. API surface

| Route | Change |
|---|---|
| `GET /workspaces` | **Removed.** Replaced by `GET /session` returning `{ actor, client: {id,name}, portalId, capabilities, settings }`. |
| `POST /workspaces` | **Removed.** Clients are created in the admin app. |
| `GET /documents` | No `workspaceId` param; scoped by portal context; returns `folderId`, `sourceId`, `status`. |
| `POST /documents` (upload) | Employee-only; requires an explicit `clientId` from the admin app. |
| `DELETE /documents/:id` | Employee-only. |
| `GET /documents/:id/file` | Scoped through `portal_visible_documents`. |
| `POST /chats`, `POST /chats/:id/messages` | Document scope intersected with `portal_visible_documents`; a document that left the portal's scope is dropped from the chat with a visible note rather than answered from. |
| `GET/POST /indexing/*` | Employee-only, moves to the admin backend. |
| **New** `GET/POST/PATCH/DELETE /folders` | Read: both actors. Write: employee. |
| **New** `/admin/clients`, `/admin/groups`, `/admin/portals`, `/admin/sources`, `/admin/sources/:id/preview`, `/admin/sources/:id/sync`, `/admin/settings`, `/admin/alerts`, `/admin/alerts/:id/ack` | Employee-only, admin backend. |

Every 403 returns `{ error: { code: 'FORBIDDEN_CLIENT_ROLE', message } }` — stable codes, so the e2e suite asserts on codes and not on prose.

---

## 12. Rollout

1. `0003` + `0004` written, checksummed, `--status`, applied to **dev** first. Verify with `--rls-status`.
2. Backfill: one `clients` row per existing workspace (already the rename), one `portals` row per live portal (manual, from the portal customizer), one `app_upload` source per client so existing documents keep a source and stay visible.
3. Backend: `lib/portal.ts`, rewritten `lib/auth.ts`, visibility view wired into `lib/rag.ts` and `routes/*`.
4. Client app: sidebar, read-only enforcement, removal of admin panels.
5. Admin app: scaffold, then screens in the order of §9.
6. Prod apply only after the dev e2e suite is green.

Nothing is deleted from prod data during this migration. `workspace_members` is dropped only after the backfill is verified — take a row dump into `postgres/backup/` first.

---

## 13. Non-functional deltas

- Portal verify adds one Gate round-trip per request; the 60 s cache keeps the P95 target (2.5 s) intact. Measure it — `rag_traces` gains a `resolve_portal` step (extend the step check constraint).
- A sync run is a background job; it must never block a client request.
- Availability: if Gate verify fails, the app degrades to a clear "Cannot confirm this portal right now" screen and raises `STORE_UNAVAILABLE`/`PORTAL_VERIFY_FAILED`. It never falls back to showing another client's data, and never falls back to an unscoped view.

---

## 14. Phasing — build 4A, then stop

**Phase 4A — tenancy and permissions (build now)**
`0003`, `lib/portal.ts`, two-role model, portal-scoped reads, removal of `workspaceId` from every route, `--access` principals updated, client app renders read-only for clients. Exit criteria: a client user in Portal A cannot reach Portal B's documents by any path (e2e proves it), and no route accepts a caller-supplied tenant id.

**Phase 4B — sources and folders**
`0004`, `compasses_table` source, sync job, visibility view, folder tree, sidebar UI. Exit criteria: pointing a portal at a table populates it end to end, with citations resolving correctly.

**Phase 4C — admin app**
`apps/compass-admin` with all §9 screens.

**Phase 4D — alerts and notifications**
`lib/alerts.ts`, in-app + email channels, every seed code wired to its raise point, monday stub.

Confirm before each phase.

---

## 15. Test cases (replace the original access-control block)

Existing specs live in `tests/e2e/specs/compass-ai/`; the fixtures pattern is in `tests/e2e/helpers/`. Add users: one employee, two client users in different portals.

**Tenancy**
- Client user in Portal A requests Portal B's document id → 404, and an audit entry exists.
- A request with `workspaceId`/`clientId` in body or query → 400 + `TENANCY_PROBE` alert.
- Anonymous visitor with a valid portal token but no session → 401.
- A portal token from another product/app → verify fails → 403.

**Roles**
- Client user: no upload, delete, settings, folder-edit or indexing control is present in the DOM (not merely disabled).
- Client user calling an employee route directly → 403 `FORBIDDEN_CLIENT_ROLE`.
- Employee: full access in the admin app and in any portal.

**Sources**
- Bind a portal to a table with 3 rows → 3 documents indexed, visible, citable.
- Add a row → next sync ingests only that one (no re-embedding of the other two — assert on `usage_events`).
- Remove a row → document hidden from the client, still visible to the employee, chunks purged.
- Break the column mapping → sync fails, `SOURCE_SYNC_FAILED` alert with non-empty remediation, one email delivery row, client sees the safe message only.
- Group source bound to two portals → both see the documents; citations name the right document in both.

**Folders**
- Employee creates nested folders, moves documents; the client sees the tree read-only.
- Reparent that would exceed depth 5, or create a cycle → 400.
- Delete a folder → documents move up, none deleted.

**Sidebar**
- Collapse persists across reload, per portal; expands by default when storage is unavailable.
- `Ctrl/Cmd+B` toggles; drawer mode under 900 px.

**Alerts**
- Same failure twice in 5 min → one row, `occurrences = 2`, one notification.
- Resolved automatically when the next sync succeeds.
- Email channel down → `alert_deliveries` failed + retried; the alert row still exists and the pipeline is unaffected.

---

## 16. Open items — confirm before 4B

1. **File payload in the source table.** Do the `compasses` client tables hold a FuseBase stored-file uuid, or a URL/path? If a URL, sync gains a fetch-and-store step.
2. **One portal per client, or several?** The schema allows several; the admin UI in 4C should know which to optimise for.
3. **Employee upload inside a client portal** — allowed as a convenience, or must everything arrive through a source? (Spec currently keeps `app_upload` as an implicit source.)
4. **Alert recipients** — one KIRIA distribution address, or per-client owners?
5. **Retention** — does deleting a row in the source table mean permanent deletion for the client, or archive-and-keep? (Spec currently soft-deletes and keeps.)
