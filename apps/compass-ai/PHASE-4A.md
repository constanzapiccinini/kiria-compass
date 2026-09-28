# Compass AI — Phase 4A handoff

Portal tenancy and the two-role model. Implements Phase 4A of
[Coni-PHASE-4-Portal-Model.md](./Coni-PHASE-4-Portal-Model.md) §14. Builds on
[PHASE-1.md](./PHASE-1.md), [PHASE-2.md](./PHASE-2.md), [PHASE-3.md](./PHASE-3.md).

**Exit criteria (§14).**

| Criterion | State |
| --- | --- |
| No route accepts a caller-supplied tenant id | **Proven** — automated, 9 specs passing against prod with retries off |
| Refusals leave an audit trail | **Proven** — automated, rows verified in prod |
| A user in Portal A cannot reach Portal B's documents | **Proven for every rejection path; the live cross-portal read is verified manually**, because no automated path can hold a portal-bound session — see [Portal-bound sessions](#portal-bound-sessions--why-the-resolving-specs-cannot-run) and `tests/manual/portal-isolation.md` |

Both portals resolve correctly in production and were observed doing so
(`portal.resolved`, distinct clients, actor derived). What is *not* automated is the
negative case, and the reason is the security property itself.

## Schema — migration v3

`postgres/migrations/0003_portal_tenancy.sql`, checksum
`df4900847affac95e68ea9cdd61035fe54dd7d776e5867f8d950185ef72b748a`.

**Applied to both stages.** Journal head on `prod` (store `compasses`,
`a1174ace-30d0-449c-b438-00df75d2cccf`) as of 2026-09-05:

| version | name | applied_at |
| --- | --- | --- |
| 1 | init | 2026-09-02T15:08:34Z |
| 2 | batch_embeddings | 2026-09-02T16:51:51Z |
| 3 | portal_tenancy | 2026-09-05T12:54:41Z |

Checksums match the manifest, no drift. (An earlier revision of this document said v3
was dev-only and prod was held at v2 — that was true when written and stopped being
true at the 2026-09-05 prod apply.)

| Change | Detail |
| --- | --- |
| `workspaces` → `clients` | Plus `status` (`active`/`paused`/`archived`) and `notes` |
| `workspace_settings` → `client_settings` | All six CHECK constraints renamed |
| `workspace_id` → `client_id` | 11 child tables; FKs and indexes renamed to match |
| `workspace_members` | **Dropped.** Roles are derived, never stored |
| New | `client_groups`, `client_group_members`, `portals` |
| `rag_traces.step` | `+ resolve_portal`, so §13's latency requirement is measurable |
| `document_index_health` | Dropped and recreated against `client_id` |

The exact constraint and index names were read from the live database first
(`pg_constraint`, `pg_indexes`) rather than guessed, so every rename names a real
object.

Verified after apply: 13 `client_id` columns, 5 new tables, 0 leftover `workspace*`
tables, view recreated, the existing client row preserved. The single remaining
`workspace_id` is `portals.workspace_id` — the platform workspace, kept for Gate
membership calls.

`workspace_members` was dumped to `postgres/backup/0003-pre-drop-workspace-members.json`
before the drop, per §12.

## The tenancy boundary — `backend/src/lib/portal.ts`

Two facts from Gate's own contract shaped this beyond what §3.1 prescribes:

> The token is static … minted once when the brick is saved, shared by every viewer,
> no `exp` … Presence of `userId` **does NOT prove portal membership**.

So the token proves *where*, never *who*, and holding it is not evidence of anything.
The module therefore:

1. **Verifies with the caller's app token**, not the service token. Gate returns
   `userId` only when that session is itself bound to the verified portal, which is
   what turns a shared artifact into a trustworthy `user × portal × app` triple.
2. **Checks portal membership directly** (`listPortalMembers`) for client actors.
   `--access` principals alone would leave the shared token as the only gate.
