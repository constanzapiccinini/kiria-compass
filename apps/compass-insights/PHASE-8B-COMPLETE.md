# Phase 8B — Compass Insights, on the metrics that need no LLM

Shipped to production on 2026-09-09. Third app registered (`iodrlh6iihrcfuw7`), Gate
permissions synced, e2e **11 passed / 0 failed**.

§9 puts 8B here because three of §1's four questions are answerable from what has been
stored since `0001`. No clustering, no model call, no contracts question — just the
reads.

---

## 1. The numbers are real, and were measured before the screens existed

Every query in `routes/metrics.ts` was run against production first. That order matters:
a screen built on a query that turns out to return nothing is a screen nobody can tell
is broken.

| §1's question | production, today |
| --- | --- |
| What do clients ask that our material does not answer? | **28.6%** — 2 of 7 answers found nothing |
| Which parts of what we produce get read? | `Mayo Clinic_KIRIA_3.8.2026.pdf`, 14 citations across 4 answers |
| What do we produce that nobody opens? | 2 documents, indexed 2 and 4 days ago |
| What themes recur across the book? | 8C — needs clustering |

The gap rate is the headline §1 names, and the screen shows it **with its denominator**.
"28.6%" over seven answers is not a rate, it is an anecdote, and the tile that hides the
count is the one that ends up in a slide.

---

## 2. Four screens, ordered by the question each answers

**Overview** — org-scoped. Counts, a weekly series, and a coverage line saying how much
of the book the numbers cover: a gap rate over two of seven accounts is a fact about
those two, and the rate alone cannot say so.

**Accounts** — the picker, then one account. **The only screen where verbatim question
text appears**, which §2 permits explicitly. Each unanswered question is paired with the
answer that failed, because the question alone does not distinguish "we have never
written this" from "we have and retrieval missed it" — different work.

**Content** — most read and never opened. The library is shown beside every never-cited
document, and that is load-bearing: production holds two documents called
`brand guidelines - kiria.pdf` in different libraries, one cited fourteen times and one
never. Without the library, the same name appears in both tables and the screen looks
broken. Same disambiguation the client sidebar needed in Phase 6 — a document name is
not an identifier.

**Runs** — thin, because each row already carries its counts and its error. That is what
makes `INSIGHT_RUN_FAILED`'s remediation ("read its error") a true instruction.

"Never cited" has a **seven-day floor**, returned in the response so the screen states
the rule rather than implying a verdict. A PDF indexed an hour ago is not evidence that
nobody wants it.

Panels for themes and flags are **named, not empty**. An empty "Top themes" box is a
claim that there are none; the text says the feature has not shipped.

---

## 3. No pipeline code, held to it mechanically

§5 is the load-bearing decision: the analysis runs in the Compass AI worker, and this
app "contains no pipeline code at all — it reads and it manages queues".

`tests/drift.test.ts` enforces both halves:

- **Six backend helpers byte-identical** to Compass Admin's — `auth`, `admin-auth`,
  `store`, `config`, plus `gate` and `observability`, which the first two import.
  Copying a *stripped* observability would have meant `admin-auth.ts` could no longer be
  compared byte-for-byte, trading the guard for tidiness. So the copy carries
  `recordUsage` and `recordTrace`, which this app never calls: unused exports inside a
  mechanically-verified copy are a different thing from hand-written dead code.
- **Three shared UI files** too (`primitives.tsx`, `ui/native.tsx`, `theme.ts`), which
  §5 does not ask for but the same argument covers.
- **No embedding, completion, OCR or `enqueueJob`** anywhere outside the copied helpers.

Verified in both directions: a one-line change to this app's `store.ts` produces

```
FAIL (store.ts has drifted from compass-admin's copy)
      admin  219149c831bf (303 lines)
      here   70ca2b93fbd2 (304 lines)
      first difference at line 26
```

and a comment added to `theme.ts` fails the UI half.

