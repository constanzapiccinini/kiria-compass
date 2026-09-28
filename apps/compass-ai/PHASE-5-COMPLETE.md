# Phase 5 — complete

**The portal is the tenant, libraries, and one place to configure.**
Built against `Coni-PHASE-5-Libraries-and-Portals.md` **revision 2**. Schema v14.

---

## What revision 2 changed, and what it cost

Revision 1 asked staff to assign each portal to a client. That app was built and
deployed. Revision 2 removed the step entirely — **one client = one portal** — which
invalidated a working feature rather than extending it. What was deleted:

| Deleted | Why it became a contradiction |
|---|---|
| `PUT /portals/:id/client` | Rebinding a portal to another client is meaningless when the portal *is* the client. |
| `POST /portals/clients`, `PUT /portals/clients/:id/status` | Staff no longer create or archive clients; provisioning does. |
| `GET /portals/groups` and the group routes | A library ticks portals directly, which is what a group was for. |
| The "Clients & groups" screen | Nothing left to show. |
| `GET /session/clients` → `GET /session/portals` | The shell's picker is a portal picker. |
| **`DELETE /portals/:portalRowId`** — the "Disconnect" button | See below. |

### The Disconnect button

It was reported as broken, and it was: the control existed only in the
"portal no longer exists" panel, so a normally connected portal had no way to undo a
mistake. It was fixed by adding it to the main table — and then **removed entirely**
by revision 2, because under this model deleting the row strands its tenant: the
client, its documents and its chats survive with no portal resolving to them. That is
exactly the invisible-documents failure this phase exists to end.

**Pause is the off switch**, and it is reversible. A test asserts that
`DELETE /api/portals/:id` returns 404.

---

## 5A — Portals register themselves

`ensurePortalTenant(portalId, workspaceId, label, actorUserId)` — idempotent, called
from exactly two places: the admin's Provision button and `resolvePortalContext` on a
first visit. A portal now provisions its own `clients` row, `client_settings`,
`portals` row and `app_upload` source, bound to itself.

**Deviation, stated rather than hidden.** The spec asks for step 2 "in one
transaction". That is not available: writes go through the structured row API, and
`executeIsolatedStoreSql` — the only way to open a transaction — needs
`isolated_store.execute`, which the app token deliberately lacks. Instead every step
is individually idempotent and keyed on a **slug derived from the portal id**, so a
crash between any two steps is repaired by the next call and never duplicates. The
`portals_portal_id_key` unique constraint decides races; the loser re-reads. This is a
weaker guarantee than a transaction — a client with no portal row can briefly exist —
and it is written down in `lib/portal-tenant.ts` rather than assumed away.

### Production state, repaired

Two problems found by measuring rather than by report:

- **Three of the four portals had 0 sources and 0 visible documents.** They were
  created through revision 1's connect flow, which never gave them an `app_upload`
  source. `scripts/backfill-app-upload-sources.mjs` (repointed to resolve the store by
  alias through Gate, since `isolatedStores` is no longer declared) fixed all four.
- **`eq94vsqm69l3ty8op0krcn5i7` is not in `listPortals`** — deleted in FuseBase. Its
  row and its one document are preserved and the screen now says "deleted in FuseBase",
  which is §A.6's requirement.

**Labels.** `listPortals` returns no `name` in this org, only `domain`. So the label
chain is platform name → first label of the domain → sighting label → portal id, and
`scripts/repair-portal-labels.mjs` rewrote the three raw ids to `client-a-portal`,
`client-b-portal` and `kiria-template`.

**Join key verified**, not assumed: the ids `listPortals` returns are the same values
stored in `portals.portal_id`.

---

## 5B — Libraries

A library is a `document_sources` row with `kind = 'library'`. **A tick is a
`portal_source_bindings` row and nothing else** — revision 1's `source_grants` table
was dropped, because two mechanisms answering "who has this" is how a viewer sees a
document nobody can explain.

### Schema