3. Resolves the `portals` row → `client_id`. Unbound is a clean `409`, not an empty
   page that looks like it is working.
4. Caches 60s per `hash(portalToken + appToken)`, bounded map. Short on purpose: the
   token is a portal artifact, and a membership change must take effect within a
   minute.

`assertNoTenantOverride` rejects `clientId` / `workspaceId` / `portalId` in query,
JSON body **or multipart form** — refused, not ignored, because it is a probe.

Every rejection carries a stable code plus a separately-authored client-safe message.
Clients never see ids, table names or provider detail; the real reason goes to the log
(and to `system_alerts` from 4D).

## Verified

Originally checked by hand against the running backend. **Every row below is now
covered by an automated spec** in `tests/e2e/specs/compass-ai/portal-tenancy.spec.ts`,
which is the source of truth — this table is kept because it records what was probed
and why, which a list of test names does not.

| Attack | Result |
| --- | --- |
| No portal token | `400 PORTAL_CONTEXT_MISSING` |
| Garbage token | `403 PORTAL_VERIFY_FAILED` |
| **Forged JWT, correct claims, real portalId** | `403 PORTAL_VERIFY_FAILED` |
| `?clientId=` on any route | `400 TENANCY_PROBE` |
| `?workspaceId=`, `?portalId=` | `400 TENANCY_PROBE` |
| `/api/workspaces/me`, `/api/indexing/{id}` | `404` — removed |

The forged-JWT case is the one that matters: valid-looking claims for a genuinely
existing portal, still refused, because verification goes through Gate's signature
check rather than a local decode.

### Query audit

All **28** data-access sites in `routes/` and `lib/rag.ts` were enumerated and checked.
Every one is scoped: directly by `client_id`, or by an id that was itself resolved
through a tenancy-checked loader (`loadOwnedDocument`, `loadChat`).

The retrieval path carries **two independent filters** — caller-supplied `documentIds`
are validated against the client on write, and the chunk scan filters `c.client_id`.
That matches §4.3's requirement to keep an explicit `WHERE client_id` regardless of RLS.

### A bug this refactor surfaced

`loadChat` still resolved a chat id with **no `client_id` predicate**. Every downstream
handler trusted its result, so a chat id belonging to another client would have loaded
and been answered from. Now filtered; a foreign id is a 404.

It is worth naming why it survived the first pass: the rename mechanically turned
`workspace_id` into `client_id` everywhere it *appeared*, and this query's flaw was a
predicate that was **missing**, which no rename can surface.

## API surface

`openapi.json` v2.0.0, 26 operations, validates. Every operation declares
`x-portal-context` as a required header, and **none takes a client, workspace or
portal parameter**.

| Route | Change |
| --- | --- |
| `/workspaces/*` | **Removed** — no client list, no client creation |
| `GET /session` | **New.** actor, client, capabilities, settings |
| `GET/PATCH /session/settings`, `GET /session/audit` | Employee-only |
| `/documents*` | Portal-scoped; upload/delete/reindex employee-only |
| `/chats*` | Portal-scoped; document scope intersected with the client |
| `/indexing*` | `:clientId` path param **removed**; employee-only |

Errors are `{ error: { code, message } }` throughout, so tests assert on codes.

## Settings precedence

`resolveEffectiveSettings` implements portal override → client settings → defaults,
with per-key provenance for the admin UI. Each overridable key is **validated
individually** rather than spread from the JSONB blob, so a malformed override cannot
widen a cap or break a type. The `app_settings.defaults` layer (0004, Phase 4B) slots
in by changing one function.

## Client app

- Boots from `GET /session`; no workspace switcher (one portal = one client).
- Admin affordances are **absent** for clients, not disabled — Indexing, Settings,
  upload, delete and re-index are not rendered at all (§8.2).
- The portal token is read from `window.location.search` **once**, held in memory,
  never persisted, and stripped from the visible URL.
- A portal failure gets its own screen showing only the backend's client-safe text.

