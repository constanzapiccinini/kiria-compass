/**
 * Admin upload — §9.4 and §6A.1, end to end.
 *
 * The one route in this app that writes a document, so it is the one that most needs
 * a real exercise rather than a shape assertion. It is checked against the pipeline's
 * own consequences: a job appears, and the document is reachable by the portal that
 * receives the library — because a document nobody can see is a bug that already
 * shipped once in the client app.
 *
 * §6A.1 removed the client-scoped upload and the `app_upload` source with it. This
 * spec used to assert `sourceKind === 'app_upload'`, which is precisely the fact the
 * phase deleted: a document reaches a portal through its **library** now, so what is
 * asserted instead is that the portal's admin preview resolves it and says which
 * library it came from. That is the same guarantee, stated where it now lives.
 *
 * The library is created here and ticked to one portal, rather than borrowing that
 * portal's private library: a spec that uploads into a real client's own files leaves
 * a test PDF in their portal for as long as the run takes, and the cleanup is the
 * only thing standing between that and forever.
 *
 * Cleans up after itself, and the cleanup is asserted. That is not politeness: this
 * runs against a live organisation.
 */

import { expect, test } from "@playwright/test";
import { resolveTargetEnvironment, fixtureUser, type TargetEnvironment } from "../../helpers/env";
import { signInOrSkip, buildPdf } from "../../helpers/compass";

const env: TargetEnvironment = resolveTargetEnvironment();
const STAFF_FIXTURE = "staff";

interface UploadOutcome {
  documentId?: string;
  status: string;
  message?: string;
}

/** The first registered portal, or null when this organisation has none. */
async function firstPortal(
  page: import("@playwright/test").Page,
): Promise<{ portalRowId: string; label: string } | null> {
  const response = await page.request.get("/api/portals");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    portals: Array<{ id?: string | null; name: string; registered?: boolean }>;
  };
  const portal = body.portals.find((row) => row.registered === true && row.id);
  return portal?.id ? { portalRowId: portal.id, label: portal.name } : null;
}

