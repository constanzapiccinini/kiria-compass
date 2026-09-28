import { test, expect } from "@playwright/test";
import { fixtureUser, resolveTargetEnvironment } from "../../helpers/env";
import {
  buildPdf,
  deleteDocument,
  signInOrSkip,
  uploadPdf,
  waitForExtraction,
} from "../../helpers/compass";
import {
  missingTokenReason,
  openPortalApp,
  portalApi,
  portalToken,
  type PortalApi,
  type PortalSession,
  portalBoundSessionOrSkip,
  portalBoundSessionAvailable,
  PORTAL_BOUND_SESSION_REASON,
} from "../../helpers/portal";

/**
 * PDF viewer contract.
 *
 * A canvas element that exists but is blank would satisfy any selector-based
 * assertion, so these specs sample canvas pixels: a broken PDF.js worker, a missing
 * font asset, or a failed byte proxy all show up as an empty raster.
 */

const env = resolveTargetEnvironment();
const FIXTURE = "staff";
const TOKEN = portalToken(env, "A");

test.describe("pdf viewer", () => {
  test.skip(
    fixtureUser(env, FIXTURE) === null || TOKEN === null,
    `needs a "${FIXTURE}" fixture user and ${missingTokenReason("A")}`,
  );
  test.skip(!portalBoundSessionAvailable(), PORTAL_BOUND_SESSION_REASON);

  let documentId: string | null = null;
  let api: PortalApi | null = null;
  let session: PortalSession | null = null;

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, FIXTURE);
    api = portalApi(page.request, TOKEN as string);

    // These specs need a portal-BOUND session: they upload, index and read as an
    // employee inside a portal. Without this guard they failed with a raw
    // 401 PORTAL_SESSION_ANONYMOUS, which reads like a broken app rather than an
    // unobtainable fixture. Gate returns a userId only for a session minted through
    // the portal launcher, so this skips for the accurate reason — and runs the day
    // that changes.
    session = await portalBoundSessionOrSkip(api);
  });

  test.afterEach(async ({ page }) => {
    // Cleanup goes through the admin app now: the client app cannot delete anything
    // (§5C). Best-effort on purpose — a teardown failure must not mask the assertion
    // that already ran.
    if (documentId) {
      await deleteDocument(page, env, documentId).catch(() => undefined);
    }
    documentId = null;
    api = null;
    session = null;
  });

  test("renders an uploaded PDF, its thumbnails and its page count", async ({ page }) => {
    const pdf = buildPdf(
      ["1. Scope", "This report covers the annual inspection programme."],
      ["2. Outcome", "All tolerances were met."],
    );
    const uploaded = await uploadPdf(page, env, session!.clientId, "e2e-viewer.pdf", pdf);
    documentId = uploaded.id;
    await waitForExtraction(api!, uploaded.id);

    // Re-open *with* the portal token: signIn landed on the app root without one, so
    // a plain reload would render the portal-error screen instead of the app.
    await openPortalApp(page, TOKEN as string);

    // Open it explicitly rather than relying on which document auto-opens.
    await page.getByRole("button", { name: `Open e2e-viewer.pdf in the viewer` }).click();

    // `data-rendered` flips only after the raster completes.
    await expect(page.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();

    const ink = await page.evaluate(() => {
      const canvas = document.querySelector('canvas[aria-label="Page 1"]');
      if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) return null;
      const context = canvas.getContext("2d");
      if (!context) return null;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 200 && data[i + 3] > 0) dark += 1;
      }
      return { width: canvas.width, height: canvas.height, dark };
    });

    expect(ink, "page 1 has no canvas").not.toBeNull();
    expect(
      ink!.dark,
      `page 1 rasterized blank (${ink!.width}x${ink!.height}) — check the PDF.js worker ` +
        "asset and /api/documents/:id/file",
    ).toBeGreaterThan(200);

    // One thumbnail per page, and a page indicator that knows the total.
    await expect(page.getByRole("button", { name: "Go to page 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Go to page 2" })).toBeVisible();
    await expect(page.getByText(/^\d+ \/ 2$/)).toBeVisible();
  });

  test("thumbnail navigation moves the viewer to that page", async ({ page }) => {
    const pdf = buildPdf(
      ["1. First page marker"],
      ["2. Second page marker", "The second page carries a distinct heading."],
    );
    const uploaded = await uploadPdf(page, env, session!.clientId, "e2e-thumbs.pdf", pdf);
    documentId = uploaded.id;
    await waitForExtraction(api!, uploaded.id);

    await openPortalApp(page, TOKEN as string);
    await page.getByRole("button", { name: `Open e2e-thumbs.pdf in the viewer` }).click();
    await expect(page.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();

    await page.getByRole("button", { name: "Go to page 2" }).click();
    await expect(page.getByText("2 / 2")).toBeVisible();
  });

  test("the PDF byte proxy refuses an unknown document", async () => {
    // A well-formed but non-existent id must 404 — never leak another client's bytes,
    // and never 500. The proxy exists so the tenancy check applies to the bytes
    // themselves; the file service read URL is public and never reaches the browser.
    const response = await api!.get(
      "/api/documents/00000000-0000-4000-8000-000000000000/file",
    );
    expect(response.status()).toBe(404);
  });
});
