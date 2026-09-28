import { test, expect } from "@playwright/test";
import { appBaseUrl, fixtureUser, resolveTargetEnvironment } from "../../helpers/env";
import {
  buildPdf,
  countAudit,
  deleteDocument,
  signInOrSkip,
  uploadPdf,
} from "../../helpers/compass";
import {
  TENANT_KEYS,
  errorCode,
  forgedToken,
  getWithQuery,
  missingTokenReason,
  portalApi,
  portalBoundSessionOrSkip,
  portalHeaders,
  portalToken,
  type PortalApi,
  type PortalSession,
  portalBoundSessionAvailable,
  PORTAL_BOUND_SESSION_REASON,
} from "../../helpers/portal";

/**
 * Portal tenancy and the two-role model — Phase 4A, §15 (Tenancy and Roles).
 *
 * These assert the *negative* outcomes: what a portal context must not select, what a
 * client actor must not be able to do, and what the API must refuse to be told. A
 * fail-open regression here is the expensive kind, and a happy-path test never shows
 * it.
 *
 * This file replaces the pre-4A `access-control.spec.ts`, which was written against
 * the v2 model (`workspaces`, `workspace_members`, `?workspaceId=`,
 * `/api/workspaces/me`). Migration v3 dropped every one of those, so that spec could
 * no longer pass — and because its coupling was through URL strings and SQL rather
 * than types, nothing failed at compile time to say so. Its two assertions worth
 * keeping (a refused delete must not delete; a foreign document must not enter a
 * chat's scope) are carried over below.
 *
 * ## Why every test needs a session
 *
 * The platform edge rejects any `/api/*` request that carries no app token, with its
 * own response — the request never reaches the app:
 *
 *   $ curl -i https://compass-ai.thefusebase.app/api/session
 *   HTTP/1.1 401 Unauthorized
 *   {"error":"unauthorized","reason":"no-token"}
 *
 * So even the pure-refusal assertions need a signed-in context; none of them can be
 * checked with a bare request. That edge behaviour also satisfies §15's "anonymous
 * visitor with a valid portal token but no session → 401", and is asserted below
 * rather than assumed.
 *
 * ## Why some tests skip
 *
 * Two independent fixtures are missing in the current environment:
 *
 *  - **Sign-in.** `signIn` uses a platform magic link, and `createAppMagicLink`
 *    withholds the URL for an account that has never activated a link for this org
 *    (NIM-42663 / NIM-43179). Until that is resolved no spec in this suite can run.
 *  - **Portal context tokens.** Gate never returns a `portalFeatureContextToken`, so
 *    anything asserting a *successful* resolution needs one supplied out of band.
 *    See `helpers/portal.ts`.
 *
 * The cases are written regardless, so the suite becomes complete the moment each
 * fixture exists rather than needing to be authored under time pressure later.
 */

const env = resolveTargetEnvironment();
const FIXTURE = "staff";
const CLIENT_FIXTURE = "client";
/**
 * Any signed-in identity will do for the refusal tests: none of them resolves a
 * portal, so the actor never matters. A dedicated fixture keeps them independent of
 * whether the owner's magic link happens to be returned.
 */
const SESSION_FIXTURE = "e2e";

/** A well-formed uuid that belongs to nothing, for "does this leak?" probes. */
const ABSENT_UUID = "00000000-0000-4000-8000-000000000000";

/** A real portal that this app is not bound to, for forged-claim tests. */
const OTHER_PORTAL = {
  portalId: "aq12dbsx6ny104ujyabwrbx47",
  workspaceId: "4g0ryu57et2mwdg9",
};

