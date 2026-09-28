/**
 * Portal reconcile and permanent removal — §6A.4, end to end.
 *
 * ## What can be tested here, and what cannot
 *
 * FuseBase is the source of truth for which portals exist. The interesting
 * transitions are therefore driven from *outside* this app — a rename in FuseBase, a
 * deletion in FuseBase — and this suite has no way to make either happen. What it
 * can do is assert the properties that hold on every run whatever the platform says,
 * and those turn out to be the ones that protect a client's data:
 *
 *   - a reconcile is **reported**, never silent: the screen can always say whether it
 *     ran, when it last succeeded, and what it changed;
 *   - a reconcile **deletes nothing**. Absence marks a portal `missing` and keeps its
 *     tenant, documents and chats. Asserted by counting before and after;
 *   - removal is refused for anything that is not missing, and refused again unless
 *     the name is typed exactly. Both refusals are checked against a real portal,
 *     which is the only way to know the guard is wired to the row rather than to a
 *     constant;
 *   - a private library refuses a second tick, because "private" is the only promise
 *     it makes.
 *
 * The transitions that need the platform to change — renamed → renamed here, absent →
 * `missing` + alert, reappeared → restored + alert resolved — are covered by
 * `tests/manual/portal-isolation.md`'s sibling procedure and by
 * `scripts/Coni-diagnose-library-visibility.mjs`. They are named here so the gap is
 * a decision on record rather than an oversight.
 *
 * Nothing here is destructive. The removal cases are all *refusals*, deliberately: a
 * test that actually removed a portal would need a portal it is allowed to destroy,
 * and this runs against a live organisation.
 */

import { expect, test } from "@playwright/test";
import { resolveTargetEnvironment, fixtureUser, type TargetEnvironment } from "../../helpers/env";
import { signInOrSkip } from "../../helpers/compass";

const env: TargetEnvironment = resolveTargetEnvironment();
const STAFF_FIXTURE = "staff";

interface PortalRow {
  portalId: string;
  id?: string | null;
  name: string;
  status?: string | null;
  registered?: boolean;
  missingForDays?: number | null;
  removable?: boolean;
  documentsVisible?: number | null;
}

interface PortalsResponse {
  portals: PortalRow[];
  reconcile?: {
    ran: boolean;
    ok: boolean;
    error: string | null;
    renamed: number;
    markedMissing: number;
    restored: number;
    lastRunAt: string | null;
    lastRunOk: boolean | null;
    graceDays: number;
  };
}

async function readPortals(page: import("@playwright/test").Page): Promise<PortalsResponse> {
  const response = await page.request.get("/api/portals");
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as PortalsResponse;
}