The scaffold ships Tailwind and shadcn; this app uses Chakra and the admin's primitives
instead. Staff move between Admin and Insights in the same sitting — a portal in one tab,
its questions in the other — and a second visual vocabulary for the same audience is a
cost with no upside.

---

## 4. The §2 boundary: two guards, because the first two were not enough

§2: *"Verbatim question text never leaves its client. Org-scoped screens may show only
labels, summaries and counts."* Getting a test for that right took three attempts, and
the failures are the useful part.

**Attempt 1 — sample a question and grep for it.** Written, passed, and proved nothing:
it picked the first account with *questions*, which had no *gaps*, so the client-scoped
endpoint returned nothing to search for and the test **skipped itself**. A skip on the
one assertion that matters is worse than no test.

**Attempt 2 — sample from the account with gaps.** Passed. Then a leak was planted
deliberately — the most recent question added to the overview response — and the test
**still passed**, because that question belonged to the account with no gaps and was
never sampled. A guard that only catches leaks of the rows it happened to look at is not
a guard.

**Attempt 3 — a length threshold.** Any string over 64 characters in an org payload
fails, on the theory that a question is prose and a label is short. Then the real
questions were measured:

```
24  "what are their locations"
51  "what can you tell me about its strategic priorities"
22  "quien es ryan isacsson"
```

22 to 51 characters. **Length does not distinguish a client's question from a column
header**, and the check built on that premise passed the planted leak too.

**What ships — a field allowlist.** Every string in an org-scoped payload must come from
a named, sanctioned key. A *new* string-valued field fails whatever it contains, which is
exactly the shape the real mistake took:

```
Error: /api/metrics/overview carries string fields an org-scoped response has not
sanctioned: leakedForTest = "what are their locations"
```

Plus the sampling check, now over **every** unanswered question of every account, which
covers text stuffed into an already-allowed field. Neither alone was sufficient; the pair
is the coverage, and the spec says so where the list lives.

---

## 5. Permissions and access

`--access=orgRole:member` (§7), and the synced Gate permissions are exactly the list §7
gives plus the one the role check needs:

```
gate [org.read]
backendOnlyGatePermissions: isolated_store.data.write, isolated_store.read
usedOps: 7
```

**No `files.write`** — this app never touches a file, and a permission granted "just in
case" is one nobody can later argue against.

Three independent layers keep a client out: the platform edge, `requireAdmin` on every
route, and RLS policies that refuse any request carrying `app.req_client_id`. The third
is measured on production with real rows — `question_embeddings` reads 7 for staff and
**0** for a portal-scoped request.

`AuthExpiredModal` was copied from the admin app and then **deleted**: only the client
app renders it, because only the client app holds a platform token in the browser. This
app makes same-origin cookie calls, so its auth failures are 401/403 from its own
backend, which the shell handles — 401/403 is a refusal, anything else is retryable and
must never be reported as "you are not allowed". (The admin app still carries the file
unused; that is pre-existing and not touched here.)

---

## 6. Open items

1. **§2's contracts and disclosure paragraph still gates the cross-client half of 8C.**
   Nothing in 8B publishes anything, and the client-scoped clustering §2 explicitly
   permits does not need it — but an **org-scope** theme does, and the database refuses
   one below three clients regardless.
2. **`analytics_opt_out` is `FALSE` for all seven accounts** and the first embed run has
   happened for the two with conversations. Still yours to confirm.
3. **No charts.** §1: "Charts of message counts are decoration; build them last if at
   all." The weekly series is a small table, because with seven accounts and two weeks a
   line chart is decoration around four numbers. It becomes a chart, following the
   `dataviz` guidance, when there is a trend worth seeing.
4. **Export (xlsx, monday board) is not built.** §7 says build it after screen 3 proves
   useful, and screen 3 in its org-wide theme-grouped form is 8C.
5. **The insights app has no `id` in `fusebase.json`.** The deploy printed
   `✓ Saved app id iodrlh6iihrcfuw7` but the value is not in the file, so
   `fusebase app update` needs the id passed explicitly. Not hand-written, since the
   platform owns app ids — worth a CLI look.
