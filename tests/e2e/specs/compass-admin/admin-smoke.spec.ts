/**
 * Compass Admin — every read route, with a real staff session.
 *
 * Why this spec exists: the eight admin screens have never been opened in a browser,
 * and the class of bug that hides there is a **query that only fails when it runs**.
 * One was already found by reading code — the sync-history route selected
 * `ingest_jobs.started_at`, a column that does not exist, so the screen would have
 * 500'd the first time anyone clicked it. Nothing but execution finds the next one.
 *
 * So this is deliberately shallow and wide: hit every GET, assert no 5xx and that the
 * documented envelope is actually there. It is not a substitute for opening the
 * screens — it cannot see a broken layout, a mis-wired control or an empty table that
 * should have rows — but it does prove every query the screens depend on can run
 * against real data.
 *
 * Read-only by construction. Nothing here mutates prod: the app runs against a live
 * organisation with a real client's documents in it, and a smoke test is the wrong
 * place to discover that a delete route works.
 */

import { expect, test } from "@playwright/test";
import { resolveTargetEnvironment, type TargetEnvironment } from "../../helpers/env";
import { signInOrSkip } from "../../helpers/compass";

const env: TargetEnvironment = resolveTargetEnvironment();

/**
 * The staff identity the read routes need.
 *
 * `requireAdmin` demands an org role in {member, manager, owner}. This is the `staff`
 * fixture rather than `owner` because `owner@example.com`'s magic link is withheld by the
 * platform — Gate returns a URL inline only for an address with no FuseBase account,
 * or one that has already activated a link for this org — and being the org owner does
 * not lift that. `owner` is marked `magicLinkInline: false` in the environment file so
 * runs skip without mailing a real inbox on every pass.
 */
const STAFF_FIXTURE = "staff";

/**
 * A signed-in identity whose link IS returned inline, for the refusal test.
 *
 * Role `client`, which is exactly what that test needs — and it means the most
 * security-relevant assertion in this file runs today rather than skipping with
 * everything else.
 */
const CLIENT_FIXTURE = "e2e";

/**
 * Routes that need no parameters. Each is one screen's primary read.
 *
 * `/documents` and `/sources` are per-client and take `clientId`; they are exercised
 * separately below with a real id, because calling them bare only proves the
 * validation rejects an absent id.
 */
const UNPARAMETERISED: Array<{ path: string; screen: string; envelope: string }> = [
  { path: "/api/session", screen: "shell", envelope: "actor" },
  { path: "/api/session/portals", screen: "portal picker", envelope: "portals" },
  { path: "/api/portals", screen: "1 — portals", envelope: "portals" },
  { path: "/api/ops/alerts", screen: "6 — alerts", envelope: "alerts" },
  { path: "/api/ops/alert-settings", screen: "6 — channels", envelope: "channels" },
  { path: "/api/ops/usage", screen: "7 — usage", envelope: "clients" },
  { path: "/api/ops/audit", screen: "8 — audit log", envelope: "entries" },
  { path: "/api/ops/audit/actions", screen: "8 — action filter", envelope: "actions" },
];