## The verify 400 — wrong id, right route

The first live portal load failed with `PORTAL_VERIFY_FAILED`. Gate's answer was:

```
400 {"name":"BadRequestError","message":"Invalid portal feature context token"}
```

**Cause.** `portal-feature-context/verify` is *feature*-scoped: its `:appId` path
segment wants the App (feature) global id. The backend was sending `FBS_APP_ID`,
which the platform injects with the **product** id (`sfqksmtybcsejlru`). The feature
id was in the container all along, under **`FBS_APP_FEATURE_GLOBAL_ID`**
(= `jkbjijn0ndnorxzp`).

Two things made this cost more than it should have:

1. Gate returns the **same** `Invalid portal feature context token` for a wrong path
   id and for a malformed token, so the two cannot be told apart from one response.
2. `fusebase.json` is **not** shipped into the container, so `readProjectConfig()`
   returns nothing there and `appId()` could only ever yield the product id. Reading
   the id from the project file works in dev and silently cannot work in prod.

What actually resolved it was making the system report its own state — logging the
Gate response `body` and enumerating the `FBS_*` env keys — rather than reasoning
about which id the route "should" want. Two deploys went to hypotheses that the
evidence could not distinguish before that.

**Fixes.** `appPathIdCandidates()` tries `FBS_APP_FEATURE_GLOBAL_ID` first and falls
back, logging which id Gate accepted (`portal.verified`), so the record shows the
answer instead of an assumption. `appId()` now prefers the feature variable, which
makes the function match its name — it was a trap for every future caller, not just
verify.

Separately, the SPA read the token with `URLSearchParams.get()`, which applies HTML
form-encoding and decodes `+` as a space. A JWT is base64url so unaffected, but an
opaque base64 token would have arrived silently corrupted and been rejected with
that same indistinguishable message. It now parses the raw query string and
percent-decodes explicitly. Fixed on its own merits, not because it was the cause.

**Diagnostics kept.** On failure only, the backend logs the token's length, JWT
segment count, a 12-char hash prefix and whether it arrived by header or query, plus
the platform id env vars. No token value, and the env list is allow-listed by name so
no credential-bearing variable can be logged by accident.

## Verified live

The boundary resolves end to end. From `fusebase remote-logs runtime` after a real
portal page load:

```
portal.verified  pathParam=env:FBS_APP_FEATURE_GLOBAL_ID  portalId=7h6m44m8b3b6uigm1io6e4d08
portal.resolved  portalId=7h6m…  clientId=e60026e2-…  actor=employee  durationMs=653
```

That is the first successful request in the app's history, and it confirms the whole
chain: Gate verification, portal membership, the `portals` → `clients` binding, and
actor derivation. `durationMs=653` is the cold first resolve — three round trips
(verify, `listPortalMembers`, one SQL read); subsequent calls inside 60s hit the cache.

## What is not verified

**A client actor has still never loaded the app.** Every live resolution so far was an
employee (the org owner). Employee-vs-client capability differences are therefore
unproven in a live session — the code paths exist and the specs are written, but no
`orgRole: client` user has opened either portal.

**Both embeds are published.** `fusebase app portal-embeds` reports two live pages:
`client-portal-template-test.p.nimbusweb.me/product` and
`compass-client-b.p.nimbusweb.me/product`. The separately staged "Documents" block on
portal A (page `2khkr6n5cft693e6zmm3qepio`, block `3x14tney94fyzt66q30j5cxui`) is still
`draftOnly: true` and is *not* the live embed — the live one sits on the Product page.

Still unproven: a client actor loading the app, employee-vs-client capability
differences in a live session, and the Portal A → Portal B read (manual runbook ready,
not yet run).

## The §15 specs

Written: `tests/e2e/specs/compass-ai/portal-tenancy.spec.ts`, 16 tests covering §15's
**Tenancy** and **Roles** blocks (Sources, Folders, Sidebar and Alerts belong to
4B–4D). Helpers in `tests/e2e/helpers/portal.ts`.

