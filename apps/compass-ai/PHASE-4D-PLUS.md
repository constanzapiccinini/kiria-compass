# Compass AI — Phase 4D+ : the rest of the spec

Continues [PHASE-4D.md](./PHASE-4D.md). Covers RLS §4.3 end to end, `dashboard_view`
sources, and the worst bug of the session.

## The worst bug, found last

**Every document uploaded after v4 shipped was invisible to every client.**

v4 made `portal_visible_documents` resolve visibility through `documents.source_id`,
and its backfill gave every *existing* document a source. The upload route was never
taught to set one. On prod, `SURVEY CANDIDATES _ BLUEPRINT.pdf` — a real client
document uploaded a day earlier — had `source_id = NULL` and resolved to **zero**
portals. Indexed, paid for, unreachable.

It hid behind a decision that is itself correct: an employee's document list
deliberately does **not** go through the visibility view (§6.5), because staff must see
rows that are processing, failed or orphaned. So whoever uploaded it saw it
immediately, in the sidebar, with a green "Ready" dot. Only a client would have
noticed — by not seeing it.

Fixed in three parts:

- `ensureAppUploadSource(clientId, userId)` in `lib/sources.ts` resolves §6.1's implicit
  per-client upload source, **creating it when absent** and binding it to every active
  portal of that client — a source with no binding is still invisible. Called once per
  upload batch.
- The prod row was repaired with the existing idempotent backfill:
  `indexed documents: 2, visible: 1` → **`visible: 2`**.
- `tests/manual/portal-isolation.md` gained Check 5.

**The honest part: no automated test can catch this class of bug here.**
`specs/compass-ai/upload-visibility.spec.ts` is written, typechecks, and asserts the
right thing — the *client-scoped* read, not "the document exists". It skips, because a
client-scoped read needs a session minted through the portal launcher and Gate exposes
no way to obtain one. Same wall as 4A's cross-portal criterion. That is why Check 5 is
manual and permanent.

## RLS §4.3 is finished — client isolation enforced by Postgres

Migrations **v7 → v10**, applied to dev and prod, head v10, no drift.

| | |
| --- | --- |
| v7 | org isolation on the 7 tables that already had `org_id` |
| v8 | tenancy columns on the 16 that did not, plus `client_id` on three that lacked it |
| v9 | `NOT NULL`, `DEFAULT current_setting('app.org_id', true)`, client-scoped policies |
| v10 | the two composite indexes Gate's manifest still asked for |

Gate's validation, read through `scripts/sql-migrate.mjs` — the only path that cannot
be misdirected: **23 warnings, all `rls_manifest_rls_not_forced`**, down from 15
tables that were unclassified and unprotected.

### Measured in both directions, on real data

| context | docs | chunks | pages | chats |
| --- | --- | --- | --- | --- |
| client A (0 documents) | 0 | **0** | **0** | 0 |
| client B (1 document) | 1 | **148** | **96** | 1 |
| no context (worker) | 1 | 148 | 96 | 1 |

Plus a write probe: an insert carrying a foreign org was refused by Postgres itself
(`new row violates row-level security policy`), while a same-org insert passed the
policy and failed only on a column I had omitted — the half that proves the policy
*scopes* rather than merely blocks.

Then the full e2e suite against prod with it live: **37 passed, 0 failed** (was 25).

### Three things worth carrying forward

**The settings were measured, not assumed.** A diagnostic on `/api/health/detail` asks
Postgres what the backend's own token actually carries. `app.org_id` is present and
matches. The other two are traps: `app.client_id` holds the **product** id, shared by
sibling apps, and `app.user_id` holds whoever last deployed. A policy keyed on either
would have looked plausible and been wrong, and the symptom — every read returning zero
rows — is a total outage on a live store.

**The mechanism changed from the approved plan, deliberately.** Typed
`clientQuery`/`workerQuery` would have meant threading a context through **150 call
sites across 14 files**, where one missed site silently keeps the unscoped path.
`lib/request-scope.ts` uses `AsyncLocalStorage` instead: a request opens a scope,
`resolvePortalContext` — already the single tenancy boundary — fills it in, and the
worker, which cannot be inside a request, has none. The compiler cannot prove a given
call is scoped; in exchange **no call site can forget**. A bug found while wiring it:
the portal cache returned *before* setting the scope, so for 60 seconds after each
first resolution every request ran unscoped — only visible under real traffic.

**An absent client setting grants org scope, not nothing.** The worker claims whatever
job is due, one embedding batch can span clients, and alerting is org-scoped. `0009`'s
header sets out why that is defence in depth rather than a loophole: a client-facing
request cannot reach a query without a context, and the org branch always holds.