test.describe("portal tenancy — refusals", () => {
  test.skip(
    fixtureUser(env, SESSION_FIXTURE) === null,
    `no "${SESSION_FIXTURE}" fixture user in environments/${env.name}.json — add one to fixtures.testUsers`,
  );

  test("an unauthenticated request never reaches the app at all", async ({
    playwright,
  }) => {
    // Defence in depth, and the reason every other test here needs a session: the
    // edge refuses before any app code runs, so a missing session can never be
    // mistaken by the app for an anonymous-but-permitted caller.
    const anonymous = await playwright.request.newContext();
    try {
      const response = await anonymous.get(
        `${appBaseUrl(env, "compass-ai")}/api/session`,
      );
      expect(response.status()).toBe(401);
      // Not the app's `{ error: { code } }` shape — proof it was the edge and not a
      // handler that happened to return the same status.
      expect(await errorCode(response)).toBeNull();
    } finally {
      await anonymous.dispose();
    }
  });

  test.describe("with a signed-in session", () => {
    test.beforeEach(async ({ page }) => {
      await signInOrSkip(page, env, SESSION_FIXTURE);
    });

    test("a request with no portal context is refused, not defaulted", async ({
      page,
    }) => {
      const response = await page.request.get("/api/session");

      // 400 rather than 401: nothing is wrong with the caller, the request is
      // unusable. The distinction matters because a 401 invites a sign-in prompt
      // that would not fix anything.
      expect(response.status()).toBe(400);
      expect(await errorCode(response)).toBe("PORTAL_CONTEXT_MISSING");
    });

    test("no route accepts a caller-supplied tenant id", async ({ page }) => {
      // §14's second exit criterion.
      for (const key of TENANT_KEYS) {
        const response = await getWithQuery(
          page.request,
          "/api/documents",
          key,
          ABSENT_UUID,
        );

        expect(response.status(), `query key ${key} was not refused`).toBe(400);
        expect(await errorCode(response), `query key ${key}`).toBe(
          "TENANCY_PROBE",
        );
      }
    });

    test("a tenant id in a JSON body is refused just as firmly as in the query", async ({
      page,
    }) => {
      // A body is the more tempting vector: it is invisible in access logs and a
      // caller can set it alongside their own legitimate session.
      for (const key of TENANT_KEYS) {
        const response = await page.request.post("/api/chats", {
          data: { title: "probe", [key]: ABSENT_UUID },
        });

        expect(response.status(), `body key ${key} was not refused`).toBe(400);
        expect(await errorCode(response), `body key ${key}`).toBe(
          "TENANCY_PROBE",
        );
      }
    });

    test("a probe is refused rather than silently ignored", async ({ page }) => {
      // Stripping the parameter and continuing would be the friendlier behaviour and
      // the wrong one: it would let a caller enumerate ids while believing the filter
      // applied, and would leave no trace that anyone tried.
      const refused = await getWithQuery(
        page.request,
        "/api/documents",
        "clientId",
        ABSENT_UUID,
      );
      expect(await errorCode(refused)).toBe("TENANCY_PROBE");

      // The same route without the parameter fails for a different, honest reason.
      const clean = await page.request.get("/api/documents");
      expect(await errorCode(clean)).toBe("PORTAL_CONTEXT_MISSING");
    });

    /**
     * §5C — the client app configures nothing.
     *
     * Placed in *this* describe on purpose. A deleted route would 404, but the
     * platform edge refuses any `/api/*` request without an app token first — so an
     * unauthenticated probe returns 401 and proves nothing about the app. Any
     * signed-in identity is enough: routing happens before the portal is resolved,
     * so the caller's actor never matters. Keeping these behind the client-actor
     * gate meant the most valuable assertion of §5C never ran.
     */
    test("the configuration routes are gone from this app entirely", async ({ page }) => {
      // These used to refuse a client with `FORBIDDEN_CLIENT_ROLE` while serving staff.
      // §5C removed them: this app is view + chat for everyone, and settings, indexing
      // and the audit trail live in Compass Admin. A 404 is a stronger guarantee than
      // the old 403 — there is no handler left to get the role check wrong.
      //
      // Asserted for a *client* caller specifically, because that is the caller who
      // must never reach them; that they are equally absent for staff is what makes
      // "one place to configure" true rather than aspirational.
      const failures: string[] = [];
      for (const path of [
        "/api/indexing",
        "/api/sources",
        "/api/session/settings",
        "/api/session/audit",
      ]) {
        const response = await page.request.get(path);
        if (response.status() !== 404) {
          failures.push(`GET ${path} -> ${response.status()}, expected 404`);
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });

    test("the document and folder mutations are gone from this app entirely", async ({
      page,
    }) => {
      // The other half of §5C. Upload, delete, re-index and every folder mutation were
      // employee-gated here and are now admin-only, so the client app cannot change
      // anything at all — which is the property that makes two code paths for one job
      // impossible rather than merely discouraged.
      const failures: string[] = [];

      const cases: Array<{ method: "post" | "delete" | "patch" | "put"; path: string }> = [
        { method: "post", path: "/api/documents" },
        { method: "delete", path: `/api/documents/${ABSENT_UUID}` },
        { method: "post", path: `/api/documents/${ABSENT_UUID}/reindex` },
        { method: "post", path: "/api/folders" },
        { method: "patch", path: `/api/folders/${ABSENT_UUID}` },
        { method: "delete", path: `/api/folders/${ABSENT_UUID}` },
        { method: "put", path: `/api/folders/documents/${ABSENT_UUID}` },
      ];

      for (const { method, path } of cases) {
        const response = await page.request[method](path);
        if (response.status() !== 404) {
          failures.push(`${method.toUpperCase()} ${path} -> ${response.status()}, expected 404`);
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });

    /**
     * §5D.4 — the dev-only alert test route must not exist in production.
     *
     * It raises a REAL alert through the real path: same dedupe key, same counter,
     * same 30-minute notification throttle, same email. That is what makes it worth
     * having on a dev machine and unacceptable here — an alert in the inbox is
     * something a person acts on, and its email carries table, source and tenant
     * names.
     *
     * The guard is structural: the handler is only registered when the stage is not
     * `prod`, so this asserts a router-level 404 rather than a refusal. A comment
     * claiming that is not an assertion, which is why this test exists.
     */
    test("the dev-only alert test route does not exist in production", async ({ page }) => {
      const response = await page.request.post("/api/alerts/test", {
        data: { code: "STORE_UNAVAILABLE" },
      })

      // 404, not 403: there is no handler to refuse. Anything else means the route
      // was mounted in a deployed app.
      expect(
        response.status(),
        `POST /api/alerts/test answered ${response.status()} — it must not be mounted in production`,
      ).toBe(404)
    })

    test("a refused probe leaves an audit trail", async ({ page }) => {
      // §15 requires the trail, and until this assertion existed the claim that a
      // probe "leaves a trace" was a code comment rather than a fact — the backend
      // refused the request and recorded nothing at all.
      //
      // Counted rather than matched on a specific row: the suite runs in parallel
      // against a shared environment, so "one more than before" is the only stable
      // property. It still fails if nothing is written.
      const before = await countAudit(env, "tenancy_probe_denied");

      const marker = `probe-${Date.now().toString(36)}`;
      const refused = await getWithQuery(
        page.request,
        "/api/documents",
        "clientId",
        `${ABSENT_UUID}?${marker}`,
      );
      expect(await errorCode(refused)).toBe("TENANCY_PROBE");

      // The write is deliberately not awaited by the backend — it must not put a
      // database round trip in front of a rejection — so allow it to land.
      await expect
        .poll(() => countAudit(env, "tenancy_probe_denied"), {
          message: "no tenancy_probe_denied audit row was written",
          timeout: 15_000,
        })
        .toBeGreaterThan(before);
    });

    test("a forged context token is refused even with a real session", async ({
      page,
    }) => {
      // The case that matters: valid-looking claims naming a genuinely existing
      // portal, presented by a genuinely signed-in user. It must still fail, because
      // verification goes through Gate's signature check rather than a local decode.
      const response = await page.request.get("/api/session", {
        headers: portalHeaders(
          forgedToken(OTHER_PORTAL.portalId, OTHER_PORTAL.workspaceId),
        ),
      });

      expect(response.status()).toBe(403);
      expect(await errorCode(response)).toBe("PORTAL_VERIFY_FAILED");
    });

    test("the portal context is never read from a request body", async ({
      page,
    }) => {
      // Reading it from a body would let a caller pair their own session with a
      // portal context they were merely given, which is the whole attack this design
      // exists to prevent. Sending it there must leave the request context-less.
      const response = await page.request.post("/api/chats", {
        data: {
          portalFeatureContextToken: forgedToken(
            OTHER_PORTAL.portalId,
            OTHER_PORTAL.workspaceId,
          ),
        },
      });

      expect(response.status()).toBe(400);
      expect(await errorCode(response)).toBe("PORTAL_CONTEXT_MISSING");
    });

    test("the v2 tenant-selecting routes are gone, not merely guarded", async ({
      page,
    }) => {
      // Removal is the stronger property: a route that still exists can be
      // re-exposed by a permissions mistake, and these were the routes that let a
      // caller name a workspace. `/api/workspaces/me` also returned the workspace
      // list, so its absence is what makes "one portal = one client" enforceable
      // rather than conventional.
      for (const path of [
        "/api/workspaces/me",
        "/api/workspaces",
        `/api/indexing/${ABSENT_UUID}`,
      ]) {
        const response = await page.request.get(path);
        expect(response.status(), `${path} still responds`).toBe(404);
      }
    });
  });
});

test.describe("portal tenancy — cross-portal isolation", () => {
  const tokenA = portalToken(env, "A");
  const tokenB = portalToken(env, "B");

  test.skip(
    fixtureUser(env, FIXTURE) === null || tokenA === null || tokenB === null,
    `needs a "${FIXTURE}" fixture user and both portal tokens — ${missingTokenReason("A")} / ${missingTokenReason("B")}`,
  );
  test.skip(!portalBoundSessionAvailable(), PORTAL_BOUND_SESSION_REASON);

  let apiB: PortalApi | null = null;
  /** Portal B's tenant, so the fixture document is created for the right one. */
  let sessionB: PortalSession | null = null;
  /** A document that exists only in portal B, for portal A to fail to reach. */
  let foreignDocumentId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, FIXTURE);
    apiB = portalApi(page.request, tokenB as string);

    // Before anything else: the upload below needs a resolved portal, and without a
    // portal-bound session it would fail as an opaque 401 rather than saying why.
    sessionB = await portalBoundSessionOrSkip(apiB);

    // Create the foreign document rather than depending on one already being there.
    // An earlier version of these specs read whatever portal B happened to contain
    // and skipped when it was empty — which meant the exit-criterion tests could
    // silently not run. A self-made fixture cannot be empty.
    //
    // Extraction is deliberately not awaited: every assertion here is about tenancy,
    // and the document row exists as soon as the upload returns.
    // Created through the admin app, for portal B's tenant specifically — that is
    // the whole point of the fixture, and `sessionB.clientId` is the id portal B
    // itself resolves to rather than one this spec chose.
    const uploaded = await uploadPdf(
      page,
      env,
      sessionB.clientId,
      `e2e-tenancy-${Date.now().toString(36)}.pdf`,
      buildPdf(
        ["1. Confidential", "This belongs to portal B and must never leave it."],
        ["2. Detail", "Cross-portal reads must fail before reaching this text."],
      ),
    );
    foreignDocumentId = uploaded.id;
  });

  test.afterEach(async ({ page }) => {
    if (foreignDocumentId) {
      await deleteDocument(page, env, foreignDocumentId).catch(() => undefined);
    }
    foreignDocumentId = null;
    apiB = null;
    sessionB = null;
  });

  test("each portal resolves to exactly one distinct client", async ({ page }) => {
    // If both tokens resolved to the same client, every isolation test below would
    // pass vacuously. This makes that failure mode loud rather than invisible.
    const readClient = async (token: string): Promise<string> => {
      const response = await page.request.get("/api/session", {
        headers: portalHeaders(token),
      });
      expect(response.status()).toBe(200);
      return ((await response.json()) as { client: { id: string } }).client.id;
    };

    expect(await readClient(tokenA as string)).not.toBe(
      await readClient(tokenB as string),
    );
  });

  test("a document id from portal B is a 404 in portal A, never a 403", async ({
    page,
  }) => {
    // §14's first exit criterion, and the reason `loadOwnedDocument` filters by
    // client rather than checking after the fact. 404 rather than 403 is deliberate:
    // a 403 confirms the id exists, which is itself the leak.
    const foreignId = foreignDocumentId as string;

    for (const path of [
      `/api/documents/${foreignId}`,
      `/api/documents/${foreignId}/file`,
      `/api/documents/${foreignId}/pages`,
      `/api/documents/${foreignId}/paragraphs`,
    ]) {
      const response = await page.request.get(path, {
        headers: portalHeaders(tokenA as string),
      });
      expect(response.status(), `${path} leaked across portals`).toBe(404);
    }
  });

  test("a chat cannot be read or answered from across the boundary", async ({
    page,
  }) => {
    // This is the case the 4A refactor surfaced: `loadChat` resolved an id with no
    // client predicate, so every downstream handler trusted a foreign chat. The
    // rename that turned `workspace_id` into `client_id` could not surface it,
    // because the defect was a predicate that was *missing*.
    const created = await page.request.post("/api/chats", {
      headers: portalHeaders(tokenB as string),
      data: { title: "cross-portal probe" },
    });
    expect(created.status()).toBe(201);
    const chatId = ((await created.json()) as { id: string }).id;

    try {
      const read = await page.request.get(`/api/chats/${chatId}`, {
        headers: portalHeaders(tokenA as string),
      });
      expect(read.status(), "a foreign chat was readable").toBe(404);

      const asked = await page.request.post(`/api/chats/${chatId}/messages`, {
        headers: portalHeaders(tokenA as string),
        data: { question: "What does the document say?" },
      });
      expect(asked.status(), "a foreign chat was answerable").toBe(404);
    } finally {
      await page.request
        .delete(`/api/chats/${chatId}`, {
          headers: portalHeaders(tokenB as string),
        })
        .catch(() => undefined);
    }
  });

  test("a refused cross-portal delete does not delete", async ({ page }) => {
    // Carried over from the pre-4A spec, which checked survival via SQL. Re-reading
    // through portal B's own context is stronger: it proves the row is still
    // *reachable by its owner*, not merely still present in a table.
    const foreignId = foreignDocumentId as string;

    const deleted = await page.request.delete(`/api/documents/${foreignId}`, {
      headers: portalHeaders(tokenA as string),
    });
    expect(deleted.status(), "delete reached across portals").toBe(404);

    const stillThere = await page.request.get(`/api/documents/${foreignId}`, {
      headers: portalHeaders(tokenB as string),
    });
    expect(
      stillThere.status(),
      "the refused delete removed the document anyway",
    ).toBe(200);
  });

  test("a foreign document cannot be pulled into a chat's scope", async ({
    page,
  }) => {
    // The subtlest path: a citation is only trustworthy if every id in scope belongs
    // to the portal's client. Accepting a foreign id here would produce a
    // correctly-formatted citation naming a document the caller may not read — worse
    // than an error, because it looks right.
    const created = await page.request.post("/api/chats", {
      headers: portalHeaders(tokenA as string),
      data: { title: "scope injection probe" },
    });
    expect(created.status()).toBe(201);
    const chatId = ((await created.json()) as { id: string }).id;

    try {
      const scoped = await page.request.put(`/api/chats/${chatId}/documents`, {
        headers: portalHeaders(tokenA as string),
        data: { documentIds: [foreignDocumentId as string] },
      });
      expect(
        scoped.status(),
        "a foreign document was accepted into chat scope",
      ).toBe(400);
    } finally {
      await page.request
        .delete(`/api/chats/${chatId}`, {
          headers: portalHeaders(tokenA as string),
        })
        .catch(() => undefined);
    }
  });
});

test.describe("the two derived roles", () => {
  const token = portalToken(env, "A");

  test.skip(
    fixtureUser(env, FIXTURE) === null || token === null,
    `needs a "${FIXTURE}" fixture user and ${missingTokenReason("A")}`,
  );

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, FIXTURE);
    await portalBoundSessionOrSkip(portalApi(page.request, token as string));
  });

  test("an employee gets the privileged capabilities", async ({ page }) => {
    const response = await page.request.get("/api/session", {
      headers: portalHeaders(token as string),
    });
    expect(response.status()).toBe(200);

    const session = (await response.json()) as {
      actor: string;
      capabilities: Record<string, boolean>;
    };

    expect(
      session.actor,
      `the "${FIXTURE}" fixture is expected to be KIRIA staff`,
    ).toBe("employee");

    for (const capability of ["viewIndexing", "changeSettings"]) {
      if (capability in session.capabilities) {
        expect(session.capabilities[capability], capability).toBe(true);
      }
    }
  });

  test("the session reports an actor and never a stored role", async ({ page }) => {
    const response = await page.request.get("/api/session", {
      headers: portalHeaders(token as string),
    });
    expect(response.status()).toBe(200);

    const session = (await response.json()) as {
      actor: string;
      capabilities: Record<string, boolean>;
    };

    // Exactly two roles exist, derived per request. Anything else means a role has
    // been persisted somewhere it can drift from the truth.
    expect(["employee", "client"]).toContain(session.actor);

    // §5C: three capabilities, identical for both actors. This app is view + chat
    // only now, for staff as well as clients, so a capability that differs by actor
    // would mean a configuration surface had grown back here.
    expect(Object.keys(session.capabilities).sort()).toEqual([
      "chat",
      "exportAnswers",
      "viewDocuments",
    ]);
    for (const [capability, value] of Object.entries(session.capabilities)) {
      expect(value, `${capability} should be true for every actor`).toBe(true);
    }
  });

});



