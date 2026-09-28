import { test, expect } from "@playwright/test";
import { fixtureUser, resolveTargetEnvironment } from "../../helpers/env";
import {
  buildPdf,
  deleteChat,
  deleteDocument,
  seedCitedAnswer,
  signInOrSkip,
  uploadPdf,
  waitForExtraction,
} from "../../helpers/compass";
import {
  missingTokenReason,
  openPortalApp,
  portalApi,
  portalSession,
  portalToken,
  type PortalApi,
  type PortalSession,
  portalBoundSessionOrSkip,
  portalBoundSessionAvailable,
  PORTAL_BOUND_SESSION_REASON,
} from "../../helpers/portal";

/**
 * The citation contract — the product's core promise.
 *
 * A citation must take the reader to the exact page and paragraph the claim came
 * from, and in a multi-document session it must resolve to the RIGHT document. A
 * citation that silently points at the wrong page or the wrong file is worse than no
 * citation at all, because it looks verified.
 *
 * The assistant turn is seeded (see helpers/compass.ts) so this runs without spending
 * OpenAI tokens; the real question -> answer path is covered by grounded-answer.spec.ts.
 */

const env = resolveTargetEnvironment();
const FIXTURE = "staff";
const TOKEN = portalToken(env, "A");

const REACTOR_FINDING =
  "The design margin exceeded the regulatory minimum by 18 percent across all tested load conditions.";
const TURBINE_FINDING =
  "Bearing wear was within tolerance at 0.04 millimetres after the full inspection interval.";

