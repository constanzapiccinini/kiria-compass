# Phase 8C — themes, and the screen that pays for the phase

Shipped to production on 2026-09-09. Schema at **v23** in `dev` and `prod`; RLS 32
tables, 0 warnings; insights e2e **12 passed / 0 failed**; the database guards **25 of
25** on dev.

Clustering ran against real data and found the themes a person would recognise. Total
spend for all of Phase 8 so far: **$0.00092**.

---

## 1. What it found

Six themes over seven questions across two accounts. The only merge the threshold made:

| theme | questions | unanswered |
| --- | --- | --- |
| **Strategic Priorities and Stakeholders** | 2 | 0% |
| Candidate Quantity Inquiry | 1 | **100%** |
| Inquiry about Individual Identity | 1 | **100%** |
| Pharmaceutical Company Ownership Structure | 1 | 0% |
| Client Location Information | 1 | 0% |
| Branding Color Guidelines | 1 | 0% |

The merged pair is *"what can you tell me about its strategic priorities"* and *"Who
are the key stakeholders"* — which is exactly the pair a person would also call one
theme, and exactly the pair the measurement predicted at 0.429.

The two themes at 100% unanswered are the content-gap brief: nobody can answer *"cuantos
candidatos hay"* or *"quien es ryan isacsson"* from the material as it stands.

---

## 2. The threshold was wrong, and the test said so before production did

The first value written was **0.62**, an intuition carried over from full-size
embeddings. The clustering test refused it immediately — three well-separated synthetic
centres came back as twenty-four clusters — so the production data was measured. Every
pairwise cosine between the seven real questions:

```
0.429  "…its strategic priorities"      ~ "Who are the key stakeholders"
0.287  "cuantos candidatos hay"         ~ "cuales son los colores del branding"
0.261  "tell me about its family tree"  ~ "…its strategic priorities"
…
0.150  "Who are the key stakeholders"   ~ "quien es ryan isacsson"
```

The whole range is **0.15–0.43**, because `EMBEDDING_DIMENSIONS` is **256** — reduced
from the model's 3072 — and cutting dimensions compresses similarity. At 0.62 every
question would have been its own theme and the screen would have shipped saying "no
themes found", with nothing anywhere looking wrong.

0.40 sits under the one pair a person would also merge and above the next. **That is a
boundary drawn from seven questions**, so it is overridable per run and recorded in
`prompt_version` (`cluster-v1-t0.40`) — a retune does not silently make two months
comparable when they are not. Expect to move it.

### The fixture was wrong too, and blamed the code

The first fixture built vectors by adding uniform noise and trusting a spread parameter
to land the similarity somewhere useful. At 256 dimensions it did not: every vector came
out nearly orthogonal to its own centre, and the failure read as "the threshold is
wrong" when the fixture was at least as much to blame. It now constructs vectors at a
**known** cosine (`base·w + perpendicular·√(1−w²)`) and asserts its own inputs before
asserting anything about the code — a test whose inputs are not understood cannot tell
you which side the bug is on.

Then the *check* on that fixture was wrong: it compared `items[0]` with `items[1]`,
which are the same centre, and reported two members of one group as "different centres
above the threshold". Three layers of wrong before one real answer, and each was found
by the layer above it.

---

## 3. The measurement §5 asked for

§5: *"a few thousand vectors in JS is fine — **measure** before assuming otherwise."*

```
(measured: 3000 vectors of 256 dims -> 8 clusters in 40ms)
```

Confirmed, with a 10-second ceiling in the test so that if this ever becomes the reason
a nightly job times out, it fails loudly rather than slowly.

---

## 4. Determinism, and the property it does not have

§8: *"Clustering is deterministic for a fixed input and `prompt_version` — or, if it is
not, say so and pin what varies."*

**It is deterministic for a fixed set.** Items are sorted by id before assignment, so
the greedy walk visits them in the same order every run. The test asserts it by
clustering the same set forwards and reversed and comparing the output byte for byte.

**It is not stable under insertion**, and no greedy scheme is — adding one question can
pull a centroid across the threshold and merge two clusters that were separate last
night. That is asserted too, deliberately: a test that pins the limitation means a
future change making clustering insertion-stable fails here and gets the docblock — and
any month-over-month claim built on it — revisited on purpose rather than by accident.

