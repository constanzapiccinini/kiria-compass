/**
 * Which RLS settings Gate actually injects for the backend's own token (§4.3).
 *
 * This is a *measurement*, not a policy test. Writing an RLS policy keyed to a
 * setting the backend does not carry turns every read into zero rows — a total
 * outage — and the value cannot be established any other way: the operator token
 * used by scripts gets a different injection than the app's service token, so the
 * only honest source is the deployed backend asking Postgres itself.
 *
 * It asserts nothing about *which* settings are present, because that is the
 * unknown being measured. What it does assert is that the probe worked at all, and
 * it prints the result so the policy design has a fact to rest on.
 */

import { expect, test } from "@playwright/test";
import { resolveTargetEnvironment, type TargetEnvironment } from "../../helpers/env";
import { signInOrSkip } from "../../helpers/compass";

const env: TargetEnvironment = resolveTargetEnvironment();

/** The only fixture whose magic link this platform returns inline. Role is irrelevant here. */
const SESSION_FIXTURE = "e2e";

test("the backend reports which app.* RLS settings its token carries", async ({ page }) => {
  await signInOrSkip(page, env, SESSION_FIXTURE);

  const response = await page.request.get("/api/health/detail");
  const body = await response.text();
  expect(response.status(), `health/detail -> ${response.status()}: ${body.slice(0, 300)}`).toBe(
    200,
  );

  const payload: unknown = JSON.parse(body);
  expect(typeof payload === "object" && payload !== null).toBe(true);
  const detail = payload as { storeReachable?: unknown; rlsSettings?: unknown };

  expect(detail.storeReachable, "the store was not reachable, so nothing was measured").toBe(
    true,
  );

  // A string here means the probe itself failed and carries the reason; an object is
  // the measurement. Either way it must be printed — a passing test that reports
  // nothing would leave the policy design exactly as blind as before.
  console.log("app.* settings injected for the backend token:", JSON.stringify(detail.rlsSettings));

  expect(
    typeof detail.rlsSettings === "object" && detail.rlsSettings !== null,
    `the settings probe failed: ${String(detail.rlsSettings)}`,
  ).toBe(true);
});
