# Phase 8A — the signals start accumulating

Shipped to production on 2026-09-09. Schema at **v22** in `dev` and `prod`; RLS 32
tables, 0 warnings; both apps deployed.

§9 puts 8A first for one reason: **themes need history**, and the sooner questions are
being embedded the sooner 8C has something to say. This is that — feedback, question
embeddings, the retention purge and the run log. No new app, no clustering, no
flagging.

---

## 1. The two findings, settled before building on them

§0 asks for both, and both were measured rather than assumed.

**`grounded` is trustworthy.** NULL on **zero** assistant messages in either stage
(dev 1/1, prod 7/7), and NULL on every user message, which is correct — the column
only means anything for an answer. The write is unconditional in `rag.ts`
(`!isRefusal && citations.length > 0`, with `false` on both refusal paths), so it is
not luck of a small sample. Production already reads **5 grounded / 2 not**, so the
content-gap metric — the headline value of the whole phase — has real signal on day
one.

**`retention_days` was a promise nothing kept.** Settable per client, validated,
audited, and no job had ever deleted a row. It now does. Every client is `NULL`
(keep forever), so the first production run deleted nothing:

```
purge  succeeded  {"chats": 0, "clients": 0, "messages": 0, "themesScrubbed": 0}
```

That zero is the point. The mechanism is real and choosing a number is still yours
(§10.2) — what changed is that setting one now has an effect.

---

## 2. What §6 decides about derived rows, in writing

§6 asks for this on the day it is made rather than as a discovery a year later:

| | on purge |
| --- | --- |
| `question_embeddings`, `insight_theme_members`, `review_flags` | **cascade** — they reference the message and mean nothing without it |
| `insight_themes` | **survive** — they are aggregates |
| `sample_message_ids` | **scrubbed** of ids that no longer exist |

"We deleted your conversations and kept the themes" is defensible and is now a
documented decision. The scrub matters because `sample_message_ids` is a `UUID[]` with
no foreign key, so nothing cascades it — and a client screen showing blanks where
samples used to be looks like a bug rather than like retention working.

---

## 3. Governance, in the database rather than in a handler

§2 insists the anonymity rule is a CHECK, because "a guard written only in a handler
survives until the next refactor". It is:

```sql
CONSTRAINT insight_themes_scope_check CHECK (
  (scope = 'client' AND client_id IS NOT NULL)
  OR (scope = 'org' AND client_id IS NULL
      AND sample_message_ids = '{}'::UUID[]
      AND client_count >= 3))
```

`scripts/verify-insights-guards.mjs` proves it against a real database — **22 of 22 on
dev**, as four separate refusals rather than one, because they are four separate
promises and a combined test that passed would not say which still holds.

### Where 8A deviates from §4, and why

1. **`chat_message_feedback` is client-scoped, not staff-only.** §4 says every table in
   the phase is staff-only and "the client app must never be able to read a single
   row"; §3 puts the thumbs control **in the client chat panel**. Those cannot both
   hold. Feedback is scoped exactly like `chat_messages` — a client sees its own and
   nothing else — and the staff-only rule is applied to the five *analysis* tables,
   which is what it was protecting.

2. **"Staff-only" cannot be org-scoped alone.** Both apps run in the same org and both
   carry `app.org_id`, so a policy in the shape of 0007 would have let the client
   backend read every insight row. The barrier that actually exists is the one
   `store.ts` already documents: *"a client-facing request carries its resolved client
   and a background job carries nothing"*. The policies additionally require **no**
   `app.req_client_id`. Measured on production with real rows:

   ```
   question_embeddings   staff=7  portal-scoped=0
   insight_runs          staff=3  portal-scoped=0
   ```

   The 7 is what makes the 0 mean something — a test that would pass against an empty
   table proves nothing.

3. **`insight_theme_members` gained `org_id`.** §4's DDL omits it, which leaves the
   table with no column any RLS classification can be declared against.

4. **`ingest_jobs.kind` gained only the two kinds 8A dispatches.** `insight_cluster`
   and `insight_flag` arrive with 8C and 8D. A kind in a CHECK that nothing dispatches
   is the trap this codebase has paid for three times.

---

## 4. Four things that had to be checked rather than assumed

**The `insight_themes` constraint name collided with itself.** Postgres auto-names an
inline column CHECK `<table>_<column>_check`, which for `scope` is exactly
`insight_themes_scope_check` — the name §2 gives the anonymity rule. The apply failed
with *"check constraint already exists"*. The spec's own DDL carries the collision. The
anonymity rule keeps the documented name; the enum check is the one that moved.