## `dashboard_view` sources work, verified against a real dashboard

`lib/dashboards.ts` plus a `dashboard_view` branch in `parseSourceConfig`. Verified end
to end on prod against `CLIENT 1 / Table 1`, in the backend's own logs:

```
ingest.job_started   kind=source_sync
source.row_skipped   reason=file_too_large  bytes=195951886  limit=104857600
source.sync_ok       created:0  released:1
ingest.job_succeeded
```

That proves the permission grant, the schema check, pagination, cell parsing and the
size cap against the real table. Document *creation* from a dashboard row is the only
unproven link, because the sole real attachment is a 195 MB PDF over the cap — and that
step is the shared reconcile path 4B already proved.

### Four things the real data settled that the documentation did not

1. **Row values are raw**, keyed by `item_key`. The data reference was right and the
   generated output schema (nested `DashboardValueExtended`) was not, for plain
   columns. `readCell` accepts both, because a relation column really does wrap.
2. **`file.url` is relative** (`/<uuid>/<name>.pdf`) where the app's own uploads give an
   absolute S3 URL. Persisting it raw is explicitly wrong — a browser resolves it
   against the wrong host, and server-side `fetch` rejects a URL with no origin, so
   **every dashboard-sourced document would have failed to parse.** Now prefixed with
   `https://app.<host>/box/file`.
3. **A files cell carries `storedFileUUID` *and* `url`**, so `dashboard_view` needs no
   equivalent of the `columns.fileUrl` workaround 4B had to add for SQL sources.
4. **The first real row is a 195 MB PDF**, over the 100 MB upload cap. A source must not
   be a way around that cap, so oversized rows are skipped and logged.

### The permission is per dashboard AND view

`dashboardView.<dashboardId>:<viewId>.read`, no wildcard. **Every dashboard a source
points at needs its own grant and a redeploy** — an operator step per source, which the
app cannot arrange for itself. A 403 is reported as exactly that, with the command to
run, rather than as a generic failure.

## `filter` hardening — rationale corrected

The note recorded earlier said RLS was unwired. It is wired now, so the comment in
`lib/sources.ts` was corrected rather than left to mislead: a sync runs on the worker
path with **no client context**, which by design grants org scope, so a subquery in a
`filter` would still reach every client's rows in the org. **RLS narrowed this; it did
not close it.** The keyword and length limits remain the operative defence.

## Tests

- **`apps/compass-ai/backend/tests/source-config.test.ts`** — the repository's first
  unit test, now covering both source modes and the dashboard cell shapes, including
  the real 195 MB cell copied verbatim from the live response.

  One case failed and was **right to**. I asserted that `"Files"` — the column's display
  name — would be rejected as an item key. It cannot be: an item key is an opaque
  mixed-case token drawn from the same character set as a label, so no regex separates
  them. The fix was not to weaken the test but to add the real defence.
  `readViewItemKeys` compares configured keys against the view's schema and names the
  offender. Without it a wrong key is **silent** — every row returns `undefined`, the
  sync imports nothing, and it reports success.

- **`specs/compass-admin/admin-smoke.spec.ts`** — 13 passing, every admin read route
  against prod with a real staff session.

## The store hazard, sixth occurrence

`fusebase deploy` again rewrote `stores.compasses` to the orphan `compasses-prod`, and
this time applied all ten migrations to it. Harmless — it is empty and the backend
resolves by alias — but it is now a fully-schemaed decoy. **Do not read migration or
RLS status from the CLI on this repo**; use `scripts/sql-migrate.mjs`, which verifies
the alias through Gate and refuses otherwise.

## Still not done

1. **Admin upload (§9.4).** `ensureAppUploadSource` exists and the client upload path is
   fixed, but the admin app has no upload route: it needs `files.write`, its own
   `files.ts`, and a multipart route. Left whole rather than half-built.
2. **The 8 admin screens have never been opened in a browser.** Every query behind them
   is now exercised, which is not the same thing.
3. **Drag-to-reorder and the client sidebar** are deployed but unverified visually.
4. **9 of 18 tenancy tests, plus the new visibility spec, cannot run** — no portal-bound
   session is obtainable. The manual runbook's Checks 1–5 are the only coverage.
5. **`FORCE ROW LEVEL SECURITY`** — the 23 remaining warnings. One question first: does
   Gate's checkpoint path carry org context? A checkpoint that silently reads zero rows
   is a backup-shaped failure, worse than a warn-level finding.
6. **Delete the `compasses-prod` store.** Destructive; needs a human.