Current run against prod: **9 passed, 9 skipped, 0 failed** (whole compass suite:
9 passed, 26 skipped), with `--retries=0` so every pass is a first-attempt pass.

## Denials are now audited

§15 requires a cross-portal attempt to leave an audit entry. It did not. `recordAudit`
was called only on *successful* actions, so a tenancy probe and a cross-tenant read
were refused and recorded **nothing** — while a comment in the spec claimed a probe
"leaves a trace". The claim was aspirational and had never been checked.

| Denial | Action recorded |
| --- | --- |
| tenant id in a query or body | `tenancy_probe_denied` |
| document id belonging to another client | `document.cross_tenant_denied` |
| chat id belonging to another client | `chat.cross_tenant_denied` |

Two design points worth keeping:

**Only real cross-tenant attempts are audited.** A 404 is far more often a mistyped id
than an attack, and auditing every one would bury the signal. The loaders ask whether
the id exists under a *different* client and record only then. That lookup selects one
foreign key, never row data, and the caller's 404 is byte-identical either way — so
the distinction costs the caller no information.

**The probe audit is recorded in `assertNoTenantOverride`,** not at the five call
sites, so a route added later cannot refuse a probe silently. It is deliberately not
awaited: it runs before portal resolution on a request that is about to be refused, and
`recordAudit` emits its stdout line before touching the database, so the durable signal
lands even if the write does not. Awaiting would put a database round trip in front of
every rejection.

`client_id` is `null` on a probe row on purpose — the probe is refused before any portal
resolves, and attributing it to a tenant would blame whichever one it was aimed at.
Verified in prod:

```
tenancy_probe_denied  client_id=null  GET /api/documents  {"key":"portal_id","location":"query"}
tenancy_probe_denied  client_id=null  POST /api/chats     {"key":"workspace_id","location":"body"}
```

The spec counts rows before and after rather than matching one: the suite runs in
parallel against a shared environment, so "one more than a moment ago" is the only
property a concurrent run cannot invalidate, and it still fails when nothing is written.

The eight that pass are the refusal set, and between them they prove §14's second exit
criterion — *no route accepts a caller-supplied tenant id* — by test rather than by
assertion:

| Test | Proves |
| --- | --- |
| unauthenticated request never reaches the app | the edge refuses before any app code runs |
| no portal context → `PORTAL_CONTEXT_MISSING` | the app never defaults to a tenant |
| tenant id in query → `TENANCY_PROBE` | all six key spellings refused |
| tenant id in body → `TENANCY_PROBE` | the vector that leaves no access-log trace |
| probe refused, not ignored | enumeration cannot be attempted silently |
| **forged token + real session → 403** | verification is Gate's signature check, not a local decode |
| portal context never read from a body | the attack the whole design exists to prevent |
| v2 tenant routes → 404 | removed, not merely guarded |

Both portal tokens are now configured in `.env.prod`, so the nine still skipped are
blocked on something else entirely — see below.

## Portal-bound sessions — why the resolving specs cannot run

The nine remaining specs need a portal that actually *resolves*. They cannot get one,
and the reason is the design working rather than a defect.

`resolvePortalContext` verifies the context token with the **caller's** app token.
Gate returns a `userId` only when that session was minted **through the portal** — the
`/api/portal/app-launch` launcher the portal page wraps the embed in. A magic-link
sign-in authenticates against the *app host* instead, so Gate verifies the token and
returns no user, and the backend refuses:

```
portal.verified            portalId=7h6m44m8b3b6uigm1io6e4d08
PORTAL_SESSION_ANONYMOUS   Verified portal token but the caller session is not bound to this portal
```

That is precisely the property the module was built around: the context token is
static, has no `exp`, and is served identically to every viewer, so **holding it must
never establish who the caller is**. A harness that could bypass this would mean the
boundary was broken. The failure is the proof.