**`ingest_jobs` really does have the XOR owner check.** My first comment claimed the
check was only on the derived tables, so an ownerless analysis job would be fine. It is
not: `CHECK ((client_id IS NULL) <> (library_id IS NULL))` is on `ingest_jobs` too, and
an org-wide job was refused outright. `0022` names the two kinds as an explicit
exemption — rather than the alternative, which was writing an arbitrary tenant into the
column and having every list and cost report show the run as belonging to one client.

**A vector is not JSON.** `question_embeddings.embedding` is `DOUBLE PRECISION[]`, and
the "pass JSON as a string" rule in the isolated-SQL contract is about **JSONB**. I
stringified it, and the first production sweep failed with a 400 from Gate.
`document_chunks.embedding` has taken the raw array since 0001. (`insight_runs.counts`
*is* jsonb, so it is stringified — both are now right for their own reason.)

**A failed run would have blocked its own retry for twenty hours.** The enqueue guard
looked at any recent run of that kind, so the failure above would have reported itself
once and gone quiet until the next day. It now holds off a *success* for 20 hours and a
*failure* for 1 — long enough not to churn with the 10-minute sweep, short enough that a
fix deployed now is exercised within the hour.

### The failure was the best evidence in the phase

The `insight_runs` row and the alert path were both verified by an actual failure rather
than a synthetic one:

```
embed  failed  API request failed: insertIsolatedStoreSqlRow returned 400
→ INSIGHT_RUN_FAILED raised, 1 occurrence, with the cause on the row
→ after the fix: embed succeeded {"embedded": 7, "skipped": 0}
→ alert status: resolved
```

The alert resolving itself on recovery was the last gap — without it the inbox keeps an
open alert for a run that has since worked, which is how an inbox stops being read.

---

## 5. What it costs, measured

7 questions embedded, 2 clients, 256 dimensions, `text-embedding-3-large`:

```
usage_events  via=insight_embed  events=2  input_tokens=46  cost=$0.000006
```

§3's claim that embedding every question ever asked costs less than indexing one
Compass PDF is now a measurement rather than an estimate. Cost is metered per client
through the same `recordUsage` as everything else, so insights spend appears where
ingestion spend does rather than as an unexplained line.

---

## 6. A verification hole this phase found, unrelated to it

**Backend TypeScript was never typechecked by any command in this repo.**

- `apps/<app>/tsconfig.json` includes only `src`, so `npm run typecheck` and `tsc -b`
  checked the SPA and silently skipped `backend/`.
- The backend builds with **tsup** (esbuild), which does not typecheck, so a deploy
  would not catch it either.
- The root hook uses each app's own tsconfig and never descends into `backend/`.

It surfaced because a real type error (`clientMessage: null` against
`clientMessage?: string`) sat in `alerts.ts` while both `npm run typecheck` and the
deploy reported success. Every app's `typecheck` script now runs both projects, and the
fix was verified in both directions — reintroducing the error makes the root typecheck
exit 1, removing it exits 0.

This is the same class of hole as the RLS manifest's, which this phase also closed:
`portal_reconcile_runs` had been missing from `rls-manifest.json` since 0017, and the
validator reported **zero warnings** the whole time because it checks what is declared
rather than what exists. It is declared now, and the count is 0 across 32 tables for the
first time meaning what it appears to mean.

---

## 7. Open items

1. **§2's contracts and disclosure paragraph gates 8C, not this.** Before the first
   cross-client theme is published: what the MSAs say about use of client data, and a
   line in the portal saying conversations are stored, reviewed by the KIRIA team and
   used to improve the material. The spec says get a lawyer or at least the contracts in
   front of you, and it is right. **Nothing in 8A publishes anything**, so this is not
   blocking — but 8C cannot start until it is answered.
2. **The retention default is still infinite for every client.** The job is real now;
   the number is a policy decision (§10.2).
3. **`analytics_opt_out` is `FALSE` for all seven accounts.** §2 says set it *before the
   first run* for any client whose contract is unclear — and the first run has now
   happened for the two clients that have conversations. If either of those should have
   been excluded, say so and I will delete their embeddings; the opt-out is honoured
   inside the selection query, so setting it stops any future row.
4. **§10.3–10.5 remain yours**: whether clients ever see any of this, whether three
   clients is the right cross-client threshold for a book of seven or eight accounts,
   and who should choose the five flag codes.
5. **The feedback control has no e2e coverage**, for the same reason twenty-four other
   client-app specs skip: it lives behind a portal-bound session Gate will not mint. The
   route's guarantees — one rating per person, a second submit updating rather than
   duplicating, ratings other than ±1 refused — are covered by
   `verify-insights-guards.mjs` at the database level instead.

---

## 8. Next

**8B** — `compass-insights` scaffold, Overview and Client screens on the metrics that
need no LLM: gap rate, citation frequency, never-cited documents, adoption since each
library was granted. All four are computable from what is already stored, and none of
them needs the contracts question answered.