- **v13 `libraries`** — `kind`/`owner_kind` extended, `description` and `archived_at`
  added, and `library_id` + nullable `client_id` + `CHECK ((client_id IS NULL) <>
  (library_id IS NULL))` on **seven** tables: `documents`, `document_chunks`,
  `document_pages`, `document_paragraphs`, `ingest_jobs`, `embedding_batches`,
  `usage_events`. Enumerated from `0009`, not from the spec's list. `ingest_jobs` is
  load-bearing: without it a library document cannot be queued at all.
  `ON DELETE RESTRICT`, so deleting a library is refused rather than cascading.
- **v14 `rls_library_reads`** — `scope_may_read_source(uuid)`, `SECURITY DEFINER` with
  a pinned `search_path`, used in the **USING** clause of all seven policies.
  **WITH CHECK deliberately unchanged**: a portal scope must never write a library row.
  Both visibility views resolve libraries via `UNION ALL` rather than an `OR` in the
  join predicate — two clean index-using joins, disjoint by the XOR constraint.

Tables left client-scoped, each decided rather than skipped: `chats`, `chat_messages`,
`rag_traces`, `chat_documents` (a citation belongs to the asking tenant),
`client_settings`, `client_group_members`, `document_folders`.

### Measured, both directions

`scripts/verify-library-rls.mjs` — **19 of 19 checks pass** on dev:

| Step | Portal A | Portal B |
|---|---|---|
| before any tick | 0 | 0 |
| ticked A only | 1 | 0 |
| ticked B as well | 1 | 1 |
| unticked A | 0 | 1 |

Plus: `scope_may_read_source` returns the matching boolean for each scope in every
state; the chunk count is **unchanged** when a second portal is ticked (one embedding,
not two); documents and chunks survive an untick; and the database **refuses** to
delete a library that still holds documents.

### The pipeline actually indexes a library document

The riskiest part of this phase was teaching the pipeline that a document may have no
tenant. `DocumentRecord.clientId` became `string | null` and a `RowOwner` type
(`lib/owner.ts`) is threaded through every derived write — pages, paragraphs, chunks,
jobs, batches, usage. **TypeScript found all thirteen sites**; none was guessed at.

Verified end to end against production by `libraries.spec.ts`, which polls until the
uploaded library document reaches `indexed` and asserts it has 1 page and at least one
passage. Usage is charged to the library with `client_id = NULL`, so no tenant is
billed for work five portals share:

```
kind=embedding model=text-embedding-3-large client_id=null library_id=5ba7cb3a… tokens=18
```

Settings for a library come from `LIBRARY_INGEST_SETTINGS`, mirroring the column
defaults in `0001`/`0002`, with both monthly budgets `null` — a per-tenant budget
cannot be charged to a shared document. The unit test pins that.

### The bug that shipped: staff could not see a library at all

Found by `scripts/Coni-diagnose-library-visibility.mjs` against production, after the
first real library was created. The database was entirely healthy — library ticked to
`client-a-portal`, document `indexed` with 148 chunks, `portal_visible_documents`
returning it — and the portal still showed nothing.

`GET /api/documents` had two branches. A **client** was resolved through the view; an
**employee** was resolved with `WHERE client_id = $1`, so that staff inside the portal
could also see rows still processing or orphaned. A library document has
`client_id = NULL` by design, so the employee branch hid every one of them. Measured:

```
employee branch (client_id filter):  0 documents
client branch (visibility view):     1 document
```

`loadOwnedDocument` had the same filter, so a library document also **404'd on open**,
and with it the viewer's pages, paragraphs and bytes. Meanwhile the chat's default
scope comes from the same view — so an answer would cite a document the sidebar did
not list and the viewer refused to open. That combination is worse than either half.

§6.5 warns about precisely this and says why a `client_id` filter cannot answer the
question: a *group* source belongs to no single client. A library is the same shape,
and the warning was written in a comment on the code that ignored it.

Both branches now read `portal_visible_documents`, which is also what §5C decided —
this app is view + chat for everyone, so a document list that differs by actor
contradicts the rest of it. The employee's "show me what is broken" need moved rather
than vanished: Compass Admin's Documents screen lists failed and orphaned rows, and its
Indexing screen answers why something is not searchable.

**Guarded against return.** `tests/source-config.test.ts` now fails if any document
query in that file filters on `client_id`, or if the view stops being joined. It is a
static check and a blunt one, chosen because this trap has sprung twice — the Phase 4
`source_id` bug and this one — and neither was catchable at runtime without a
portal-bound session the harness cannot mint. Verified by reintroducing the filter and
watching it fail.

