# Manual check — portal-to-portal isolation

Phase 4A's exit criterion: **a user in Portal A cannot reach Portal B's documents by
any path.** This is the one assertion in the suite that cannot be automated, and this
runbook is how it gets verified after a deploy that touches tenancy.

Everything else in §15 *is* automated — see
`tests/e2e/specs/compass-ai/portal-tenancy.spec.ts`.

## Why this is manual

The app resolves a tenant only when the caller's session was minted **through the
portal** — the `/api/portal/app-launch` launcher the portal page wraps the embed in.
Gate returns a `userId` from `verifyPortalFeatureContextToken` for that session and no
other, so anything else gets a verified token, no user, and `PORTAL_SESSION_ANONYMOUS`.

Three privileged automation paths were tried and all refused:

| Path | Result |
| --- | --- |
| Playwright magic-link sign-in (app host) | `401 PORTAL_SESSION_ANONYMOUS` |
| Gate `callAppApi` with its own minted app token | `401 PORTAL_SESSION_ANONYMOUS` |
| Gate MCP directly | cannot call `verifyPortalFeatureContextToken` |

And Gate exposes no operation to add a portal member or mint a portal session, so the
harness cannot construct one either.

**That is the security property, not an obstacle to it.** The context token is static,
has no `exp`, and is served identically to every viewer of the page; if any of those
paths *had* produced a resolved tenant, the boundary would be broken. The check stays
manual because the design is correct.

## Prerequisites

1. **A document that exists only in portal B.** Upload one through portal B's app, or
   seed a metadata-only row against portal B's client. Note its id.

   This is the part that is easy to get wrong: without it, portal A returns 404 because
   the document *does not exist*, which is indistinguishable from 404 because it is
   *correctly hidden*. The control step below is what separates them — do not skip it.

2. **Both portal tokens in `.env.<environment>`** as `COMPASS_PORTAL_TOKEN_A` and
   `COMPASS_PORTAL_TOKEN_B`. To read one: open the portal page and run

   ```js
   [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src'))
   ```

   then take `portalFeatureContextToken` out of the launcher URL. Note that the app
   strips the token from its own address after capture, so "Copy frame address" gives a
   token-less URL — read the `src` **attribute**, not the live location.

## Steps

1. Generate the snippet:

   ```bash
   node scripts/portal-isolation-check.mjs <documentIdOnlyInPortalB>
   ```

2. Run it **twice — once in each portal page**, inside that page's `compass-ai`
   iframe. In DevTools, switch the console context dropdown from `top` to the
   **compass-ai** frame before pasting.

   | Where | Which half it proves |
   | --- | --- |
   | portal **B**'s page | the **control**: the owner can read the document |
   | portal **A**'s page | the **isolation**: portal A cannot |

   The snippet detects which portal the frame is bound to and labels its own output,
   so the two runs cannot be confused.

### Two things that look like shortcuts and are not

**Opening `https://compass-ai.thefusebase.app/` directly does not work.** The tab has a
session, and the app answers — but it never passed through the portal launcher, so it
is bound to no portal and every call returns
`401 PORTAL_SESSION_ANONYMOUS`. Measured, not assumed:

```
origin: https://compass-ai.thefusebase.app
session via A  -> 401 PORTAL_SESSION_ANONYMOUS
session via B  -> 401 PORTAL_SESSION_ANONYMOUS
```

**One session cannot cover both halves.** A session is bound to exactly one portal, so
the control and the isolation check *must* come from different frames. Asking one
session to resolve both portals is asking the boundary to fail.

**Never run it in the portal page's `top` frame.** There `/api/...` resolves against
the portal domain, every path 404s, and it reads as a clean pass. The snippet aborts
with `WRONG FRAME`, but understanding the trap matters more than the guard.

## Expected result

Run in **portal B** (control):

```
frame is bound to portal B: Compass Client B
doc with THIS portal token  -> 200
doc with OTHER portal token -> 401 PORTAL_SESSION_ANONYMOUS
CONTROL run: expect 200 (owner can read) then 401 (other portal token refused)
```

Run in **portal A** (isolation):

```
frame is bound to portal A: Client Portal Template
doc with THIS portal token  -> 404
doc with OTHER portal token -> 401 PORTAL_SESSION_ANONYMOUS
ISOLATION run: expect 404 (cannot reach portal B doc) then 401 (other portal token refused)
```

Four independent claims across the two runs:

| Observation | What it establishes |
| --- | --- |
| the two runs report **different** client names | the portals are genuinely distinct tenants; without this the isolation result is vacuous |
| control `200` | the document exists and its owner can read it |
| isolation `404` | portal A cannot reach it — the exit criterion |
| `404` not `403` | existence is not disclosed; a 403 would confirm the id is real |
| other-token `401` in both runs | a stolen context token cannot be replayed into another tenant |

## Interpreting anything else

| Result | Meaning |
| --- | --- |
| `WRONG FRAME` | switch the console context to the compass-ai frame |
| `NOT PORTAL-BOUND` | you are on a directly-opened app tab, or not signed into that portal. Open the portal page and use its frame |
| control `200` missing | the document does not exist or is not in portal B's client. **Fix before reading the isolation run** — it is meaningless until the control passes |
| isolation `200` | **stop and escalate.** A cross-tenant read succeeded |
| isolation `403` | tenancy holds but leaks existence; `loadOwnedDocument` should 404, not 403 |
| other-token anything but `401` | a context token was accepted by a session bound elsewhere — **escalate** |

## Afterwards

Delete the fixture document if you seeded one, so a client is not left holding a
phantom row.

---

## Check 5 — an uploaded document is visible to the CLIENT (added after a live miss)

**Why this is here.** For one day on production, every newly uploaded document was
visible in zero portals. Migration v4 made visibility resolve through
`documents.source_id`; the upload route never set one. The document indexed fine, cost
real money, and no client could see it.

**Nothing automated caught it, and nothing automated can.** An employee's document
list deliberately bypasses the visibility view (§6.5), so the uploader sees the file
with a green "Ready" dot either way — which is what happened. Only a client-scoped
read shows the gap, and a client-scoped read needs a session minted through the portal
launcher, which Gate does not expose to tests.
`specs/compass-ai/upload-visibility.spec.ts` is written and correct; it skips for that
reason. So this check is manual, permanently.

### Steps

1. Open the portal as a **client** (not as staff, and not through the app host).
2. Upload a small PDF — or have staff upload one for that client.
3. Still as the client, reload and confirm the document appears in the sidebar.
4. Open it. The viewer must render, not show "Could not open".

### If it is missing

```
node scripts/sql-migrate.mjs query --stage prod --sql \
  "SELECT name, source_id IS NULL AS no_source,
          (SELECT count(*) FROM portal_visible_documents v WHERE v.document_id = d.id) AS visible
     FROM documents d WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5"
```

`no_source = true` with `visible = 0` is this exact failure. The repair is idempotent:

```
node scripts/backfill-app-upload-sources.mjs --stage prod --dry-run   # inspect first
node scripts/backfill-app-upload-sources.mjs --stage prod --yes
```

Then find out why a new upload had no source: `ensureAppUploadSource` in
`backend/src/lib/sources.ts` is what sets it, and the upload route calls it once per
batch.
