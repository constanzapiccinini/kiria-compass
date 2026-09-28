# Phase 8D — flagging and the review queue

Shipped to production and verified. What follows is what was built, what it refuses,
what it cost, and the two things it got wrong before it shipped and the one it got wrong
after.

---

## What §5 asked for

> Screen new questions for anything a compliance reviewer should see. Never notifies the
> client, never reports anywhere automatically, never blocks the answer. A missed
> adverse-event mention costs far more than a false positive a human dismisses in two
> seconds.

and §7 screen 5:

> flags with the question in context, and reviewed / dismissed / escalated with a note.
> **Escalation is a human deciding, not a webhook.**

Both hold, and the second is enforced by the database rather than by the handler that
happens to write it today.

---

## The pieces

| where | what |
| --- | --- |
| `apps/compass-ai/backend/src/lib/insights.ts` | `runInsightFlag`, `classifyBatch`, `parseFlagReply`, the five codes, `flag-v1` |
| `apps/compass-ai/backend/src/lib/ingest.ts` | `insight_flag` in the kind union, the dispatch branch, and the sweep |
| `apps/compass-insights/backend/src/routes/flags.ts` | `GET /api/flags`, `PATCH /api/flags/:flagId` — the only writing module in the app |
| `apps/compass-insights/src/screens/ReviewScreen.tsx` | the queue, as cards rather than a table |
| `postgres/migrations/0024_insight_flag_job.sql` | the job kind, `review_flags_decided_by_a_person`, the per-account index |
| `postgres/migrations/0025_flag_screened_at.sql` | `chat_messages.flag_screened_at` and its partial index |
| `postgres/migrations/0026_org_wide_usage.sql` | an org-wide analysis call may have no owner to charge |

The analysis runs in the Compass AI worker and the Insights app reads it, per §5. The
drift test still passes, so this app holds no pipeline code.

---

## Three decisions worth stating

**The screen is tuned for recall, and the prompt says so twice.** There is no confidence
floor anywhere — the confidence is stored so a reviewer can sort by it and is used to
decide nothing. A threshold is precisely how a recall-tuned classifier quietly becomes a
precision-tuned one.

**A malformed reply produces no flags for that batch rather than a guess.** That is the
one place recall gives way. Inventing flags from an unparseable response fills the queue
with rows nobody can trace, and a queue like that stops being read — which costs more
recall in the end than the batch that was missed. Nothing is written for that batch, so
it is retried on the next run.

**A flag cannot leave `new` without a named reviewer and a timestamp, and cannot go
back.** "This was dismissed" and "we cannot say who dismissed it or when" are very
different sentences to have to say about an adverse-event mention later. Escalation also
requires a note; the other two decisions do not, though a dismissal is the one most
likely to be asked about.

---

## What it refuses — 35 checks, all passing

`node scripts/verify-insights-guards.mjs --stage dev`

New in 8D:

```
review flags (§5, §7)
  PASS  a flag inserted already dismissed, with nobody named: refused
  PASS  a new flag with no reviewer is accepted: 1
  PASS  dismissing a flag without naming the reviewer: refused
  PASS  naming a reviewer but no time: refused
  PASS  a decision naming a person and a time is accepted: 1
  PASS  the same code flagged twice on one question: refused

metering (0026)
  PASS  an org-wide analysis call may have no owner: 1
  PASS  an ordinary call with no owner: refused
  PASS  an ownerless usage event is invisible to a portal: 0

opt-out (§2)
  PASS  an opted-out client offers no questions to screen: 0
```

Each refusal is paired with the shape that must be **accepted**. A constraint that
refuses everything is not a guard, it is an outage.

Two new static guards in `apps/compass-ai/backend/tests/invariants.test.ts`:

- the flagging job's selection keeps **both** of its filters — losing one sends an
  opted-out client's text to a model, losing the other re-screens every clean question
  forever, and neither shows up in the run's own output;
- `parseFlagReply` can actually return a flag, tested against eight real reply shapes
  including a preamble, an unknown code, an out-of-range question number and a
  confidence over 1.