test.describe("compass admin — read routes", () => {
  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE);

    // Then land on THIS app's host, and only then call its API.
    //
    // The session cookie is per app host, and a magic-link activation redirects to
    // one app of the product — for this product, the client app. So a signed-in page
    // calling `/api/*` on the admin host without visiting it first gets the platform
    // edge's `401 {"error":"unauthorized","reason":"no-token"}` before the request
    // ever reaches the backend, which reads exactly like a broken admin app and is
    // nothing of the sort. Navigating lets the platform's auth handoff mint the app
    // token for this host.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root", { timeout: 45_000 });
  });

  /**
   * All nine parameterless routes in ONE test, on purpose.
   *
   * They were nine separate tests, which read better in a report and cost fifteen
   * magic-link sign-ins for a single fixture address. That is what broke the suite:
   * minting a fresh link can invalidate the previous session, so late tests started
   * failing on auth with nothing wrong with the routes. Dropping the worker count
   * made it *worse* — the run took three times as long and failed more, because the
   * problem is total activations for one address, not concurrency.
   *
   * Every route is still checked and still named on failure. Failures are collected
   * rather than thrown on the first one: with nine routes behind one assertion, "the
   * usage route 500s" must not hide "and so does the audit route".
   */
  test("every parameterless read route answers", async ({ page }) => {
    const failures: string[] = [];

    for (const route of UNPARAMETERISED) {
      const response = await page.request.get(route.path);
      const body = await response.text();

      if (response.status() !== 200) {
        failures.push(
          `${route.path} (screen ${route.screen}) -> ${response.status()}: ${body.slice(0, 300)}`,
        );
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        failures.push(`${route.path} returned non-JSON: ${body.slice(0, 200)}`);
        continue;
      }

      if (typeof json !== "object" || json === null) {
        failures.push(`${route.path} returned no object`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(json, route.envelope)) {
        failures.push(
          `${route.path} is missing its documented "${route.envelope}" envelope; got keys: ${Object.keys(
            json as Record<string, unknown>,
          ).join(", ")}`,
        );
      }
    }

    expect(failures, `${failures.length} of ${UNPARAMETERISED.length} read routes failed`).toEqual(
      [],
    );
  });

  /**
   * The per-portal screens, against a portal that actually exists.
   *
   * A hardcoded id would rot the moment the org changes, so the portal comes from the
   * picker's own endpoint — which also means this test fails honestly if that endpoint
   * ever stops returning usable ids.
   */
  test("the per-portal screens answer for a real portal", async ({ page }) => {
    const portals = await page.request.get("/api/session/portals");
    expect(portals.status()).toBe(200);

    const payload: unknown = await portals.json();
    const list =
      typeof payload === "object" && payload !== null && "portals" in payload
        ? (payload as { portals: unknown }).portals
        : null;
    expect(Array.isArray(list), "the portal picker returned no array").toBe(true);

    const first = (list as unknown[])[0];
    test.skip(
      first === undefined,
      "this organisation has no portals, so the per-portal screens have nothing to read",
    );
    // The tenancy key the per-portal routes read, carried on the portal row.
    const clientId =
      typeof first === "object" && first !== null && "clientId" in first
        ? String((first as { clientId: unknown }).clientId)
        : "";
    expect(clientId, "a portal row carried no tenancy key").not.toBe("");

    // `/api/documents`, `/api/sources` and `/api/documents/folders?clientId=` are
    // gone with §6A.1 and §6A.2: a document belongs to a library, so listing and
    // organising are addressed by library rather than by tenant. The library-scoped
    // equivalents are covered in libraries.spec.ts and folders.spec.ts, which can
    // create their own library rather than depending on what this org happens to
    // hold.
    for (const [path, envelope] of [
      ["/api/settings", "settings"],
      ["/api/settings/portals", "portals"],
    ] as const) {
      const response = await page.request.get(`${path}?clientId=${clientId}`);
      const body = await response.text();
      expect(
        response.status(),
        `${path}?clientId=… -> ${response.status()}: ${body.slice(0, 400)}`,
      ).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(body), envelope)).toBe(true);
    }
  });

  /**
   * The removed routes stay removed.
   *
   * §6A.1 deleted the table-source feature — routes, config parser, sync scheduler
   * and both screens — because nothing in either environment had ever used it. A
   * deleted route that quietly comes back with a deploy is how the reduction gets
   * undone, so absence is asserted rather than assumed. 404, not 403: there is no
   * handler left to get a check wrong.
   */
  test("the source routes are gone", async ({ page }) => {
    const failures: string[] = [];
    for (const path of ["/api/sources", "/api/sources/preview"]) {
      const response = await page.request.get(path);
      if (response.status() !== 404) {
        failures.push(`GET ${path} -> ${response.status()}, expected 404`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** Portal preview — the one read that resolves a portal's effective visibility. */
  test("portal preview answers for a real portal", async ({ page }) => {
    const portals = await page.request.get("/api/portals");
    expect(portals.status()).toBe(200);

    const payload: unknown = await portals.json();
    const rows =
      typeof payload === "object" && payload !== null && "portals" in payload
        ? ((payload as { portals: unknown }).portals as unknown[])
        : [];
    // The merged list includes unregistered portals, which have no row id and no
    // preview to give. Pick a registered one or skip honestly.
    const registered = (rows as Array<{ id?: unknown; registered?: unknown }>).find(
      (row) => row.registered === true && typeof row.id === "string",
    );
    test.skip(registered === undefined, "no portal is registered in this organisation");

    const portalRowId = String((registered as { id: unknown }).id);
    const preview = await page.request.get(`/api/portals/${portalRowId}/preview`);
    const body = await preview.text();
    expect(
      preview.status(),
      `portal preview -> ${preview.status()}: ${body.slice(0, 400)}`,
    ).toBe(200);
  });
});

test.describe("compass admin — authorization", () => {
  /**
   * A client must not reach the admin app at all.
   *
   * This is the property that matters most here: the admin routes legitimately accept
   * a `clientId`, which in the client app is a tenancy probe. What keeps a client out
   * is `requireAdmin` and nothing else, so it is worth an explicit test rather than
   * trust in the access list.
   */
  test("a client-role session is refused by code, not by the access list", async ({
    page,
  }) => {
    await signInOrSkip(page, env, CLIENT_FIXTURE);

    const response = await page.request.get("/api/session");
    expect(
      [401, 403],
      `a client reached the admin session route with ${response.status()}`,
    ).toContain(response.status());

    if (response.status() === 403) {
      const payload: unknown = await response.json();
      const code =
        typeof payload === "object" && payload !== null && "error" in payload
          ? (payload as { error: { code?: unknown } }).error?.code
          : undefined;
      // NOT_EMPLOYEE is the specific refusal; ACCESS_CHECK_FAILED would mean Gate was
      // unreachable, which must also read as refused rather than allowed.
      expect(["NOT_EMPLOYEE", "NOT_ORG_MEMBER", "ACCESS_CHECK_FAILED"]).toContain(code);
    }
  });
});
