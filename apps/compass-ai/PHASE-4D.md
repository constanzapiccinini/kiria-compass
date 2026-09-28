# Compass AI — Phase 4D handoff

Alerts and notifications. Implements §10 of
[Coni-PHASE-4-Portal-Model.md](./Coni-PHASE-4-Portal-Model.md), the last item in its
§14 phase list. Builds on [PHASE-4BC.md](./PHASE-4BC.md).

## Exit criteria

| Criterion | State |
| --- | --- |
| `lib/alerts.ts` with idempotent `raiseAlert` | Done |
| In-app + email channels, monday stubbed | Done |
| All 12 seed codes wired to a raise point | Done — table below |
| Every code has hand-written cause + remediation | Done — remediation in the registry, cause at each raise point |
| Raise path proven against the deployed backend | **Yes, on prod** — dedupe, counter and throttle measured exact under concurrency; see [The bug the test found](#the-bug-the-test-found) |
| Verified in a browser | **Partly** — the client portal was opened and found two real bugs; see [What the browser found](#what-the-browser-found). The 8 admin screens are still unopened |

## The three properties that shaped the code

**Raising must never break the thing that failed.** Every caller is already on a
failure path, so `raiseAlert` never throws — a broken channel, an unreachable store or
a bad recipient list must not turn a handled failure into an unhandled one, or a
retryable job into a lost one. Where the caller is about to return a response anyway
(a portal refusal, a budget rejection) the call is `void`-ed rather than awaited, so no
database round trip is added in front of a rejection.

**Deduplication, not suppression.** A repeat bumps `occurrences` and `last_seen_at` on
one row. The count is the point: "failed once" and "failed 400 times since Tuesday"
need different responses, and an inbox that hid the difference would be worse than a
noisy one. What is throttled is *notification* — at most one per alert per 30 minutes.
The row is always updated.

**Auto-resolve, or the inbox stops being read.** A successful sync clears its own
`SOURCE_SYNC_FAILED` and `SOURCE_CONFIG_INVALID`. An inbox that only grows is one
nobody opens, which costs more than the record is worth.

## Where each code is raised

| Code | Raise point | Condition |
| --- | --- | --- |
| `PORTAL_NOT_BOUND` | `lib/portal.ts` | portal verified, no `portals` row |
| `PORTAL_NO_SOURCE` | `routes/documents.ts` | client's list is empty **and** zero bindings |
| `SOURCE_SYNC_FAILED` | `lib/sources.ts` | sync threw, not a config error |
| `SOURCE_CONFIG_INVALID` | `lib/sources.ts` | sync threw `SourceConfigError` |
| `DOC_OCR_FAILED` | `lib/ingest.ts` | job failed, retries exhausted, not embedding |
| `DOC_EMBED_FAILED` | `lib/ingest.ts` | job failed, retries exhausted, `OpenAiError` or `embed` |
| `BATCH_EXPIRED` | `lib/batch-embedding.ts` | batch not `completed`, or documents left unsettled |
| `OCR_BUDGET_REACHED` | `lib/sources.ts` | budget gate paused the run |
| `TOKEN_BUDGET_REACHED` | `routes/chat.ts` | question refused pre-spend |
| `LLM_TIMEOUT_REPEATED` | `routes/chat.ts` | ≥3 answer timeouts in 30 min |
| `STORE_UNAVAILABLE` | `index.ts` error boundary | unhandled error that looks like the store |
| `TENANCY_PROBE` | `lib/portal.ts` | caller sent a tenant identifier |

### Four of those are worth explaining

**Document failures raise only once retries are exhausted.** §10 allows a silent retry
while attempts remain, and that is the right line: alerting on the first transient OCR
blip notifies staff about something that fixes itself 30 seconds later, which is how a
channel gets muted. `failJob` already knows whether it will retry, so the raise sits
behind `!willRetry`.

**OCR and embedding are separate codes** because the fixes have nothing in common —
one is the file, Textract or the page budget; the other is the OpenAI key or its
credit. A single "ingestion failed" alert would send the reader to the wrong screen
half the time.

**`BATCH_EXPIRED` is one alert per batch, not per document.** A batch is one event with
one remedy; a 200-document batch would otherwise produce 200 identical alerts. It also
fires when the provider reports `completed` but documents are still unsettled — what
matters to a client is that the document is not searchable, and the provider's own
label does not change that.

**`PORTAL_NO_SOURCE` keys off the bindings, not the document count.** A portal whose
documents are still indexing is working correctly and will fix itself. No bindings is
the state that never resolves on its own. The extra query runs only when the list came
back empty.

## `STORE_UNAVAILABLE` has a limitation, stated rather than papered over

`raiseAlert` writes to the store that is unavailable. While it is *completely*
unreachable the row cannot land, and `raiseAlert`'s `console.error` is the only trace.
It is still attempted, because the outages that actually happen are partial or brief —
a Gate blip, one statement class failing, a store that returns seconds later — and in
those the row does land.

**This is not a substitute for external uptime monitoring**, and it should not be
described as one.

Detection is also message-matching, since the Gate SDK throws plain `Error`s for
transport failures and there is no type to test. Kept deliberately narrow: a false
positive raises a critical alert about the wrong thing, which is worse than missing
one, because the log line is written either way.

## The bug the test found

Running `portal-tenancy.spec.ts` against the deployed prod backend proved the raise
path end to end — 9 passed, and `system_alerts` went from 0 rows to one
`TENANCY_PROBE` row, deduplicated across every probed route as designed.

**And the count was wrong.** `audit_logs` recorded 14 refused probes; the alert read
`occurrences: 3`. Eleven raises had been silently lost.

The first implementation did a plain read-then-write — read for an open row, insert if
absent, otherwise write `occurrences = read + 1`. Two races, both hit because the
backend runs on up to three replicas and the suite drove six concurrent clients:

1. Several callers find no row, all attempt the insert, one wins, and the rest take a
   unique-constraint violation that the outer catch swallows as "could not record".
2. Two callers that both find the row read the same `occurrences` and both write the
   same `N + 1`, so one increment vanishes.

Both are now closed in `upsertAlert`: a unique violation is treated as "someone else
created it" and the loop re-reads and increments, and the increment is a
**compare-and-set** filtered on the `occurrences` value that was read, so a concurrent
increment matches zero rows and the caller retries against the new value. Same pattern
as `claimSource`, and needed for the same reason — `updateRows` writes literals, and
`occurrences = occurrences + 1` would need `isolated_store.execute`, which this backend
deliberately does not hold.

**The fix was then measured too, and the first version was still short.** Re-running
the same suite gave 14 probes and `occurrences +9` — an improvement on 3 of 14, but
five raises still ran out of retries. Three attempts is too few when callers are
released in lockstep by the same commit, so the loop now allows eight attempts with a
short jittered pause between them to break up the convoy. Still bounded: a
pathological burst degrades to "the tally is low", never to a hung request, and the
alert row itself is never at risk.

### Final measurement — both fixes, one run

Third run of the same suite against prod, with the throttle window deliberately
elapsed (83 minutes since the previous notification) so that both properties were
observable at once:

| Metric | Before | After | Δ |
| --- | --- | --- | --- |
| Refused probes (`audit_logs`) | 70 | 84 | **+14** |
| `system_alerts.occurrences` | 12 | 26 | **+14** — every raise counted |
| `in_app` deliveries | 10 | 11 | **+1** — one notification from 14 concurrent raises |
| `last_notified_at` | 18:47:40Z | 20:11:18Z | claimed exactly once |

`occurrences` now tracks the independent audit count exactly, and 14 concurrent
callers produced one notification rather than ten. Compare with the first run: 14
probes → 3 counted, 10 notified.

### And then the same bug again, in the throttle

Checking the delivery rows from that run found `alert_deliveries` holding **ten**
`in_app` deliveries for an alert that should have notified once. The throttle had the
identical shape: read `last_notified_at`, compare it to now, send, then stamp it. Every
concurrent caller read NULL, so every one passed the check.

With `in_app` that is only redundant rows. **With email configured it is ten emails
about one failure** — precisely the flood the 30-minute throttle exists to prevent.

`claimNotificationSlot` now *claims* the slot instead of checking it: the update is
filtered on the exact timestamp that was read (or on its being NULL), so one caller's
write matches and the rest stand down. The stamp therefore lands **before** sending
rather than after — the right trade, because a send that then fails is recorded on
`alert_deliveries` and retried by the sweep, whereas stamping afterwards is what opens
the window.

One deliberate asymmetry: if the claim update itself errors, the code notifies anyway.
A duplicate notification is recoverable; silence is not.

The re-run confirmed it: 14 concurrent raises produced **zero** new notifications,
because the previous notification was 7 minutes earlier and the 30-minute window had
not elapsed. `last_notified_at` was correctly left untouched.

A note on how nearly that measurement was misread: the first reading of it looked like
a *failure*, because a local clock at 20:55 next to a stored `18:47Z` suggested the
window had long expired and a notification was therefore missing. The timestamps are
UTC and the clock was UTC+2. Comparing `now()` **inside the database** against the
stored value gave the 7 minutes and settled it. When verifying a time-based rule,
take both times from the same clock.

### The lesson

**Code review would not have caught either of these, and mine did not.** Both needed
the code run under real concurrency and then the numbers checked against an independent
record — `audit_logs` for the counter, `alert_deliveries` for the throttle. "It works"
and "the numbers are right" are different claims, and only the second one is worth
anything in an alerting system.

Both were the same underlying mistake: read-modify-write against a table that three
replicas share. `claimSource` in 4B already had the answer, and I did not reach for it
until measurement forced me to.

## What the browser found

The client portal was opened for the first time. Upload, indexing, the sidebar tree,
the status dot, the settings header and the usage counters all worked — and two things
did not. Both were invisible to backend tests by construction.

### 1. The PDF viewer could not load any document (400)

```
Could not open SURVEY CANDIDATES _ BLUEPRINT.pdf
Unexpected server response (400) while retrieving PDF
".../api/documents/129c22e1-.../file"
```

`pdfjs.getDocument` issues its **own XHR** rather than going through the app's fetch
wrapper, so it never picked up `portalHeaders()` the way every other backend call
does. The request arrived with no `x-portal-context`, and the backend correctly
refused it with `PORTAL_CONTEXT_MISSING` — which reaches the user as pdf.js's opaque
"unexpected server response (400)".

Fixed by passing `httpHeaders: portalHeaders()` to `getDocument`. The token stays in a
header and deliberately not in the query string: the backend also accepts
`?portalFeatureContextToken=`, but a token in a URL ends up in access logs, referrers
and browser history.

Worth noting *why* no test caught it: every e2e request is made with the `PortalApi`
helper, which sets the header. Only a real pdf.js load exercises the path that does
not. **The viewer has never had a working document in this deployment** — it was
broken for every document, for every user, the whole time.

### 2. The upload receipt never cleared

`SURVEY CANDIDATES _ BLUEPRINT.pdf: queued for indexing` stayed on screen next to the
same document's green "indexed" dot and a header reading "1 of 1 documents ready".
`outcomes` was set on upload and never reset.

A `queued` line is a *receipt* for the upload, not a status — the sidebar owns status
and shows it live per document. So queued receipts now clear after six seconds, while
**failures stay indefinitely**: those need someone to act, and the sidebar cannot show
a document that was never created.

## A third bug, found while cleaning up — migration v6

Resolving the test-generated alert on prod failed:

```
duplicate key value violates unique constraint "system_alerts_dedupe_key"
```

v4's constraint was `UNIQUE (org_id, dedupe_key, status)`, and its own comment claimed
this "does not block a new alert when the same failure recurs". It allows that — but it
also allows only **one row per status**, which is a different property:

1. Failure happens → row A `new`
2. Staff resolve → row A `resolved`
3. Failure recurs → row B `new` — fine, as intended
4. Staff resolve → **violation**, because row A already holds `(key, 'resolved')`

So step 4 fails. **The admin Resolve button 500s permanently for any alert that has
ever been resolved once before** — and only after a recurrence, which is precisely the
case the dedupe design exists to serve. Nothing warns anyone: the inbox keeps working
and only the transition is broken.

`0006_alert_dedupe_open_only.sql` (checksum `69413731bdcc…`, applied to **dev and
prod**, head v6) replaces it with a partial unique index over the open statuses only:

```sql
CREATE UNIQUE INDEX system_alerts_open_dedupe_key
  ON public.system_alerts (org_id, dedupe_key)
  WHERE status IN ('new', 'acknowledged');
```

That is the property that was actually wanted — at most one *open* alert per key, with
an unbounded resolved history, the history being what makes recurrence over time
visible at all. It also matches `raiseAlert`'s own lookup predicate exactly, so the
read and the constraint cannot disagree about what "open" means. Verified after the
apply: two resolved rows sharing one dedupe key now coexist.

The general lesson, since this is the third bug of the same family: **a status column
inside a uniqueness key almost always means "one per state" when the author meant "one
while in these states".**

## Dedupe key

`sha256(code | clientId | portalRowId | sourceId | documentId | dedupeExtra)`, unique
on `(org_id, dedupe_key, status)`.

Scoping the constraint by status is what makes recurrence visible: a resolved alert
does not block an identical new one when the same failure returns later.

`dedupeExtra` exists because of `PORTAL_NOT_BOUND` — an unbound portal has no `portals`
row **by definition**, so without the platform portal id in the key every unbound
portal in the org would collapse into one alert and only the first would ever be named.
`TENANCY_PROBE` deliberately uses none of the ids: a scripted sweep of every tenant key
across every route should produce one alert whose occurrence count is the signal, not
hundreds that bury it.

## Channels

| Channel | Behaviour |
| --- | --- |
| `in_app` | Always on, not configurable. Records a `sent` delivery for the trail. |
| `email` | Gate `sendOrgEmail`, one call per recipient. Off unless recipients exist. |
| `monday` | Stub. Records a **failed** delivery naming the reason. |

`in_app` cannot be switched off because the Alerts screen reads `system_alerts`
directly — disabling it would suppress the delivery record and not the visibility, so
the toggle would lie.

The monday stub records `failed` rather than `skipped` on purpose: an operator who
enabled the channel and heard nothing needs to see why, or they will conclude the
alerting itself is broken.

Email is **one Gate call per recipient** — `sendOrgEmail` takes exactly one, resolved
against org membership (digit-only = userId, contains `@` = email, and the person must
already be a member). So one bad recipient fails on its own row and the others still
go out. Retries live on the worker sweep with a widening delay, never in the raise
path: a mail outage must not slow down the pipeline whose failure the alert is about.

## Migration v5

`postgres/migrations/0005_alert_trace_steps.sql`, checksum
`0cfae8bbd7630fa5499c2fb10e60121053de001d43c3294dd118f23a1a6f0a53`. **Applied to dev
and prod**, no drift. Manifest `bundleVersion` 5.

Adds `answer_timeout` to `rag_traces_step_check` plus a partial index for the threshold
query. `LLM_TIMEOUT_REPEATED` needs a count of recent timeouts, and that count has to
be **durable rather than per-process**: the backend runs on up to three replicas, so an
in-memory counter would need three times the failures before any single replica reached
the threshold — turning a threshold of 3 into an effective 9 at exactly the moment the
product is failing.

Two things the migration caught that review had not:

1. **The `step` CHECK constraint would have rejected the insert** — inside the error
   path of a request that had *already* failed, which is the hardest place to notice a
   bug.
2. **`TraceStep` in TypeScript had drifted from the SQL constraint.** It was missing
   `resolve_portal`, which 0003 added months of work ago. Both values are now in the
   union with a comment tying it to the constraint.

## Admin app

Acknowledge / resolve / reopen already existed. 4D adds what was missing:
**there was no way to configure recipients, so email could never be turned on.**

`GET`/`PUT /api/ops/alert-settings` plus a collapsed "Notification channels" panel on
the Alerts screen. Collapsed because it is configured rarely and read never — but it
belongs on that screen, since "why didn't anyone hear about this?" is asked while
looking at the alert nobody heard about.

- **Email-on with no recipients is refused, not saved.** That state reads as configured
  and delivers nothing, which is the worst of both.
- **Org membership is not re-checked here.** That is Gate's decision at send time, and
  duplicating the rule would let the two answers disagree; the delivery row records the
  real per-recipient outcome.
- **The recipient count, not the addresses, goes in the audit trail.**

Contract: 33 paths, **37 operations**, verified one-for-one against the registered
routes.

`PlainTextarea` was added to `components/ui/native.tsx` — `PlainInput as="textarea"`
does not retype props, so `onChange` stayed typed against `HTMLInputElement` and `rows`
was rejected outright. Same Chakra trap as `Box as="select"`, third time in this
codebase.

## Permissions published

`fusebase analyze gate` picked up `sendOrgEmail` and derived `email.write`; synced with
`fusebase app update jkbjijn0ndnorxzp --sync-gate-permissions`. Grant is now
`email.write, files.write, health.read, org.members.read` plus backend-only
`isolated_store.data.write, isolated_store.read`.

**`isolated_store.execute` is still deliberately absent**, so every write stays on the
structured row API.

Compass Admin was found to be **registered on the platform but missing its `id` from
`fusebase.json`** — it lives in `environments/prod.json` (`79mh8hv7ti9uvzgg`) now, so
deploy targets the existing app instead of creating a duplicate. Its grant is
`org.read` plus the same backend-only store pair.

## The store-binding hazard fired again

`fusebase deploy` rewrote `environments/prod.json`'s `stores.compasses` back to
`e77bf744…` — the empty `compasses-prod` store — **immediately after I corrected it to
`a1174ace…`**. That is the fourth occurrence.

Patching the value is provably useless. The defenses that do work are already in
place: `scripts/sql-migrate.mjs` verifies the alias through Gate and refuses otherwise,
the e2e helper resolves by alias, and the backend resolves by alias at runtime and
never reads this file. **Nothing should be added that trusts this field.**

The recommendation from 4BC stands: delete the `compasses-prod` store. Empty,
unreferenced, and CLI tooling keeps re-selecting it. Destructive, so it needs a human
decision.

## Not done

1. **One of the 12 codes has been raised for real.** `TENANCY_PROBE` is proven on
   prod, and it exercised the shared machinery — dedupe, the occurrence counter, the
   in-app delivery row, the throttle. The other 11 raise points typecheck and sit on
   paths earlier phases exercised, but none has actually fired.
2. **The email channel is proven.** A real alert email was delivered — `alert_deliveries` shows `channel=email, status=sent, attempts=1`, and **exactly one** email came out of 14 concurrent raises. The test recipient was `staff@example.com`; the list has since been moved to `owner@example.com` (org owner), because alert bodies carry internal remediation detail — table names, source names, client names — and that address was org role `client`.
3. **`monday` is a stub** (§10.3 asks for exactly that in v1).
4. **§15 e2e** now covers the admin read routes (mostly skipped — see above) and nothing else of 4B/4C/4D: no spec touches sources or folders.
5. Carried forward from 4BC, minus folder reorder which is now done: `dashboard_view`
   sources; admin upload; RLS (§4.3) still unwired — **do not describe the app as
   row-level-secured**.
6. **The OpenAI key has been rotated** and the portal answers questions, so embeddings
   and completions both work against the new key.

## Beyond 4D — two spec gaps closed while verifying

### Admin read routes now have a smoke test (§15)

`tests/e2e/specs/compass-admin/admin-smoke.spec.ts` — every admin GET, shallow and
wide: assert no 5xx and that the documented envelope is present. It exists because the
class of bug hiding behind those eight unopened screens is **a query that only fails
when it runs**, and one was already found by reading code (the sync-history route
selected `ingest_jobs.started_at`, a column that does not exist, so the screen would
have 500'd on first click). Read-only by construction — a smoke test on a live
organisation is the wrong place to discover that a delete route works.

**14 of its 15 tests skip, and the reason is worth recording rather than shrugging at.**
`requireAdmin` needs an org role in {member, manager, owner}, and no staff fixture in
this environment can obtain a session: Gate returns a magic-link URL inline only for an
address with **no** FuseBase account, or one that has already activated a link for this
org, and emails it otherwise. `owner@example.com` is neither, and being the org *owner*
does not lift it. The only inline-returnable fixture (`e2e`) is role `client`.

So the one test that does run is the refusal — a client-role session is refused by the
admin app, **proven on prod**. That is deliberately the most security-relevant
assertion in the file: admin routes legitimately accept a `clientId`, which is a
tenancy probe in the client app, so `requireAdmin` is the only thing keeping a client
out and it should not be taken on trust.

**One human action unblocks both this and Phase 4A's cross-portal exit criterion**
(which also needs `owner`): either have `owner@example.com` activate one emailed link for
this org, after which the platform returns it inline for later runs, or add a staff
fixture on a brand-new address. Creating an org member sends a real invitation, so that
choice is not mine to make.

### Folder reorder (§7.2)

`reorderSiblings` in `lib/folders.ts` plus `PUT /api/folders/order`. `position` had
been maintained since folders existed — `createFolder` appends, `moveFolder` appends
into the new parent — but nothing could ever *change* it, so a tree could only be
ordered by creation accident.

Three deliberate constraints:

- **The list must be complete.** Reordering is a statement about a whole sibling set;
  applying a partial one leaves the omitted folders holding positions that collide
  with the new ones. A drag in a UI produces the full resulting order anyway.
- **Positions are dense 0..n-1.** Sparse numbering only helps when inserting without
  rewriting neighbours, and every caller here rewrites the whole set.
- **It never reparents.** That is `moveFolder`, which owns the cycle and depth checks.
  Folding reparenting in here would put it behind validation that does not look for
  cycles.

A separate route rather than another optional field on `PATCH /:folderId`, because the
subject differs: this acts on a sibling set keyed by its parent. `parentId` is a body
field precisely so `null` can mean the root level — there is no uuid for root.

One `updateRows` per folder, since a structured update writes literals and there is no
single statement assigning each row a different position without
`isolated_store.execute`, which this backend deliberately does not hold. Sibling sets
are one folder level, so it is a handful of calls. Each write is filtered on
`client_id` as well as `id` — the ids are verified just above, but a tenancy filter on
the write itself is what makes a future refactor of that check fail closed.

Contract: 30 paths, **39 operations**, re-verified one-for-one.

**The sidebar has no drag-to-reorder affordance.** The endpoint is the gap 4BC named;
wiring the UI is separate work and could not be verified here anyway.

### A widened trust boundary in source `filter`, narrowed

`config.filter` is the one part of a source config that reaches SQL as **authored
text** — it is a boolean expression, not a value, so it cannot be parameterised. It
was accepted verbatim, on the stated reasoning that "only employees can configure a
source". Two facts make that too generous:

1. **"Employee" is wider than "KIRIA staff."** The derived role is
   `orgRole ∈ {member,manager,owner}` **or** `isPortalManager` — confirmed at
   `lib/portal.ts`, where `member?.isPortalManager === true` alone sets
   `actor = 'employee'`. A portal manager can be someone on the client's side, and
   `requireEmployee` is what guards every source route.
2. **The query has no row scoping.** `readSourceRows` runs through `query()`, which is
   READ ONLY — so nothing can be written — but **RLS (§4.3) is still unwired**, so a
   `SELECT` reaches every row in the store. A subquery in this fragment could read
   another client's documents, chunks or chat messages and surface them as documents
   inside the author's own portal.

And it does not require malice: one mistyped filter that widens to another client's
rows would have the sync create documents for the wrong tenant — exactly what §6.5
prevents everywhere else.

`boundedFilter` now narrows the fragment from "arbitrary SQL" to "a boolean expression
over this table's own columns", refusing statement chaining, comments (which truncate
the rest of the query), `SELECT`/`UNION`/`FROM`, DDL and DML keywords, `pg_` catalog
access and `information_schema`, plus a 500-character cap.

**The trade-off, stated:** a filter that genuinely needs a subquery is now impossible.
Acceptable, because a filter's job is to exclude rows of the configured table, for
which its own columns suffice, and `columns.include` already covers the "there is a
boolean flag" case. Anything needing a join should get a reviewable database view.

It is a blunt instrument and not a SQL parser — a second line behind the read-only
transaction, **not a substitute for the row scoping RLS still owes**.

**Nothing existing breaks:** no `compasses_table` source exists on dev or prod. Every
source is `app_upload` with an empty config, so this was tightened before the first
real filter was ever authored — checked, not assumed.

### The project now has a unit test, because this deserved one

`apps/compass-ai/backend/tests/source-config.test.ts`, run with `npm test` from that
directory (`tsx`, already a dev dependency — no new harness).

It covers both halves of the injection surface: identifiers and the filter. **The
false-positive cases matter as much as the refusals** — `selected_at` and `from_date`
are plausible column names that a careless keyword check rejects, and a validator that
blocks legitimate configs is one that gets loosened by whoever hits it next. Both pass,
as does the case-dodging `SeLeCt`, the length cap and six malformed identifiers:

```
PASS — 7 allowed, 10 refused, 6 bad identifiers refused
```

Worth noting as a gap in its own right: **this is the first unit test in the
repository.** Everything else is verified through a deployed request, which is why the
pure logic carrying the most risk had never been exercised directly.

## RLS (§4.3) — the determination, and the one decision it needs

Investigated because the `filter` finding gave it a concrete consequence rather than
just a spec obligation. Two things are now known that were not:

**1. RLS is enforceable in this store.** `bundle --rls-status` on prod reports:

```
currentUser: isolated_pg_runtime    bypassRls: false    superuser: false
tableCount: 27                      rlsEnabledCount: 0
```

`bypassRls: false` on a non-superuser runtime role means policies would **actually
filter**. This is not the degraded case AGENTS.md warns about, where `rlsContext` sets
transaction-local settings that no policy consumes and the UI has to be labelled
"policies not enforced". Whatever is written here would be real.

**2. The delegated context is unavailable, so the fallback is the only route.**
`queryIsolatedStoreSql` accepts `rlsContext` (an arbitrary settings map), but
`trustedRuntimeContext.portalId` / `.workspaceId` require
`isolated_store.rls.delegate`, which this app deliberately does not hold (4C declined
to request an unused elevated privilege). So the path today is a custom key such as
`req_client_id` derived from the verified portal context — which AGENTS.md permits only
as "a reviewed temporary fallback".

### Why this is not a small change, and was not started blind

Enabling RLS with a client-scoped policy on a store whose backend sets **no** context
today means every read returns zero rows: an instant, total outage on a live app
holding a real client's documents.

And it cannot simply be "set the client id on every call", because a large part of
this backend is legitimately cross-client **by design**, not by leak:

| Path | Why it spans clients |
| --- | --- |
| `claimNextJob`, `reclaimStaleJobs` | the queue is org-wide; a worker claims whatever is due |
| `enqueueDueSources` | scans every source for one that is due |
| batch polling (`embedding_batches`) | one batch can carry several clients' chunks |
| `raiseAlert` dedupe read, `app_settings` | alerts and channel config are org-scoped |

A policy strict enough to protect a client's documents stops the worker dead. A policy
permissive enough for the worker — "allow when the setting is absent" — is a hole,
because any query that forgets to set the context then sees everything, which is the
failure mode RLS was meant to remove.

So the real content of §4.3 is a **two-path store layer**: a scoped path for
client-facing reads and an explicitly unscoped path for the worker, with the split
enforced by the type system rather than by remembering. That is a deliberate
architectural change, it carries outage risk on a live deployment, and it wants a
decision on approach before code — not a guess at the end of a session.

**In the meantime the honest statement stands: this app is not row-level-secured.**
Tenancy is enforced in application code — the portal context, the
`portal_visible_documents` view, and `loadOwnedDocument`'s single resolution point —
and that is what the e2e suite exercises.

## RLS step 1 is applied and enforcing — migration v7

`postgres/migrations/0007_rls_org_isolation.sql`, checksum `1ed04893131e…`, applied to
**dev and prod**, head v7, no drift. Plus the first
`postgres/migrations/rls-manifest.json` this project has ever had — without one, every
table's security posture was simply undeclared.

### It was measured before it was written

Enabling RLS keyed to a setting the backend does not carry turns every read into zero
rows — a total outage on a live store holding a real client's documents. That could not
be established from a script, because the operator token gets a different injection
than the app's own service token. So `/api/health/detail` gained a diagnostic that asks
Postgres directly, and `specs/compass-ai/rls-context.spec.ts` reads it:

```
app.org_id    = "u27b70"             <- present, and matches this org
app.client_id = "sfqksmtybcsejlru"   <- the PRODUCT id, not clients.id
app.user_id   = "3700332"            <- the deploying owner, not the visitor
app.portal_id = ""                   <- empty; needs isolated_store.rls.delegate
```

`app.org_id` is the only injected setting that is both present and means what a policy
needs it to mean. **The other two are live traps**: a policy on `app.client_id` would
compare against a product id shared by sibling apps, and one on `app.user_id` would
scope every row to whoever last deployed.

### Enforcement, proven in both directions

Not asserted — probed on dev, where an insert carrying a foreign org was refused by
Postgres itself:

```
insert clients { org_id: "SOME-OTHER-ORG" }
  -> new row violates row-level security policy for table "clients"

insert clients { org_id: "u27b70" }
  -> null value in column "slug" ...     <- passed the policy, failed on my payload
```

The second is the useful half: same-org writes get through, so the policy is scoping
rather than simply blocking. Then on prod, after applying: every row still visible
(including through `portal_visible_documents`, which joins two now-RLS tables), the
full e2e suite **25 passed / 0 failed** across both apps, and the app went on to write
14 audit rows and raise an alert under the new policies.

### What it does and does not cover

**Covers** the seven tables carrying `org_id`: `clients`, `client_groups`, `portals`,
`document_sources`, `system_alerts`, `audit_logs`, `app_settings`. `audit_logs` gets
SELECT + INSERT policies only — verified in code that nothing anywhere updates or
deletes an audit row, so append-only is now enforced rather than merely intended.

**Does not cover** `documents`, `document_chunks`, `chats`, `chat_messages`,
`document_pages`, `document_paragraphs` — the tables whose contents a cross-tenant read
would actually expose. They carry no `org_id` at all. Closing that needs `org_id` plus
covering indexes across ~15 tables and a backfill: a separate migration and seed step.

**So client-level tenancy is still enforced in application code**, and this app still
must not be described as row-level-secured. What changed is that org-level isolation is
now real and Postgres-enforced, and the declared posture is true instead of aspirational.

`current_setting(..., true)` returns NULL when absent and `org_id = NULL` is NULL, so a
caller arriving without org context sees nothing — fail-closed by construction.

### The one remaining warning, deliberately

Gate now reports **7 warnings, all `rls_manifest_rls_not_forced`** — down from 15
(`rls_not_enabled`, `policy_missing` and one `index_missing` are gone).

`FORCE ROW LEVEL SECURITY` is not switched on because it applies policies to the table
**owner** as well, and the owner is the role that runs migrations and platform
checkpoints. DDL is not row-filtered so migrations are safe, but whether Gate's
checkpoint path carries org context is unknown — and a checkpoint that silently reads
zero rows is a backup-shaped failure, which is worse than a warn-level manifest
finding. Answering that one question is the prerequisite; guessing is not.

### The store-binding hazard, fifth occurrence — and it hit RLS validation

`fusebase isolated-store sql bundle --status` reported `currentVersion: 6` and all 15
warnings *after* v7 was applied. It was reading
`iso_…_compasses_prod_prod_e77bf744` — the **empty orphan store** — because the
environment overlay outranks `fusebase.json`.

Manifest validation from the wrong database is worse than none: it confidently answered
"your policies are missing" about a database the app never touches. So RLS manifest
forwarding now lives in `scripts/sql-migrate.mjs`, after `assertStoreAlias`, which is
the only path in this repo that cannot be misdirected. `npm`-free usage:

```
node scripts/sql-migrate.mjs status --stage prod
  store a1174ace-… alias=compasses stage=prod
  rls: mode=warn tables=24 warnings=7
    7x rls_manifest_rls_not_forced
```

**Do not read RLS status from the CLI on this repo** until the orphan store is deleted.

## A correction to the alert-counter claim

The earlier measurement — 14 probes, `occurrences +14` — was accurate when taken, but
it is not a guarantee, and the post-RLS run measured **13 of 14**: one raise still lost
its retries under contention, with RLS adding a little latency to each round trip.

So the honest statement is that the occurrence counter is **near-exact and
best-effort**, not exact. That is by design — it degrades to "the tally is low", never
to a lost alert — but the number to trust for `TENANCY_PROBE` is `audit_logs`, which is
append-only and now RLS-enforced as such. Chasing exactness would mean an append-only
occurrence table, which is not worth a column whose job is distinguishing a blip from
four hundred failures.