Two new e2e tests (`tests/e2e/specs/compass-insights/insights-smoke.spec.ts`): the queue
is client-scoped and reports its screening progress; an escalation with no note and a
decision reverting to `new` are both refused, with a 404 on a well-formed decision as
the control that proves the route was reached.

---

## Production

Migrations at **v26** on both stages, no drift, `rls: mode=warn tables=32 warnings=0`.

The first run happened on its own, on the worker's first sweep after deploy:

```
insight_runs kind=flag  status=succeeded  {"screened": 7, "flagged": 0, "byCode": {}}
screening progress: 7 of 7 eligible questions
unscreened remaining: 0
```

Zero flags is the right answer for those seven — they are about office locations and
candidate counts — and it is only a meaningful zero because `parseFlagReply` is
separately known to be capable of returning a non-empty list.

The 7-of-7 is also the 0025 fix working: the next sweep finds nothing pending rather
than paying for the same seven answers again.

e2e: insights **14 passed / 1 skipped**, admin **30 / 1**, client **25 / 24 skipped**
(the portal-bound sessions, unchanged and still blocked rather than skipped by choice).
Zero failures.

---

## The mistakes

**Caught before shipping — re-screening forever.** The job's first version selected
questions with `NOT EXISTS (SELECT 1 FROM review_flags WHERE message_id = m.id)`. It
reads correctly and is wrong: a question screened and found **clean** leaves no row, so
it is selected again every night, forever, for an answer already known. At seven
questions that is invisible; at a few hundred a day it is the entire cost of the feature,
and it would never look like a bug because the queue would be correct the whole time.
0025 added the marker. The marker is written **after** the flags — a crash between the
two leaves the batch unscreened and it is done again, which `review_flags_once` makes
free; the other order would mark a question screened whose flags were never saved.

**Caught by the guard I had just written.** The static check on the job's filters read
the *embedding* job's query — both open with `const pending = await query(` — and
reported the flagging job's filters as missing. Anchored on the function name instead.

**Not caught before shipping — the run's spend was never metered.** The flagging job
charges no client, because screening is KIRIA's own compliance activity and not work
done for an account. `usage_events_owner_check` from 0013 is `(client_id IS NULL) <>
(library_id IS NULL)`, so the insert was refused; `recordUsage` never throws by design,
so the error went to the log and the run reported success. Real model spend, unmetered,
and nothing on any screen said so.

This is the same XOR that 0022 had to relax on `ingest_jobs`, hit a second time, and the
second time is on me for not checking. 0026 relaxes it with the same named CASE, keyed
on `metadata->>'via'` so that "this call belongs to nobody" stays a decision somebody
made rather than a null that slipped through. Verified in both directions on prod, with
the probe row deleted afterwards.

**One run's spend is missing from the meter and is not being reconstructed.** It is a
single batch of seven short questions — on the order of $0.0003 at the rate the
clustering run measured. Writing a row for it after the fact would be inventing a
measurement, which is worse than a gap that this paragraph explains.

Phase 8 spend to date: **$0.00092** metered, plus that one unmetered batch.

---

## Still open, and not mine to close

Unchanged from `DISCLOSURE-GATE.md`, and 8D touches all of the first three:

- **the five codes.** §10.5: "The five listed are a starting guess; the people who would
  action them should choose them." They are still the guess. They are a CHECK rather
  than a lookup table, so changing them is a migration someone has to write — the right
  friction for a list that decides what gets escalated in a regulated industry.
- **the pharmacovigilance question.** If a client's employee describes an adverse event
  in a chat, KIRIA may have a reporting obligation. If so, this queue is not a
  convenience and its codes are not a guess. That is a question for counsel, recorded in
  `WHAT-WE-NEED-AND-WHY.md`.
- **the portal disclosure line** — drafted, awaiting wording. Clients are still not told
  that their conversations are read.
- **cross-client themes** — held on the MSA question. The org-scope clustering code is
  deliberately not written at all rather than written and switched off.
- **a retention number** — `retention_days` is still `NULL` for all seven accounts, so
  the purge job runs and deletes nothing.