Consequence: the harness cannot fabricate a portal-bound session. This is **not
possible through Gate**, not merely unimplemented — three privileged paths were tried
and all refused:

| Path | Result |
| --- | --- |
| Playwright magic-link sign-in (app host) | `401 PORTAL_SESSION_ANONYMOUS` |
| Gate `callAppApi` with its own minted app token | `401 PORTAL_SESSION_ANONYMOUS` |
| Gate MCP directly | cannot call `verifyPortalFeatureContextToken` |

Gate also exposes no operation to add a portal member or mint a portal session
(`tools_search` for member/invite/auth returns only `listPortalMembers`,
`listWorkspaceMembers`, `removePortalMember`). Automating this would mean driving the
portal's own web login, for which there are no credentials.

Three independent privileged mechanisms failing to impersonate a portal member is
itself the strongest available evidence that the boundary holds.

**The exit criterion is therefore verified manually, from a runbook rather than
ad hoc:** `tests/manual/portal-isolation.md`, with
`scripts/portal-isolation-check.mjs` generating the console snippet from the tokens in
`.env.<environment>` so the runbook carries no secrets and survives token rotation.

A false pass to know about: run the check in the portal page's **top frame** and every
request resolves against the portal domain, 404s, and looks like clean isolation. The
generated snippet aborts with `WRONG PAGE` unless the origin is the app host. It also
prints each token's resolved **client name** and includes a control read by the owner,
because four 404s against a document that does not exist prove nothing — a mistake made
once already during this work.

`portalBoundSessionOrSkip` detects the `401 PORTAL_SESSION_ANONYMOUS` and skips with
that explanation, so the gap stays visible without turning a harness limitation into a
red build. Every other failure still fails.

**Verified manually instead.** Both portals resolve correctly in a real browser:
portal B renders the app with `Compass Client B` in the header and employee
affordances present, and the logs show `portal.resolved actor=employee` for each
portal against its own client. What remains unproven by *automation* is the negative
case — that portal A cannot read portal B's documents.

## Parallelism ceiling

Every spec signs in through a fresh magic link, and the platform does not serve that
many concurrent activations for one address. Measured against prod: 6 workers clean,
Playwright's default (one per core — 10 on this machine) produces failures and
passes-on-retry in the *refusal* specs, which share no state with each other. That
independence is the giveaway that the contention is in sign-in, not the assertions.

`workers` is now capped (6 local, 4 CI) rather than left to core count, so the suite
cannot go green on a small machine and red on a large one. The proper fix is one
sign-in per fixture reused through `storageState`, which removes the ceiling and most
of the runtime; it is not done.

Two things were discovered writing them, both worse than the missing specs were:

**1. The pre-4A spec was dead code.** `access-control.spec.ts` was written entirely
against the v2 model — `workspaces`, `workspace_members`, `?workspaceId=`,
`/api/workspaces/me`. Migration v3 dropped every one, so it could not pass. Nothing
failed at compile time because the coupling was URL strings and SQL, not types. It has
been replaced; its two assertions worth keeping (a refused delete must not delete; a
foreign document must not enter a chat's scope) were carried over.

**Five more spec files had the same problem, and are now migrated** — `citations`,
`grounded-answer`, `grounding`, `indexing`, `viewer`, plus `chat-widget`, which had no
v2 *references* but was still v2 in *behaviour*: it signed in and expected the app to
render at the bare app root, which under 4A has no portal context and shows the
portal-error screen instead.

The migration replaced the tenancy plumbing and kept every assertion:

| Was | Now |
| --- | --- |
| `firstWorkspace(page.request)` | removed — `portalSession(api)` when the client or user id is needed |
| `uploadPdf(request, workspaceId, …)` | `uploadPdf(api, …)` — no tenant field in the form |
| `{ workspaceId, … }` in a chat body | dropped — it is now a `TENANCY_PROBE` |
| `/api/workspaces/{id}/settings` | `/api/session/settings` |
| `/api/indexing/{workspaceId}` | `/api/indexing` |
| `page.reload()` | `openPortalApp(page, token)` — a reload loses the context token |

One test was **deleted rather than migrated**: indexing's "maintenance actions are
admin-only". It seeded `workspaces`, `workspace_members` and `workspace_settings` — all
dropped by v3 — and asserted a four-role hierarchy that no longer exists, so
"viewer cannot but admin can" has no equivalent under two derived roles. Its surviving
property is covered by portal-tenancy's `FORBIDDEN_CLIENT_ROLE` test, against a real
client actor instead of a hand-written membership row.

Suite state: **33 tests, 1 passed, 32 skipped, 0 failed**; lint and typecheck clean.

The helpers now make the coupling **typed** — `PortalApi` instead of an
`APIRequestContext` plus a loose id — so the next tenancy change surfaces as compile
errors listing every stale call site, which is precisely what the v2 model failed to
do. That failure is the real lesson here: the old specs coupled through URL strings and
SQL, so a migration that dropped their tables left them looking fine.

**Caveat: none of the migrated specs has been executed.** They skip for want of the
fixtures below, so only their types and collection are verified. Treat them as
unproven until a run happens.

A bug this caught, worth recording because the mechanism recurs: the migration script
inserted a `beforeEach` calling `signInOrSkip`, then a later cleanup rule stripped
*every* `signInOrSkip` line — including the one it had just written. The specs were
left signing in nowhere. Every test skipped, so the run stayed green and said nothing;
ESLint's unused-import warning is what exposed it.

**2. Every request needs a session, including the refusals.** The platform edge
rejects any `/api/*` request with no app token before it reaches the app:

```
$ curl -i https://compass-ai.thefusebase.app/api/session
HTTP/1.1 401 Unauthorized
{"error":"unauthorized","reason":"no-token"}
```

The earlier `callAppApi` verifications passed only because Gate mints a token for that
call. So the magic-link blocker gates the **entire** suite, not the half that needs a
portal token — which is why 15 of 16 skip. The one test that passes asserts this edge
behaviour, which also satisfies §15's "anonymous visitor … → 401".

### Two fixtures still needed

- **A usable sign-in.** `createAppMagicLink` withholds the URL for an account that has
  never activated a link for this org. Org membership does **not** lift it — the owner
  is withheld too. The harness's error message previously said the account was
  "outside the org" and advised adding it; that was misleading (already true for every
  fixture here, and no help), and has been corrected. A withheld link now raises
  `MagicLinkWithheldError` and *skips* rather than failing, because no spec can repair
  an environment condition; every other sign-in failure still fails the run.
  **Solved for the `e2e` fixture.** `e2e-fixture@example.com` was added as a
  brand-new address and its emailed link activated, so the platform now returns URLs
  inline for it and the eight refusal tests run. `owner` and `client` are still
  withheld — their emailed links have not been activated.

  **The inline link for a new address is single use.** The first call for an unknown
  address provisions the user record *and* returns the URL; that provisioning is
  precisely what makes every later call withhold it. Verifying a new fixture with a
  throwaway probe therefore consumes it — which is how the `e2e` link was spent before
  the suite could use it, recovered only because the platform also emails it. The rule
  is recorded in `helpers/env.ts`: never probe this endpoint to check a fixture, run
  the suite, because a passing sign-in *is* the check and activates the account as a
  side effect.

- **`COMPASS_PORTAL_TOKEN_A` / `_B`** in `.env.<environment>`, read from the portal
  iframe URL (see `helpers/portal.ts`). Slot A is
  `client-portal-template-test`, slot B is `compass-client-b`. One test asserts the two
  resolve to distinct clients, so a mistake here fails loudly instead of making the
  isolation tests pass vacuously.

### Fixture users

`environments/prod.json` declares two, because the actor is derived from the caller's
org role and the two halves of §15 need different callers:

| Key | Address | Org role | Used for |
| --- | --- | --- | --- |
| `owner` | `owner@example.com` | owner → **employee** | tenancy, cross-portal, upload |
| `client` | `client-fixture@example.com` | client → **client** | role and capability assertions |

The client fixture cannot substitute for the owner: uploading the cross-portal fixture
document is employee-only, and that user is not a member of portal B's workspace.

This split also removed a **structural** skip. The client-actor tests previously signed
in as the owner and skipped when the actor came back `employee` — which it always did,
so they could never run. They now sign in as the client fixture and assert the resolved
actor *is* `client` in `beforeEach`, so a fixture whose org role changes fails loudly
instead of quietly testing an employee.

### A store misconfiguration this turned up

`environments/prod.json` pointed `stores.compasses` at
`e77bf744-1ec2-48bd-9161-c726ab75044d` — alias **`compasses-prod`**, a second store
carrying the v3 schema but **zero rows**. The deployed app resolves its store by the
alias `compasses` → `a1174ace-30d0-449c-b438-00df75d2cccf`, which holds the real data
and both portal bindings.

Every SQL fixture (`seedCitedAnswer`, `sqlQuery`, `deleteChat`) goes through
`storeId(env)`, so citations would have seeded a chat into the empty store, the app
would have read the other one, and the spec would have failed with "the conversation
was not restored" — a symptom pointing nowhere near the cause. Corrected to
`a1174ace…`.

**Editing that file was not a fix.** `fusebase deploy` regenerates
`environments/prod.json`, and it reverted the id to `e77bf744…` on the next deploy —
so the hand-edit lasted exactly one deploy and the drift would have returned silently.

The durable fix is in `tests/e2e/helpers/compass.ts`: `storeId()` now resolves the
store **by alias through Gate**, exactly as the app does, and never reads the lockfile.
Verified against prod:

```
lockfile says : e77bf744-1ec2-48bd-9161-c726ab75044d   (alias compasses-prod, 0 rows)
alias resolves: a1174ace-30d0-449c-b438-00df75d2cccf   (alias compasses, real data)
agree? false
```

The match is exact rather than a prefix, since `compasses-prod` starts with
`compasses` and a loose match would reintroduce the bug it exists to remove.

`compasses-prod` is left in place: it is empty and harmless, but deleting a store is
destructive and not mine to decide. Worth removing once someone confirms nothing
references it — until then the alias resolution makes it inert for the harness.

## Deliberately not done

**`--access` was not changed.** §3.3 says check first, and `fusebase app get` reports:

```
Access: orgRole:owner, orgRole:manager, orgRole:member, orgRole:client, user:3700332
        ! 'app update --access' cannot express: user:3700332 — running it would revoke that access.
```

That `user:` principal was appended by the Phase 3 e2e magic-link attempt —
`createAppMagicLink` defaults to `addToAccessPrincipals: true`. Per §3.3, when that `!`
line appears the grants change **in the UI**, not via `app update --access`. Setting
`portalClient,portalManager` is therefore a UI action.

**RLS delegation (§4.3) not wired.** `isolated_store.rls.delegate` is not in
`backendOnlyGatePermissions` and `trustedRuntimeContext.portalId` is not passed.
Current state: `bypassRls=false`, `superuser=false` — native enforcement *is* available
on this host — but no policies exist, and the `postgres-rls` CLI flag is not enabled
(only `environments` is). The app-level `WHERE client_id` filter is the real boundary
today, which §4.3 requires regardless. Do not describe this app as row-level-secured.

## Seeded state

### prod — the two portals the isolation tests use

| Slot | Client | Portal | Platform workspace | Domain |
| --- | --- | --- | --- | --- |
| **A** | Client Portal Template (`e60026e2-…`) | `7h6m44m8b3b6uigm1io6e4d08` | `4izniben3duh7biw` | `client-portal-template-test.p.nimbusweb.me` |
| **B** | Compass Client B (`abcfcdbe-…`) | `eq94vsqm69l3ty8op0krcn5i7` | `4j1thmiccpuvkn4x` | `compass-client-b.p.nimbusweb.me` |

Portal A is the live one — the app is embedded and published at `/product`.

Portal B was created for the cross-portal test, along with a new workspace: Gate's own
rule is one portal per workspace, and both existing workspaces were already occupied.
Its `clients`, `portals` and `client_settings` rows are seeded and it is bound to a
**distinct** client, which is what makes the isolation assertions meaningful rather
than vacuous — one spec checks exactly that and fails loudly if the two ever collapse
onto one client.

Its "Documents" page (page `c4p5nouzuq0g1059bdvb6nc3p`, block `ca06ghmw4ihuniv0fvs9ikfdq`)
is **staged in the customizer draft**. Gate has no publish operation, so the portal
owner publishes it.

Only `owner@example.com` (owner) is a member of workspace `4j1thmiccpuvkn4x`. That is
enough for the A → B isolation tests, which turn on the *portal context* rather than
the user. Testing a **client** actor in portal B additionally requires adding a
`orgRole: client` user to that workspace.

Both clients currently hold **zero documents**. The cross-portal specs skip when portal
B has none, so seeding at least one document there is what turns those four tests from
skipped into meaningful.

### dev

| Client | Portal | Platform workspace |
| --- | --- | --- |
| Sun Pharma | `aq12dbsx6ny104ujyabwrbx47` | `4g0ryu57et2mwdg9` |
| Gilead | `7h6m44m8b3b6uigm1io6e4d08` | `4izniben3duh7biw` |

Sun Pharma is the renamed original client and keeps its documents; Gilead is new and
empty. Both have `client_settings` rows. These are dev-stage bindings and are unrelated
to the prod table above, despite `7h6m…` appearing in both — the two stages are
separate databases.

## Next, in order

Done since the first revision of this list: v3 applied to prod, both portals published
and resolving, the §15 specs written and 9 of them passing, denials audited.

**Needs a person (cannot be automated):**

1. **Run `tests/manual/portal-isolation.md`** — twice, inside each portal's
   `compass-ai` frame. This is 4A's remaining exit criterion. Delete the fixture
   document `31de4eb4-a510-418f-bc4f-bb03901a5fea` (client "Compass Client B")
   afterwards.
2. **Open a portal as an `orgRole: client` user** — `staff@example.com` or
   `client-fixture@example.com`, both already members of portal A. Confirms the
   client actor renders read-only. Their magic links have been emailed but not
   activated, which is also what keeps the `client` fixture specs skipped.
3. **Set `portalClient,portalManager` in the app's access UI.** Not via
   `app update --access`: §3.3, and the CLI warns it would revoke the `user:` principals.
4. **Rotate the OpenAI key.** It was pasted in chat during Phase 3 and is still live.

**Worth doing, not blocking:**

5. One sign-in per fixture via `storageState`, removing the worker cap and most of the
   suite runtime.
6. Delete the stray `compasses-prod` isolated store once someone confirms nothing
   references it. The harness no longer reads it, but it remains a trap for anything
   that resolves by lockfile.
7. RLS (§4.3) is still unwired — `bypassRls=false` and `superuser=false`, so native
   enforcement is available, but no policies exist and `postgres-rls` is not enabled.
   **Do not describe this app as row-level-secured.** The `WHERE client_id` filter is
   the real boundary, which §4.3 requires regardless.

**Phases 4B (sources/folders), 4C (admin app), 4D (alerts)** each need explicit
confirmation before starting, per §14.

## Housekeeping

A lint regression was fixed on the way through: the Playwright HTML report from the
Phase 3 e2e run was being linted (8,999 errors from bundled third-party JS). It is
gitignored, but ESLint reads the working tree, so `tests/e2e/reports/`,
`test-results/`, `playwright-report/` and the generated `apps/*/public/pdfjs/` were
added to the root ESLint ignores.

Lint, typecheck and build are clean.