### A bug this phase introduced, and found

`usage_events.library_id` is `ON DELETE RESTRICT` like every other library reference,
so once a library has cost anything it **cannot be deleted** — deleting it would erase
money really spent from the usage screen. The API returned a raw constraint violation
instead of explaining this; it now returns 409 `LIBRARY_HAS_HISTORY` naming archiving
as the answer. Found because e2e fixtures would not clean themselves up.
`scripts/cleanup-e2e-libraries.mjs` removes test fixtures with the operator token —
the one case where destroying that history is right, and one the app must not be able
to do.

---

## 5C — The client app is view + chat

Deleted from `apps/compass-ai`: `DocumentUpload.tsx`, `IndexingPanel.tsx`,
`SettingsPanel.tsx`, `EnvPanel.tsx` (unmounted, therefore unreachable),
`backend/routes/sources.ts`, `backend/routes/indexing.ts`, the document mutations
(`POST /`, `DELETE /:id`, `POST /:id/reindex`), every folder mutation, and
`GET|PATCH /session/settings` and `/session/audit`.

`capabilitiesFor()` is now `{ viewDocuments, chat, exportAnswers }`, true for both
actors. `grep -rn "capabilities\." apps/compass-ai/src` returns **nothing** — the SPA
no longer branches on capability at all. `actor` stays in the payload: it is identity,
not permission, and the staff ribbon keys off it.

`lib/folders.ts` keeps `listFolders` and `ensureFolderPath`, which the sync needs.
`createFolder` survives as a **private** function because `ensureFolderPath` calls it —
caught by lint after the first deletion removed too much.

**The indexing surface was ported, not dropped.** A new admin screen owns the
snapshot, `retry-failed` and `reindex-unsearchable`. What was *not* ported: the batch
poll and cancel actions, because they call OpenAI's Batch API which only the client
backend is wired to — and production says they were never reachable:

```
clients with batch embedding enabled: 0
embedding batches ever created:       0
```

The worker already polls open batches every five minutes. Unreachable code that looks
supported is the trap §5D exists to close.

The staff ribbon derives the admin URL from `window.location.hostname` at runtime and
renders as plain text when it cannot — never a baked host, never a dead link.

**Exit criterion verified in production**: every removed route returns 404, asserted
for a signed-in caller (an unauthenticated probe returns 401 at the platform edge and
proves nothing — the first version of this test made exactly that mistake).

### The fixtures this broke, and did not tell anyone about

Deleting `POST /api/documents` from the client app also broke `uploadPdf` and
`deleteDocument` in `tests/e2e/helpers/compass.ts`, used by five specs. **Nothing went
red**: all five were already skipping for want of a portal-bound session, so they never
reached the broken call. They would have failed for an unrelated reason the day that
session became available, and whoever was debugging it would have blamed the session
work.

Fixed by routing both fixtures through the admin app — where a person now uploads —
using a page opened on the admin host inside the same browser context, because the
platform session cookie is per app host and a fresh request context would get a 401
from the edge.

`specs/compass-ai/fixtures.spec.ts` now tests the fixture path on its own, with no
portal token, so it **runs**. It earned its place immediately: the first version of the
fix used relative paths, which Playwright resolves against the *project's* `baseURL` —
the client app, the one host that no longer has the route. The test caught it; the
five skipped specs could not have.

`specs/compass-ai/indexing.spec.ts` was **moved** to `compass-admin` rather than
repaired, because its subject moved. That converted a permanently-skipped spec into a
running one: `compass-admin/indexing.spec.ts` uploads a PDF, waits for it to index, and
asserts that anything reported as `indexed` has embedded passages — the invariant the
old spec asserted but never once executed. Its second test, "an unknown batch is a 404",
went with the batch routes.

### A silent settings bug the move exposed

`grounding.spec.ts` also wrote settings through `PATCH /api/session/settings`, which
§5C deleted. Moving its cap-validation assertion to `compass-admin/settings.spec.ts`
— where it runs — immediately failed, and not for a fixture reason:

```
maxAnswerTokens=99999      -> 200, expected 400
maxRetrievedTokens=1       -> 200, expected 400
maxOcrPagesPerUpload=0     -> 200, expected 400
retrievalMode="whatever"   -> 200, expected 400
```