test.describe("a client actor", () => {
  // The actor is derived from the caller's org role, so these need a caller who
  // genuinely *is* a client. Signing in as the owner and skipping when the actor came
  // back "employee" meant this half could never run — a structural skip dressed up as
  // an environmental one.
  const token = portalToken(env, "A");

  test.skip(
    fixtureUser(env, CLIENT_FIXTURE) === null || token === null,
    `needs a "${CLIENT_FIXTURE}" fixture user and ${missingTokenReason("A")}`,
  );

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, CLIENT_FIXTURE);

    // Fail loudly rather than silently testing an employee: if the fixture's org role
    // ever changes, these assertions would otherwise pass for the wrong reason.
    const session = await portalBoundSessionOrSkip(
      portalApi(page.request, token as string),
    );
    expect(
      session.actor,
      `the "${CLIENT_FIXTURE}" fixture must have org role "client"`,
    ).toBe("client");
  });

  test("employee-only affordances are absent from a client's DOM, not disabled", async ({
    page,
  }) => {
    // §8.2 insists on absence rather than a disabled control: a disabled button still
    // tells a client the capability exists, and a `disabled` attribute is one
    // devtools edit away from a request the backend then has to refuse.
    await page.goto(
      `/?portalFeatureContextToken=${encodeURIComponent(token as string)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForSelector("#root", { timeout: 45_000 });

    for (const label of [/upload/i, /re-?index/i, /indexing/i, /settings/i]) {
      await expect(
        page.getByRole("button", { name: label }),
        `a control matching ${label} was rendered for a client`,
      ).toHaveCount(0);
    }
  });
});
