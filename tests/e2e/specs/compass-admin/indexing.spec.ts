/**
 * Indexing health — moved here from `compass-ai` by §5C.
 *
 * The number that matters is `chunksEmbedded`: retrieval only reads passages that
 * have a vector, so a document reported as `indexed` with zero embedded passages
 * would be a lie the rest of the product depends on. That property did not change
 * when the screen moved; only which app owns it did.
 *
 * **Moving it turned dead coverage into live coverage.** The client-app version was
 * permanently skipped: it needed a portal-bound session, which Gate exposes no way to
 * mint. This one needs a staff session on the admin host, which the suite already
 * has — so the assertion actually runs, and it also caught that the fixtures were
 * still uploading through a route §5C had deleted.
 *
 * What did **not** come across: `POST /indexing/batches/:id/poll` and its "unknown
 * batch is a 404, never a 500" test. Those routes were not ported, because
 * production says they were never reachable — zero clients with batch embedding
 * enabled, zero embedding batches ever created — and they call OpenAI's Batch API,
 * which only the client backend is wired to. A test for a route that does not exist
 * is worse than no test: it looks like coverage.
 */

import { expect, test } from '@playwright/test'
import { resolveTargetEnvironment, fixtureUser, type TargetEnvironment } from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

interface IndexHealthDocument {
  documentId: string
  name: string
  status: string
  chunkCount: number
  chunksPresent: number
  chunksEmbedded: number
}

interface Snapshot {
  documents: IndexHealthDocument[]
  statusCounts: Record<string, number>
  jobs: Array<{ id: string; kind: string; status: string }>
  usageMonthToDate: { inputTokens: number; costUsd: number }
}