test.describe("compass admin — upload", () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`);

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE);
    // The session cookie is per app host; without visiting this one first the platform
    // edge answers 401 before the backend sees the request.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root", { timeout: 45_000 });
  });

  test("a PDF uploaded into a library is stored, queued and reaches the portal", async ({
    page,
  }) => {
    const portal = await firstPortal(page);
    test.skip(portal === null, "no registered portal to receive a library");

    const stamp = Date.now().toString(36);
    const libraryName = `e2e-upload-${stamp}`;
    const created = await page.request.post("/api/libraries", { data: { name: libraryName } });
    expect(created.status(), `create library -> ${await created.text()}`).toBe(201);
    const libraryId = ((await created.json()) as { id: string }).id;

    const name = `e2e-admin-upload-${stamp}.pdf`;
    // The BYTES must differ per run, not just the filename: dedupe is on content
    // hash, so a fixed body makes the second run report "duplicate" and fail on an
    // assertion about queueing. That is exactly what happened once.
    const pdf = buildPdf(
      ["1. Admin upload", `Uploaded through the admin app at ${new Date().toISOString()}.`],
      ["2. Detail", "It must reach the portal through its library, or nobody can see it."],
    );

    let documentId: string | null = null;
    try {
      const response = await page.request.post(`/api/libraries/${libraryId}/documents`, {
        multipart: { files: { name, mimeType: "application/pdf", buffer: pdf } },
      });
      const body = await response.text();
      expect([201, 207], `upload -> ${response.status()}: ${body.slice(0, 400)}`).toContain(
        response.status(),
      );

      const results = (JSON.parse(body) as { results: UploadOutcome[] }).results;
      expect(results.length, "no per-file outcome returned").toBe(1);
      expect(
        results[0].status,
        `expected the file to be queued, got ${JSON.stringify(results[0])}`,
      ).toBe("queued");
      documentId = String(results[0].documentId);
      expect(documentId).not.toBe("undefined");

      // It is in the library, with no folder — Unfiled, which the viewer renders as
      // a virtual node under this library rather than as a folder row.
      const listed = await page.request.get(`/api/libraries/${libraryId}/documents`);
      expect(listed.status()).toBe(200);
      const documents = (
        (await listed.json()) as { documents: Array<{ id: string; folderId: string | null }> }
      ).documents;
      const mine = documents.find((document) => document.id === documentId);
      expect(mine, "the uploaded document is not in the library").toBeTruthy();
      expect(mine?.folderId, "a fresh upload should be Unfiled").toBe(null);

      // Uploading the same bytes again must be recognised, not re-embedded.
      const again = await page.request.post(`/api/libraries/${libraryId}/documents`, {
        multipart: {
          files: { name: `copy-${name}`, mimeType: "application/pdf", buffer: pdf },
        },
      });
      const againResults = ((await again.json()) as { results: UploadOutcome[] }).results;
      expect(againResults[0]?.status, "identical content was not deduplicated").toBe("duplicate");

      // --- the consequence that actually matters --------------------------
      //
      // A tick, then the portal's own preview. This is the assertion that replaces
      // the old `sourceKind === 'app_upload'` one: what makes a document reachable is
      // no longer a source on the row but a binding on the library, and the preview
      // is the read that resolves it exactly as a viewer's request would.
      const tick = await page.request.put(
        `/api/libraries/${libraryId}/portals/${portal!.portalRowId}`,
      );
      expect(tick.status(), `tick -> ${await tick.text()}`).toBe(200);

      const preview = await page.request.get(`/api/portals/${portal!.portalRowId}/preview`);
      expect(preview.status()).toBe(200);
      const previewRows = (
        (await preview.json()) as { documents: Array<{ id: string; origin: string }> }
      ).documents;
      const reached = previewRows.find((row) => row.id === documentId);
      expect(
        reached,
        `the document did not reach ${portal!.label} even though its library is ticked`,
      ).toBeTruthy();
      expect(
        reached?.origin,
        "the preview cannot say how the document reached the portal",
      ).toContain(libraryName);
    } finally {
      // Documents first, then the library: deletion is refused while it still holds
      // anything, which is deliberate and would otherwise look like a flake here.
      if (documentId) {
        const removed = await page.request.delete(
          `/api/libraries/${libraryId}/documents/${documentId}`,
        );
        expect(
          removed.status(),
          `cleanup failed — a test document is still in ${libraryName}: ${await removed.text()}`,
        ).toBe(202);
      }

      // Untick before deleting: a ticked library cannot be deleted, and a leftover
      // tick is what would leave a real client looking at an e2e library.
      await page.request
        .delete(`/api/libraries/${libraryId}/portals/${portal!.portalRowId}`)
        .catch(() => undefined);

      // The library itself may legitimately refuse deletion once it has cost
      // anything — `usage_events.library_id` is ON DELETE RESTRICT — so this is not
      // asserted. Archiving is the fallback the API names, and
      // `scripts/cleanup-e2e-libraries.mjs` clears these at the operator level.
      const gone = await page.request.delete(`/api/libraries/${libraryId}`);
      if (!gone.ok()) {
        await page.request.patch(`/api/libraries/${libraryId}`, { data: { archived: true } });
      }
    }
  });

  test("a non-PDF is refused per file, not as a failed request", async ({ page }) => {
    const stamp = Date.now().toString(36);
    const created = await page.request.post("/api/libraries", {
      data: { name: `e2e-reject-${stamp}` },
    });
    expect(created.status(), `create library -> ${await created.text()}`).toBe(201);
    const libraryId = ((await created.json()) as { id: string }).id;

    try {
      const response = await page.request.post(`/api/libraries/${libraryId}/documents`, {
        multipart: {
          files: {
            name: "not-a-pdf.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("this is plainly not a PDF"),
          },
        },
      });

      // 207, not 4xx: the request was well-formed and the per-file reason is the
      // useful part. A 400 would discard it.
      expect(response.status(), "a refused file should not fail the whole request").toBe(207);

      const results = ((await response.json()) as { results: UploadOutcome[] }).results;
      expect(results[0]?.status).toBe("rejected");
      expect(String(results[0]?.message)).toContain("PDF");
    } finally {
      // Nothing was stored, so this library is empty and deletion must succeed.
      const gone = await page.request.delete(`/api/libraries/${libraryId}`);
      expect(gone.status(), `cleanup failed: ${await gone.text()}`).toBe(200);
    }
  });
});