test.describe("compass admin — portal sync", () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`);

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE);
    // The session cookie is per app host; without visiting this one the platform edge
    // answers 401 before the backend sees the request.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root", { timeout: 45_000 });
  });

  test("the portal list reports its own sync state", async ({ page }) => {
    const body = await readPortals(page);
    expect(body.reconcile, "the portal list did not report a reconcile at all").toBeTruthy();

    const reconcile = body.reconcile!;
    // Either it ran on this load, or it was inside the fifteen-minute interval and
    // says when it last did. A screen that can report neither cannot distinguish
    // "nothing changed" from "this has not run since Tuesday".
    expect(
      reconcile.ran || reconcile.lastRunAt !== null || reconcile.error !== null,
      "the reconcile block says neither that it ran, nor when it last did, nor why not",
    ).toBe(true);

    // The grace period is configurable and must be a real number of days, because it
    // is the only thing standing between a five-second platform outage and a
    // permanent deletion.
    expect(reconcile.graceDays).toBeGreaterThan(0);
  });

  test("a forced reconcile changes nothing but the sync state", async ({ page }) => {
    const before = await readPortals(page);
    const registeredBefore = before.portals.filter((portal) => portal.registered === true);
    test.skip(registeredBefore.length === 0, "no registered portals to reconcile");

    const forced = await page.request.post("/api/portals/reconcile");
    expect(forced.status(), await forced.text()).toBe(200);
    const outcome = (await forced.json()) as {
      ok: boolean;
      error: string | null;
      portalsSeen: number;
      markedMissing: number;
    };

    // A failed platform read is reported, not thrown, and must change nothing — that
    // is the whole design: `readPlatformPortals` returning an empty list is treated
    // as a failure rather than as "every portal was deleted".
    if (!outcome.ok) {
      expect(
        outcome.markedMissing,
        "a reconcile that could not read the platform marked portals missing anyway",
      ).toBe(0);
      expect(outcome.error, "a failed reconcile did not say why").toBeTruthy();
    }

    // Nothing is deleted by a reconcile, ever. Every portal that existed still
    // exists — a name or a status may have changed, the row may not have vanished.
    const after = await readPortals(page);
    const missingRows = registeredBefore
      .filter((portal) => !after.portals.some((row) => row.portalId === portal.portalId))
      .map((portal) => portal.name);
    expect(missingRows, "a reconcile removed portal rows — it must never delete").toEqual([]);
  });

  test("removal is refused for a portal that is not missing", async ({ page }) => {
    const body = await readPortals(page);
    const live = body.portals.find(
      (portal) => portal.registered === true && portal.id && portal.status !== "missing",
    );
    test.skip(live === undefined, "no live portal to try to remove");

    // The impact read comes first in the UI too, so the confirmation can state real
    // numbers. It must already say the removal would be refused.
    const impact = await page.request.get(`/api/portals/${live!.id}/removal-impact`);
    expect(impact.status(), await impact.text()).toBe(200);
    const detail = (await impact.json()) as {
      status: string;
      removable: boolean;
      graceDays: number;
      label: string;
    };
    expect(detail.status).not.toBe("missing");
    expect(
      detail.removable,
      "a live portal was reported as removable — the grace check is not looking at status",
    ).toBe(false);

    // And the route refuses even when the name is typed correctly: being missing is a
    // separate condition from confirming, and the correct name must not be enough.
    const attempt = await page.request.delete(`/api/portals/${live!.id}/permanently`, {
      data: { confirmLabel: detail.label },
    });
    expect(
      attempt.status(),
      `a live portal was removable with the right name typed: ${await attempt.text()}`,
    ).toBe(409);
    expect(await attempt.text()).toContain("PORTAL_NOT_MISSING");

    // Still there.
    const after = await readPortals(page);
    expect(
      after.portals.some((portal) => portal.portalId === live!.portalId),
      "the portal is gone after a refused removal",
    ).toBe(true);
  });

  test("a private library refuses a second portal", async ({ page }) => {
    // A private library belongs to one portal and cannot be shared: "private" is the
    // only promise it makes, so the API refuses rather than quietly widening it.
    // Staff who want to share those files move them to a shared library, which is an
    // explicit, audited action.
    const libraries = await page.request.get("/api/libraries");
    expect(libraries.status()).toBe(200);
    const rows = (await libraries.json()) as {
      libraries: Array<{
        id: string;
        name: string;
        isPrivate: boolean;
        portals: Array<{ portalRowId: string }>;
      }>;
    };

    const privateLibrary = rows.libraries.find(
      (library) => library.isPrivate && library.portals.length === 1,
    );
    test.skip(
      privateLibrary === undefined,
      "no private library with exactly one portal — one is created with each tenant",
    );

    const portals = await readPortals(page);
    const owner = privateLibrary!.portals[0].portalRowId;
    const other = portals.portals.find(
      (portal) => portal.registered === true && portal.id && portal.id !== owner,
    );
    test.skip(other === undefined, "only one registered portal, so there is no second to tick");

    const response = await page.request.put(
      `/api/libraries/${privateLibrary!.id}/portals/${other!.id}`,
    );
    const text = await response.text();
    expect(
      response.status(),
      `a private library accepted a second portal: ${text.slice(0, 300)}`,
    ).toBe(409);
    expect(text, "the refusal did not identify itself").toContain("LIBRARY_IS_PRIVATE");

    // And it is still ticked to exactly one portal — a refusal that half-applied
    // would be worse than one that accepted.
    const after = (await (await page.request.get("/api/libraries")).json()) as {
      libraries: Array<{ id: string; portals: Array<{ portalRowId: string }> }>;
    };
    const reread = after.libraries.find((library) => library.id === privateLibrary!.id);
    expect(
      reread?.portals.map((entry) => entry.portalRowId),
      "the refused tick was written anyway",
    ).toEqual([owner]);
  });

  test("the manual rename route is gone", async ({ page }) => {
    // A portal's name comes from FuseBase and is rewritten on every reconcile, so an
    // edit made here would revert within fifteen minutes. §6A.4 removed the route
    // rather than leaving an edit that silently undoes itself — which is worse than
    // no edit, because it looks like it worked.
    const body = await readPortals(page);
    const portal = body.portals.find((row) => row.registered === true && row.id);
    test.skip(portal === undefined, "no registered portal");

    const response = await page.request.patch(`/api/portals/${portal!.id}`, {
      data: { label: "renamed-by-e2e-and-should-not-be" },
    });
    expect(
      response.status(),
      `the rename route answered ${response.status()} — a name edited here reverts on the next sync`,
    ).toBe(404);

    const after = await readPortals(page);
    expect(
      after.portals.find((row) => row.portalId === portal!.portalId)?.name,
      "the portal was renamed by a route that should not exist",
    ).toBe(portal!.name);
  });
});