/** A syntactically valid one-page PDF whose bytes differ per run (dedupe is on content). */
function buildPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const object of objects) {
    offsets.push(body.length)
    body += `${object}\n`
  }
  const xrefStart = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body +=
    `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

test.describe('compass admin — indexing health', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  test('reports per-document health consistent with its own status summary', async ({
    page,
  }) => {
    // Uploading and waiting for the pipeline costs real time and one embedding call.
    test.setTimeout(240_000)

    await signInOrSkip(page, env, STAFF_FIXTURE)
    // The session cookie is per app host; without visiting this one the platform edge
    // answers 401 before the backend sees the request.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })

    const portals = (await (await page.request.get('/api/session/portals')).json()) as {
      portals: Array<{ id: string; label: string }>
    }
    test.skip(portals.portals.length === 0, 'no portals to read indexing health for')
    const portalRowId = portals.portals[0].id

    const stamp = Date.now().toString(36)
    const name = `e2e-indexing-${stamp}.pdf`
    let documentId: string | null = null
    let libraryId: string | null = null

    try {
      // Its own library, ticked to this portal. §6A.1 removed the client-scoped
      // upload, and this is also the arrangement that makes the assertion below
      // meaningful: the snapshot must reach a LIBRARY document, which is precisely
      // what a client-scoped snapshot could not see — a library document has
      // `client_id = NULL`, so the old query returned nothing at all for it.
      const created = await page.request.post('/api/libraries', {
        data: { name: `e2e-indexing-${stamp}` },
      })
      expect(created.status(), `create library -> ${await created.text()}`).toBe(201)
      libraryId = ((await created.json()) as { id: string }).id

      const tick = await page.request.put(`/api/libraries/${libraryId}/portals/${portalRowId}`)
      expect(tick.status(), `tick -> ${await tick.text()}`).toBe(200)

      const upload = await page.request.post(`/api/libraries/${libraryId}/documents`, {
        multipart: {
          files: {
            name,
            mimeType: 'application/pdf',
            buffer: buildPdf(`indexing health fixture ${new Date().toISOString()}`),
          },
        },
      })
      const uploadBody = await upload.text()
      expect(upload.status(), `upload -> ${upload.status()}: ${uploadBody.slice(0, 300)}`).toBe(201)

      const results = (JSON.parse(uploadBody) as {
        results: Array<{ documentId?: string; status: string; message?: string }>
      }).results
      expect(results[0].status, `upload outcome: ${results[0].message}`).toBe('queued')
      documentId = results[0].documentId ?? null
      expect(documentId, 'the queued document carried no id').toBeTruthy()

      const read = async (): Promise<Snapshot> => {
        const response = await page.request.get(
          `/api/indexing?portalRowId=${encodeURIComponent(portalRowId)}`,
        )
        expect(response.status(), await response.text()).toBe(200)
        return (await response.json()) as Snapshot
      }

      // Wait for the pipeline to settle so the embedded-passage assertion below is
      // about a finished document rather than a race.
      await expect
        .poll(
          async () => {
            const snapshot = await read()
            const row = snapshot.documents.find((entry) => entry.documentId === documentId)
            if (row?.status === 'failed') {
              throw new Error(`the fixture document failed to index: ${row.name}`)
            }
            return row?.status ?? 'missing'
          },
          {
            message: 'the fixture document never reached "indexed"',
            timeout: 180_000,
            intervals: [2_000, 3_000, 5_000],
          },
        )
        .toBe('indexed')

      const snapshot = await read()
      const row = snapshot.documents.find((entry) => entry.documentId === documentId)
      expect(row, 'the uploaded document is missing from the snapshot').toBeDefined()

      // A document can never report more embedded passages than it has.
      expect(row!.chunksEmbedded).toBeLessThanOrEqual(row!.chunksPresent)

      // The snapshot is one batched read, so the summary must agree with the rows it
      // came with. A disagreement means the four result sets did not come from one
      // transaction, and the screen would show numbers from different moments.
      const summed = Object.values(snapshot.statusCounts).reduce((total, n) => total + n, 0)
      expect(
        summed,
        'statusCounts and the document rows disagree — the snapshot is not a single consistent read',
      ).toBe(snapshot.documents.length)

      // The load-bearing invariant: anything reported as indexed must be citable.
      for (const document of snapshot.documents) {
        if (document.status === 'indexed') {
          expect(
            document.chunksEmbedded,
            `"${document.name}" is reported as indexed but has no embedded passages, so it cannot be cited`,
          ).toBeGreaterThan(0)
        }
      }

      expect(snapshot.jobs.length, 'the pipeline ran but reported no jobs').toBeGreaterThan(0)
      expect(snapshot.usageMonthToDate.costUsd).toBeGreaterThanOrEqual(0)
    } finally {
      if (documentId) {
        const deleted = await page.request.delete(`/api/documents/${documentId}`)
        expect(
          deleted.status(),
          `cleanup failed — a test document is left in a real portal: ${await deleted.text()}`,
        ).toBe(202)
      }
      if (libraryId) {
        // Untick first: while the tick stands, a real client sees this library.
        const unticked = await page.request.delete(
          `/api/libraries/${libraryId}/portals/${portalRowId}`,
        )
        expect(
          unticked.status(),
          `cleanup failed — an e2e library is still ticked to a real portal: ${await unticked.text()}`,
        ).toBe(200)

        // The library itself has now cost an embedding, and
        // `usage_events.library_id` is ON DELETE RESTRICT — so deletion is refused by
        // design and archiving is the fallback the API names.
        // `scripts/cleanup-e2e-libraries.mjs` clears these at the operator level.
        const gone = await page.request.delete(`/api/libraries/${libraryId}`)
        if (!gone.ok()) {
          const archived = await page.request.patch(`/api/libraries/${libraryId}`, {
            data: { archived: true },
          })
          expect(archived.status(), `could not archive: ${await archived.text()}`).toBe(200)
        }
      }
    }
  })

  test('refuses to report indexing health without a portal', async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })

    // Every route in this app is explicitly scoped. Defaulting to "all of them"
    // would be the friendlier behaviour and the wrong one: a screen that silently
    // shows another portal's documents is the failure this app exists to prevent.
    const response = await page.request.get('/api/indexing')
    expect(response.status(), 'indexing answered without a portalRowId').toBe(400)

    // And a `clientId` is no longer a scope: passing one alone must still be
    // refused, or the old callers would appear to work while reading nothing.
    const stale = await page.request.get(
      '/api/indexing?clientId=00000000-0000-0000-0000-000000000000',
    )
    expect(stale.status(), 'indexing accepted a clientId as its scope').toBe(400)
  })
})
