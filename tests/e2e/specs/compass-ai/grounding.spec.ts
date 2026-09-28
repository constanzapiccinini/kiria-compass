import { test, expect } from "@playwright/test";
import { fixtureUser, resolveTargetEnvironment } from "../../helpers/env";
import {
  readClientSettings,
  readiness,
  setClientSettings,
  signInOrSkip,
} from "../../helpers/compass";
import {
  missingTokenReason,
  portalApi,
  portalToken,
  type PortalApi,
  type PortalSession,
  portalBoundSessionOrSkip,
  portalBoundSessionAvailable,
  PORTAL_BOUND_SESSION_REASON,
} from "../../helpers/portal";

/**
 * The zero-hallucination contract.
 *
 * When nothing relevant is retrieved, the app must return one exact sentence and no
 * citations — and it must do so without calling the model at all, so there is no
 * opportunity to invent an answer and no tokens spent. A regression here is the worst
 * possible failure for this product: a confident answer with no source.
 */

const env = resolveTargetEnvironment();
const FIXTURE = "staff";
const TOKEN = portalToken(env, "A");

const NO_INFORMATION =
  "There is no information in the provided document to answer this question.";

test.describe("grounding", () => {
  test.skip(
    fixtureUser(env, FIXTURE) === null || TOKEN === null,
    `needs a "${FIXTURE}" fixture user and ${missingTokenReason("A")}`,
  );
  test.skip(!portalBoundSessionAvailable(), PORTAL_BOUND_SESSION_REASON);

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

  test.afterAll(() => {
    api = null;
  });

  test("backend reports its own readiness", async ({ page }) => {
    const health = await readiness(page.request);

    expect(health, "/api/health/detail returned no body").not.toBeNull();
    expect(
      health!.storeReachable,
      "the backend cannot reach its isolated store — check `fusebase app update " +
        "<appId> --sync-gate-permissions --declare-backend-only-gate-permissions`",
    ).toBe(true);
    // The deployed app must be on the prod stage of the store.
    expect(health!.stage).toBe(env.config.backend === "prod" ? "prod" : "dev");
  });

  test("a question with nothing in scope returns the exact refusal and no citations", async () => {
    // A chat scoped to an explicitly empty document set: nothing can be retrieved.
    const created = await api!.post("/api/chats", {
      data: { title: "e2e grounding" },
    });
    expect(created.status()).toBe(201);
    const chatId = ((await created.json()) as { id: string }).id;

    try {
      const answer = await api!.post(`/api/chats/${chatId}/messages`, {
        data: {
          question: "What is the airspeed velocity of an unladen swallow?",
          documentIds: [],
        },
      });
      expect(answer.status(), await answer.text()).toBe(200);

      const body = (await answer.json()) as {
        message: { content: string; citations: unknown[]; grounded: boolean };
        retrieval: { usedCount: number; candidateCount: number };
      };

      expect(body.message.content.trim()).toBe(NO_INFORMATION);
      expect(body.message.citations).toHaveLength(0);
      expect(body.message.grounded).toBe(false);
      expect(body.retrieval.usedCount).toBe(0);
    } finally {
      await api!.delete(`/api/chats/${chatId}`);
    }
  });

  test("an exhausted monthly token budget refuses before any paid call", async ({
    page,
  }) => {

    // Settings are written through the ADMIN app now (§5C): this app configures
    // nothing. The behaviour under test is still a client-app behaviour — chat must
    // refuse before spending anything — so the fixture moved and the assertion did
    // not.
    const clientId = session!.clientId;
    const original = await readClientSettings(page, env, clientId);
    const originalBudget = original.monthlyTokenBudget ?? null;

    const created = await api!.post("/api/chats", {
      data: { title: "e2e budget" },
    });
    const chatId = ((await created.json()) as { id: string }).id;

    try {
      // A budget of 0 is reached by definition, whatever this month's usage is.
      await setClientSettings(page, env, clientId, { monthlyTokenBudget: 0 });

      const refused = await api!.post(`/api/chats/${chatId}/messages`, {
        data: { question: "anything at all" },
      });
      expect(refused.status()).toBe(429);
      expect(await refused.text()).toContain("budget");
    } finally {
      // Restore the tenant's real budget, then remove the chat. This runs against a
      // live organisation: a budget left at 0 would silently break their chat.
      await setClientSettings(page, env, clientId, {
        monthlyTokenBudget: originalBudget,
      });
      await api!.delete(`/api/chats/${chatId}`);
    }
  });

  // MOVED: "cost caps reject out-of-range values with a specific message".
  //
  // It asserted validation of `PATCH /api/session/settings`, a route §5C deleted from
  // this app — caps are an admin concern now. The assertion lives in
  // `specs/compass-admin/settings.spec.ts`, where it runs instead of skipping: the
  // admin app needs only a staff session, not the portal-bound session this suite
  // cannot obtain.
});