test.describe("citations", () => {
  test.skip(
    fixtureUser(env, FIXTURE) === null || TOKEN === null,
    `needs a "${FIXTURE}" fixture user and ${missingTokenReason("A")}`,
  );
  test.skip(!portalBoundSessionAvailable(), PORTAL_BOUND_SESSION_REASON);

  let api: PortalApi | null = null;
  let session: PortalSession | null = null;

  const created: { documentIds: string[]; chatIds: string[] } = {
    documentIds: [],
    chatIds: [],
  };

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, FIXTURE);
    api = portalApi(page.request, TOKEN as string);

    // These specs need a portal-BOUND session: they upload, index and read as an
    // employee inside a portal. Without this guard they failed with a raw
    // 401 PORTAL_SESSION_ANONYMOUS, which reads like a broken app rather than an
    // unobtainable fixture. Gate returns a userId only for a session minted through
    // the portal launcher, so this skips for the accurate reason — and runs the day
    // that changes.
    await portalBoundSessionOrSkip(api);
    session = await portalSession(api);
  });

  test.afterEach(async ({ page }) => {
    for (const chatId of created.chatIds) {
      await deleteChat(env, chatId).catch(() => undefined);
    }
    for (const documentId of created.documentIds) {
      await deleteDocument(page, env, documentId).catch(() => undefined);
    }
    created.chatIds = [];
    created.documentIds = [];
    api = null;
    session = null;
  });

  test("clicking a citation jumps to the cited page and highlights the paragraph", async ({
    page,
  }) => {

    const pdf = buildPdf(
      ["1. Reactor Operating Parameters", "The reactor runs at 450 degrees Celsius."],
      ["3. Conclusions", REACTOR_FINDING],
    );
    const uploaded = await uploadPdf(page, env, session!.clientId, "e2e-reactor.pdf", pdf);
    created.documentIds.push(uploaded.id);
    await waitForExtraction(api!, uploaded.id);

    // The paragraph key the citation points at must be a real one.
    const paragraphs = await page.request
      .get(`/api/documents/${uploaded.id}/paragraphs?page=2`)
      .then((response) => response.json() as Promise<{ paragraphs: Array<{ paragraphKey: string; text: string }> }>);
    const finding = paragraphs.paragraphs.find((paragraph) =>
      paragraph.text.includes("design margin"),
    );
    expect(finding, "page 2 has no paragraph containing the finding").toBeDefined();

    const chatId = await seedCitedAnswer(
      env,
      session!.clientId,
      session!.userId,
      "What was the design margin?",
      `- The design margin **exceeded the regulatory minimum by 18 percent** [e2e-reactor.pdf, Page 2]`,
      [
        {
          documentId: uploaded.id,
          documentName: "e2e-reactor.pdf",
          page: 2,
          paragraphKey: finding!.paragraphKey,
          sectionTitle: "3. Conclusions",
          snippet: REACTOR_FINDING,
        },
      ],
    );
    created.chatIds.push(chatId);

    await openPortalApp(page, TOKEN as string);
    await page.getByRole("button", { name: /Open Compass AI chat/ }).click();

    // The seeded conversation is restored, proving session restore too.
    await expect(page.getByText("What was the design margin?")).toBeVisible();

    const citation = page
      .getByRole("button", { name: /^Go to e2e-reactor\.pdf, page 2/ })
      .first();
    await expect(
      citation,
      "the inline citation did not render as a jump button — the label failed to " +
        "resolve against the backend citation list",
    ).toBeVisible();

    await citation.click();

    // The viewer must show this document, on page 2, with the paragraph outlined.
    await expect(page.locator("[data-viewer-title]")).toHaveAttribute(
      "data-viewer-title",
      "e2e-reactor.pdf",
    );
    await expect(page.getByText("2 / 2")).toBeVisible();

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const target = document.querySelector('[data-page="2"]');
            if (!target) return false;
            // The highlight overlay is the absolutely-positioned outlined child.
            return [...target.children].some((child) => {
              const style = window.getComputedStyle(child);
              return style.position === "absolute" && style.outlineStyle === "solid";
            });
          }),
        { message: "no highlight overlay appeared on the cited page" },
      )
      .toBe(true);
  });

  test("in a multi-document session each citation resolves to its own document", async ({
    page,
  }) => {

    const reactor = await uploadPdf(page, env, session!.clientId, "e2e-reactor-multi.pdf",
      buildPdf(["1. Reactor"], ["3. Conclusions", REACTOR_FINDING]),
    );
    created.documentIds.push(reactor.id);
    const turbine = await uploadPdf(page, env, session!.clientId, "e2e-turbine-multi.pdf",
      buildPdf(["1. Turbine"], ["3. Findings", TURBINE_FINDING]),
    );
    created.documentIds.push(turbine.id);

    await waitForExtraction(api!, reactor.id);
    await waitForExtraction(api!, turbine.id);

    const paragraphKeyFor = async (documentId: string, needle: string): Promise<string> => {
      const body = (await page.request
        .get(`/api/documents/${documentId}/paragraphs?page=2`)
        .then((response) => response.json())) as {
        paragraphs: Array<{ paragraphKey: string; text: string }>;
      };
      const match = body.paragraphs.find((paragraph) => paragraph.text.includes(needle));
      if (!match) throw new Error(`no paragraph containing "${needle}" on page 2`);
      return match.paragraphKey;
    };

    const chatId = await seedCitedAnswer(
      env,
      session!.clientId,
      session!.userId,
      "Compare the two reports.",
      "- The reactor report found the **design margin exceeded the minimum** " +
        "[e2e-reactor-multi.pdf, Page 2]\n" +
        "- The turbine report found **bearing wear within tolerance** " +
        "[e2e-turbine-multi.pdf, Page 2]",
      [
        {
          documentId: reactor.id,
          documentName: "e2e-reactor-multi.pdf",
          page: 2,
          paragraphKey: await paragraphKeyFor(reactor.id, "design margin"),
          sectionTitle: "3. Conclusions",
          snippet: REACTOR_FINDING,
        },
        {
          documentId: turbine.id,
          documentName: "e2e-turbine-multi.pdf",
          page: 2,
          paragraphKey: await paragraphKeyFor(turbine.id, "Bearing wear"),
          sectionTitle: "3. Findings",
          snippet: TURBINE_FINDING,
        },
      ],
    );
    created.chatIds.push(chatId);

    await openPortalApp(page, TOKEN as string);
    await page.getByRole("button", { name: /Open Compass AI chat/ }).click();
    await expect(page.getByText("Compare the two reports.")).toBeVisible();

    // Follow the turbine citation and confirm the viewer switched documents.
    await page
      .getByRole("button", { name: /^Go to e2e-turbine-multi\.pdf, page 2/ })
      .first()
      .click();
    await expect(page.locator("[data-viewer-title]")).toHaveAttribute(
      "data-viewer-title",
      "e2e-turbine-multi.pdf",
    );

    // The decisive assertion: the highlighted paragraph belongs to the turbine
    // report, not the reactor one. This is what catches cross-document mis-routing.
    const highlightedText = await page.evaluate(async () => {
      const documentId = document
        .querySelector("[data-viewer-doc-id]")
        ?.getAttribute("data-viewer-doc-id");
      const key = document
        .querySelector("[data-page='2'] [data-highlight-key]")
        ?.getAttribute("data-highlight-key");
      if (!documentId || !key) return null;
      const response = await fetch(`/api/documents/${documentId}/paragraphs?page=2`, {
        credentials: "include",
      });
      const body = (await response.json()) as {
        paragraphs: Array<{ paragraphKey: string; text: string }>;
      };
      return body.paragraphs.find((paragraph) => paragraph.paragraphKey === key)?.text ?? null;
    });
    expect(
      highlightedText,
      "could not read the highlighted paragraph — the overlay is missing its key",
    ).not.toBeNull();
    expect(highlightedText).toContain("Bearing wear");

    // And back the other way.
    await page
      .getByRole("button", { name: /^Go to e2e-reactor-multi\.pdf, page 2/ })
      .first()
      .click();
    await expect(page.locator("[data-viewer-title]")).toHaveAttribute(
      "data-viewer-title",
      "e2e-reactor-multi.pdf",
    );
  });
});