All three admin settings handlers validated each key, **dropped** the ones that
failed, applied the rest, and answered `200 { ok: true, rejected: [...] }`. Every
caller checks the status and nothing else, so an operator who typed 99999 into a cap
was told it saved while the value never moved — and the screen agreed with them. The
client app's own route, the one §5C deleted, had refused properly all along; the move
quietly weakened validation.

Two things were wrong, and both are fixed by `validateSettingsPatch`:

- **A refusal is now a 400 naming the field.** "Invalid settings" leaves an operator
  with a form of eleven values and no idea which to fix.
- **The write is atomic.** A body mixing one good field with one bad one used to apply
  the good one, so a "rejected" request could still change configuration. The whole
  patch is validated before anything is written, and the test asserts the stored
  values are unchanged after a refusal.

Unknown keys are refused too: a misspelled key is a setting the caller believes they
changed. The admin screen no longer renders an "ignored as invalid" note, because
nothing is ignored any more.

---

## 5D — Cleanup, each item closed

1. **`dashboard_view` sources.** 0 rows in dev, 0 in prod, and no UI could create one.
   The reader, `lib/dashboards.ts`, the config branch, the unit-test cases, the
   `@fusebase/dashboard-service-sdk` dependency and the `dashboardView` grant are all
   gone. The grant was revoked on the platform too, not only in `fusebase.json`.
   **A real gap surfaced while doing it**: `MAX_SOURCE_FILE_BYTES` was enforced only in
   the dashboard reader, so a `sql_table` source pointing at a 200 MB PDF had no cap at
   all. The limit now lives in `fetchStoredPdf`, checked against `Content-Length` *and*
   the buffered length, which covers every path into the pipeline.
2. **Client groups.** Decided: the tables stay, documented as unused — dropping them
   means touching `owner_kind`, its CHECK and two foreign keys for no behavioural gain.
   But `POST /api/sources` now **refuses** `ownerKind: 'group'` with
   `GROUP_SOURCES_REMOVED`, because a source owned by a group nobody can populate is
   unreachable state that looks configured.
3. **Folder guards.** The cycle rule was already asserted; the **depth-overflow** rule
   was not. `folders.spec.ts` now builds to the deepest legal level, asserts a sixth is
   refused with `FOLDER_TOO_DEEP`, and asserts the same limit holds on a *move*.
4. **Untested alert codes.** `POST /api/alerts/test { code }` raises any of the twelve
   through the real `raiseAlert` — real dedupe key, real counter, real throttle, real
   email. **The guard is structural**: the handler is registered only when `stage() !==
   'prod'`, so in a deployed app it 404s at the router. There is no runtime check to
   edit. A test asserts the 404 against production, because a comment is not an
   assertion.
5. **`archived_at` wired.** The sync scan excludes archived sources, `PATCH /sources/:id`
   accepts `archived`, the sources list excludes libraries and orders archived last, and
   an archived library **cannot gain a new recipient** (409 `LIBRARY_ARCHIVED`) while
   every portal that already has it keeps it. Archiving revokes nothing; that is the
   whole point of it existing next to a delete that is refused.

---

## Still true, still not solvable

Nine tenancy tests, the upload-visibility spec and cross-portal isolation need a
**portal-launcher session**, which Gate exposes no operation to mint. That is the
tenancy property working, not a gap in coverage. The manual runbook
`tests/manual/portal-isolation.md` is the only path, and self-registration (§A.4) is
covered there for the same reason.

What changed is that their **fixtures** are now correct and independently tested, so
when a portal-bound session does become available they will fail only for reasons
about the product.

## Open items from the spec, answered

1. **Library folders** — library documents land in the portal's Unfiled, as the spec
   assumed. No library-side folder tree was built.
2. **All-or-nothing grants** — confirmed and unchanged: eight of ten documents for one
   portal means a second library, not a filter.
3. **Wording** — "Library" throughout; `owner_kind = 'library'` in the column.
4. **`portals.read`** — grantable to the admin app's token, so **discovery is the
   primary path** and self-registration is the fallback that always works. The screen
   still reports when discovery fails rather than rendering a short list silently.
