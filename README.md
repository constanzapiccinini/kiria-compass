# Compass

Three FuseBase apps built for **KIRIA Advisory Partners**, a pharmaceutical research
and advisory firm. Clients read KIRIA's material inside a FuseBase portal and ask
questions about it; the answers are grounded in that material and cite the paragraph
they came from.

| app | audience | what it is |
| --- | --- | --- |
| **`compass-ai`** | clients, inside a portal | the product — document viewer, and a chat whose citations jump to the cited paragraph and highlight it |
| **`compass-admin`** | KIRIA staff | operations — portals, libraries, indexing, alerts, usage, audit log |
| **`compass-insights`** | KIRIA staff | analytics — answer gaps, which material gets read, recurring themes, and a compliance review queue |

All three share **one isolated PostgreSQL store**. They share no code: the platform
gives each app its own backend, so the handful of helpers they have in common are
copied verbatim and held byte-identical by a drift test.

---

## Architecture, in the three facts that explain the rest

**Tenancy is a portal, not a login.** A client reaches `compass-ai` only through a
portal embed, and the portal's context token is what resolves which client they are.
There is no client picker and no stored role — one portal is one client. Row-level
security enforces it in the database rather than in the handlers.

**The two staff apps are kept out of the client's data path, and vice versa.** Both
client and staff requests carry the same `app.org_id`, so org scope alone would not
separate them. The barrier that works is `app.req_client_id`: a client-facing request
carries its resolved client, a staff or background request carries nothing. The
staff-only tables refuse any request that carries a client scope at all.

**Analysis runs in the client app's worker, never in the analytics app.**
`compass-insights` contains no pipeline code — it reads, and it manages queues. That
is enforced by a test, because the alternative is two embedding paths and two cost
meters.

---

## Layout

```
apps/compass-ai/          client portal app  (SPA + Hono backend + ingest worker)
apps/compass-admin/       staff operations app
apps/compass-insights/    staff analytics app
postgres/migrations/      26 SQL migrations + the RLS manifest
scripts/                  operator scripts, run by hand against a named stage
tests/e2e/                Playwright suites, per app and per environment
tests/manual/             what automation cannot reach, and why
fusebase.json             app registry: ids, build commands, Gate permissions
```

Each app is a Vite SPA plus a `backend/` Hono service. `compass-ai`'s backend also
runs the ingest worker — parse, OCR, embed — and the nightly analysis jobs.

---

## Running it

```bash
npm install
npm run lint         # eslint, zero warnings tolerated
npm run typecheck    # tsc for every app, SPA and backend

fusebase dev start apps/compass-ai
```

`fusebase dev start` rather than `npm run dev`: the CLI injects the app token and the
platform context that the app cannot start without.

Per-app checks:

```bash
cd apps/compass-ai/backend  && npm test   # static invariants + brand/contrast guards
cd apps/compass-insights/backend && npm test   # drift: the copied helpers are identical
cd tests/e2e && npm test -- --project=compass-admin
```

---

## Tests, and an honest note about coverage

The unit suites are **static invariant guards** rather than conventional unit tests.
Each one exists because the thing it checks shipped broken once — a tenancy predicate
that hid every library document from staff, a hook below a conditional return that
blanked the client app, a template placeholder gap that 500'd a screen for a day. They
are cheap and they are specific.

**The client app's e2e suite skips twenty-four specs, and that is not neglect.** Gate
returns a portal-bound session only when the session was minted through the portal
launcher; a magic-link sign-in never is. That is the tenancy property working, not a
gap to route around. The consequence is that the app with the most user-facing surface
has the least automated coverage, so two things fill it:

- `tests/manual/` — runbooks for what a human must walk
- `scripts/probe-client-render.mjs` — renders the built SPA against a stubbed session
  and checks the tree mounts and PDF links are present, clickable and safely targeted

---

## What is deliberately not in this repository

This is a public repository for code review. Excluded, and kept only locally:

| excluded | why |
| --- | --- |
| `.env`, `.env.*`, `.mcp.json`, `.cursor/`, `.vscode/mcp.json`, `.codex/` | live Gate and Dashboards tokens, and the portal context tokens the tenancy specs use |
| `environments/` | e2e environment lockfiles carrying real test-user email addresses |
| `postgres/backup/` | a pre-migration row dump of `workspace_members`, with emails and platform user ids |
| `artifacts/` | production screenshots showing client names and document titles |

`fusebase.json` **is** published and lists a `secrets` block. Those are key *names and
descriptions* only — `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY` and so on. Values are
held by the platform and never appear in the repository.

Test-fixture email addresses in the phase documents were replaced with `example.com`
placeholders.

---

## The phase documents

`apps/*/PHASE-*.md` are the working record: what each phase was asked to do, what was
built, what broke, and what was decided against. They are written to be read by
whoever picks this up next, including the mistakes — a rebrand whose ramps came back
grey because they were mixed in linear light, an alert that fired on every test run
until somebody noticed it had stopped meaning anything.

Two internal assessments referenced by those documents are not published, because they
analyse what KIRIA's client agreements permit rather than how the software works.