So two periods are comparable as **labelled snapshots**, not by assuming cluster
identity persisted. `period_start`, `period_end` and `prompt_version` are on every row
for that reason, and the screen prints them.

---

## 5. Idempotence, proven by accident

Clustering ran twice on production — once enqueued by hand, once by the worker's own
sweep — and both runs reported identical counts:

```
cluster  succeeded  {"themes": 6, "clients": 2, "questions": 7, "skippedClients": 0}
cluster  succeeded  {"themes": 6, "clients": 2, "questions": 7, "skippedClients": 0}
```

Six themes in the database afterwards, not twelve. A doubled theme would read as "asked
twice as often" on a screen whose whole job is ranking by frequency — the most
misleading failure available here. The delete-then-write is the mechanism; 0023's unique
index over `(scope, COALESCE(client_id, …), period_start, period_end, label)` is the
backstop, and `verify-insights-guards.mjs` proves both that a duplicate is refused
**and** that the same label in a different period is still two themes.

---

## 6. What 8C deliberately did not build

§5 describes clustering as "nightly per client, monthly per org". **Only the per-client
half exists.** §2 permits it outright — "client-scoped screens may show questions in
full to KIRIA staff" — while a cross-client theme is gated on a question no code can
answer:

> Before the first cross-client theme is published: check what your MSAs say about use
> of client data, and put a line in the portal where clients can see it.

The org half is therefore **not written at all**, rather than written and switched off.
An unreachable branch waiting on a legal answer is the exact trap this codebase has paid
for three times. Production holds **0 org-scope themes**, and the schema refuses one
below three accounts regardless — verified.

The Content gaps screen says so on itself, and the e2e asserts that it does: a screen
that silently shows part of what it could gets read as the whole picture.

---

## 7. Two more bugs the tests caught

**A DATE rendered as a timestamp.** `period_start` came back from Gate as
`2026-09-01T00:00:00.000Z`, which the screen prints verbatim — and which a browser west
of UTC would render as **31 August** for a September period. Caught by an e2e assertion
on the date shape, fixed with `to_char` in SQL.

**A backtick inside a SQL comment closed the template literal.** The explanation for
that fix, written as a `--` comment inside the query, contained
`` `2026-09-01T00:00:00.000Z` `` — and a backtick ends the enclosing template. Invisible
in review, a parse error at build. Same family as the `${…}`-in-a-single-quoted-string
guard from Phase 6; the explanation now lives in the docblock outside the query.

---

## 8. A production outage, and what it was not

The insights backend deploy failed twice with an Azure reference and no build error —
lint passed, the archive uploaded, and the platform failed at "Requesting ACR build
source upload URL". The failed deploy left the app **with no active backend**: every
route answered `404 "API not available for this feature"`, and five e2e tests failed as
a consequence.

It was diagnosed rather than assumed: the runtime logs showed `signal SIGTERM`, which is
a container being replaced, **not** a crash — so the code was not the problem. The third
attempt succeeded unchanged.

Worth recording for two reasons. It is a platform-side transient, so retrying is the
right response and inventing a workaround would have been the wrong one. And the app is
staff-only and days old, so the outage cost nothing — which is the argument for having
put the analysis in the client app's worker (§5) rather than here: an insights outage
stops screens being current and touches no client.

---

## 9. Open items

1. **§2's contracts and disclosure paragraph** still gates cross-account themes. It is
   the only thing standing between the per-account screen that shipped and the "what
   recurs across the whole book" question §1 asks. When it is answered, the work is a
   second pass over the same functions — the schema and its proofs are already in place.
2. **The 0.40 threshold is drawn from seven questions.** Revisit at a few hundred.
   `prompt_version` is what makes a retune honest rather than silent.
3. **`analytics_opt_out` is `FALSE` for all seven accounts**, and clustering has now run
   for the two with conversations. Their questions have been sent to the model for
   labelling. If either account should have been excluded, say so and I will delete its
   themes and embeddings.
4. **The cross-client threshold of three accounts** may be low for a book of seven or
   eight (§10.4).
5. **8D — flagging and the review queue — is not built.** It is the last sub-phase, and
   §4's five flag codes are explicitly a starting guess that "the people who would
   action them should choose" (§10.5).
6. **No export yet.** §7 says build the xlsx and the monday item after screen 3 proves
   useful. It just shipped; that judgement is yours to make with it in front of you.
