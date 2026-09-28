import { test, expect } from "@playwright/test";
import { fixtureUser, resolveTargetEnvironment } from "../../helpers/env";
import { signInOrSkip } from "../../helpers/compass";
import {
  missingTokenReason,
  openPortalApp,
  portalToken,
  portalBoundSessionOrSkip,
  portalApi,
  portalBoundSessionAvailable,
  PORTAL_BOUND_SESSION_REASON,
} from "../../helpers/portal";

/**
 * Floating chat widget: the keyboard shortcut, and geometry that survives a reload.
 *
 * The persistence check matters because the panel is anchored bottom-right and
 * clamped to the viewport — an off-by-one in either direction puts a remembered
 * panel off-screen, which is unrecoverable for the user without clearing site data.
 */

const env = resolveTargetEnvironment();
const FIXTURE = "staff";
const TOKEN = portalToken(env, "A");
const PANEL = '[role="dialog"][aria-label="Compass AI chat"]';

test.describe("chat widget", () => {
  test.skip(
    fixtureUser(env, FIXTURE) === null || TOKEN === null,
    `needs a "${FIXTURE}" fixture user and ${missingTokenReason("A")}`,
  );
  test.skip(!portalBoundSessionAvailable(), PORTAL_BOUND_SESSION_REASON);

  // Sign in, then open the app the way the portal embed does. Without the context
  // token the SPA renders the portal-error screen and no widget mounts, so these
  // specs would fail on a missing selector rather than on the behaviour they test.
  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, FIXTURE);

    // Checked before the UI is driven. With an anonymous session the SPA renders the
    // portal-error screen and no widget mounts, so every assertion below fails on a
    // missing selector — which reads as "the chat widget is broken" when the real
    // cause is a session Gate will not bind. This makes the skip say so.
    await portalBoundSessionOrSkip(portalApi(page.request, TOKEN as string));

    await openPortalApp(page, TOKEN as string);
  });

  test("starts collapsed and toggles with Ctrl+J", async ({ page }) => {

    const pill = page.getByRole("button", { name: /Open Compass AI chat/ });
    await expect(pill).toBeVisible();
    await expect(page.locator(PANEL)).toHaveCount(0);

    await page.keyboard.press("Control+j");
    await expect(page.locator(PANEL)).toBeVisible();

    await page.keyboard.press("Control+j");
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(pill).toBeVisible();
  });

  test("Escape collapses the panel", async ({ page }) => {
    await page.keyboard.press("Control+j");
    await expect(page.locator(PANEL)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(PANEL)).toHaveCount(0);
  });

  test("dragged position is restored after a reload", async ({ page }) => {
    await page.keyboard.press("Control+j");

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    const before = await panel.boundingBox();
    expect(before).not.toBeNull();

    // Grab the header (not a button in it) and drag up-left.
    await page.mouse.move(before!.x + 60, before!.y + 14);
    await page.mouse.down();
    await page.mouse.move(before!.x + 60 - 140, before!.y + 14 - 80, { steps: 12 });
    await page.mouse.up();

    const moved = await panel.boundingBox();
    expect(moved).not.toBeNull();
    expect(
      Math.abs(moved!.x - before!.x),
      "the panel did not move horizontally — the drag handle may be swallowing pointer events",
    ).toBeGreaterThan(60);

    const stored = await page.evaluate(() =>
      window.localStorage.getItem("compass-ai.chat-widget"),
    );
    expect(stored, "geometry was not persisted").not.toBeNull();

    await openPortalApp(page, TOKEN as string);
    // Waiting for the pill proves React mounted and bound the shortcut.
    await expect(page.getByRole("button", { name: /Open Compass AI chat/ })).toBeVisible();
    await page.keyboard.press("Control+j");
    await expect(panel).toBeVisible();

    const restored = await panel.boundingBox();
    expect(restored).not.toBeNull();
    expect(Math.abs(restored!.x - moved!.x)).toBeLessThan(6);
    expect(Math.abs(restored!.y - moved!.y)).toBeLessThan(6);
  });

  test("a remembered off-screen position is clamped back into view", async ({ page }) => {

    // Simulate geometry remembered from a much larger monitor.
    await page.evaluate(() =>
      window.localStorage.setItem(
        "compass-ai.chat-widget",
        JSON.stringify({ right: 9000, bottom: 9000, width: 400, height: 560 }),
      ),
    );
    await openPortalApp(page, TOKEN as string);
    await expect(page.getByRole("button", { name: /Open Compass AI chat/ })).toBeVisible();
    await page.keyboard.press("Control+j");

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();

    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.x, "panel is off the left edge").toBeGreaterThanOrEqual(0);
    expect(box!.y, "panel is off the top edge").toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  });
});
