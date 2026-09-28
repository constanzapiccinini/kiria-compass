import { test, expect } from "@playwright/test";
import { fixtureUser, resolveTargetEnvironment } from "../../helpers/env";
import {
  buildPdf,
  deleteDocument,
  readiness,
  signInOrSkip,
  uploadPdf,
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
 * The real end-to-end path: upload -> index -> ask -> cited answer.
 *
 * Unlike citations.spec.ts, nothing here is seeded — the model actually answers. That
 * makes this the only spec that proves the whole pipeline, and the only one that
 * spends OpenAI tokens, so it self-skips when the key is not configured.
 */

const env = resolveTargetEnvironment();
const FIXTURE = "staff";
const TOKEN = portalToken(env, "A");

const FACT = "The coolant flow rate is maintained at 880 litres per minute.";

test.describe("grounded answer (real model)", () => {
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

  // Indexing an upload and generating an answer are both slow; this one spec gets a
  // longer budget rather than raising the timeout for the whole suite.
  test.setTimeout(240_000);

  test("answers from the document and cites the page the fact came from", async ({
    page,
  }) => {

    const health = await readiness(page.request);
    test.skip(
      health?.openAiConfigured !== true,
      "OPENAI_API_KEY is not configured for this deployment — indexing and answering " +
        "cannot run. Set it in the app's secrets, then re-run.",
    );

    let documentId: string | null = null;

    try {
      const uploaded = await uploadPdf(page, env, session!.clientId, "e2e-grounded.pdf",
        buildPdf(
          ["1. Cooling System", FACT, "The pump array is fully redundant."],
          ["2. Notes", "No further observations were recorded."],
        ),
      );
      documentId = uploaded.id;

      // Wait for a full index, not just extraction — retrieval needs embeddings.
      await expect
        .poll(
          async () => {
            const response = await api!.get(`/api/documents/${uploaded.id}`);
            if (!response.ok()) return "unreachable";
            const body = (await response.json()) as {
              document: { status: string; errorMessage: string | null };
            };
            if (body.document.status === "failed") {
              throw new Error(`indexing failed: ${body.document.errorMessage}`);
            }
            return body.document.status;
          },
          { timeout: 180_000, intervals: [2000], message: "document never reached 'indexed'" },
        )
        .toBe("indexed");

      const chat = await api!.post("/api/chats", {
        // No tenant key: the client comes from the verified portal context, and
        // sending one would be refused as a TENANCY_PROBE rather than ignored.
        data: { documentIds: [uploaded.id] },
      });
      expect(chat.status()).toBe(201);
      const chatId = ((await chat.json()) as { id: string }).id;

      try {
        const answered = await api!.post(`/api/chats/${chatId}/messages`, {
          data: { question: "What is the coolant flow rate?", documentIds: [uploaded.id] },
        });
        expect(answered.status(), await answered.text()).toBe(200);

        const body = (await answered.json()) as {
          message: {
            content: string;
            grounded: boolean;
            citations: Array<{ documentId: string; page: number; documentName: string }>;
          };
          retrieval: { usedCount: number };
        };

        // The fact is on page 1, so the answer must carry it and cite page 1.
        expect(body.retrieval.usedCount).toBeGreaterThan(0);
        expect(body.message.content).toMatch(/880/);
        expect(
          body.message.citations.length,
          "a grounded answer with no citation breaks the product's core promise",
        ).toBeGreaterThan(0);
        expect(body.message.grounded).toBe(true);

        for (const citation of body.message.citations) {
          expect(citation.documentId).toBe(uploaded.id);
          expect(citation.documentName).toBe("e2e-grounded.pdf");
          expect(citation.page).toBe(1);
        }
      } finally {
        await api!.delete(`/api/chats/${chatId}`);
      }
    } finally {
      if (documentId) await deleteDocument(page, env, documentId).catch(() => undefined);
    }
  });

  test("refuses a question the document cannot answer", async ({ page }) => {

    const health = await readiness(page.request);
    test.skip(
      health?.openAiConfigured !== true,
      "OPENAI_API_KEY is not configured for this deployment",
    );

    let documentId: string | null = null;

    try {
      const uploaded = await uploadPdf(page, env, session!.clientId, "e2e-refusal.pdf",
        buildPdf(["1. Cooling System", FACT], ["2. Notes", "Nothing further."]),
      );
      documentId = uploaded.id;

      await expect
        .poll(
          async () => {
            const response = await api!.get(`/api/documents/${uploaded.id}`);
            const body = (await response.json()) as { document: { status: string } };
            return body.document.status;
          },
          { timeout: 180_000, intervals: [2000] },
        )
        .toBe("indexed");

      const chat = await api!.post("/api/chats", {
        // No tenant key: the client comes from the verified portal context, and
        // sending one would be refused as a TENANCY_PROBE rather than ignored.
        data: { documentIds: [uploaded.id] },
      });
      const chatId = ((await chat.json()) as { id: string }).id;

      try {
        const answered = await api!.post(`/api/chats/${chatId}/messages`, {
          data: {
            question: "What is the CEO's home address?",
            documentIds: [uploaded.id],
          },
        });
        expect(answered.status()).toBe(200);

        const body = (await answered.json()) as {
          message: { content: string; grounded: boolean };
        };
        // Either retrieval found nothing, or the model correctly refused. Both must
        // end in the same refusal — and never in a fabricated address.
        expect(body.message.content).toContain("no information in the provided document");
        expect(body.message.grounded).toBe(false);
      } finally {
        await api!.delete(`/api/chats/${chatId}`);
      }
    } finally {
      if (documentId) await deleteDocument(page, env, documentId).catch(() => undefined);
    }
  });
});
