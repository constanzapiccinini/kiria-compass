/**
 * Libraries — §5B end to end, against the deployed app.
 *
 * The whole offer shape in one test: create a library, upload a PDF into it once,
 * tick a portal, tick a second one, untick, and clean up. What it asserts is the
 * part that can be asserted synchronously — the grant, the refusals, and the fact
 * that a second portal costs nothing.
 *
 * What it deliberately does NOT assert is that a portal's viewer *sees* the document.
 * That needs the document to finish indexing (async, minutes) and a portal-bound
 * session to read it as a viewer (impossible to mint — see
 * `tests/manual/portal-isolation.md`). The visibility resolution itself is proven
 * against the database by `scripts/verify-library-rls.mjs`, in both directions and
 * with counts. Splitting it this way keeps each half provable rather than leaving
 * both half-checked.
 *
 * Cleanup is asserted, not best-effort. A library left ticked to a real portal would
 * hand a real client documents nobody meant to give them, which is worse than a
 * failing test — so the teardown runs in a `finally` and its own success is checked.
 */

import { expect, test } from '@playwright/test'
import { resolveTargetEnvironment, fixtureUser, type TargetEnvironment } from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

interface LibraryPortal {
  portalRowId: string
  label: string
  status: string
}

interface LibraryRow {
  id: string
  name: string
  description: string | null
  archivedAt: string | null
  documentCount: number
  pageCount: number
  indexedCount: number
  portals: LibraryPortal[]
}

interface UploadOutcome {
  name: string
  documentId?: string
  status: 'queued' | 'duplicate' | 'rejected'
  message?: string
}

/**
 * A syntactically valid one-page PDF whose bytes differ per run.
 *
 * The bytes must differ, not just the filename: dedupe is on content hash, so a
 * fixed body makes the second run report "duplicate" and fail an assertion about
 * queueing. That is exactly what happened once with the portal upload spec.
 */
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

test.describe('compass admin — libraries', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE)
    // The session cookie is per app host; without visiting this one the platform edge
    // answers 401 before the backend sees the request.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })
  })

  test('one upload, two portals, no second embedding — and every refusal on the way', async ({
    page,
  }) => {
    const stamp = Date.now().toString(36)
    const name = `e2e-library-${stamp}`

    // Sweep the fixtures an earlier run could not delete.
    //
    // Only the ones that never cost anything can go from here. A library that has
    // been embedded holds `usage_events`, and those are ON DELETE RESTRICT on
    // purpose: deleting the library would erase money that was really spent from the
    // usage screen's arithmetic. Such a library can only ever be archived, which is
    // the product rule — and it means this suite leaves one permanent archived row
    // per run. `scripts/cleanup-e2e-libraries.mjs` removes those with the operator
    // token, which is the right level for deleting test data that the app itself
    // must not be able to destroy.
    const existing = (await (await page.request.get('/api/libraries')).json()) as {
      libraries: LibraryRow[]
    }
    for (const stale of existing.libraries) {
      if (!/^e2e-library-/.test(stale.name)) continue
      if (stale.documentCount > 0 || stale.portals.length > 0) continue
      await page.request.delete(`/api/libraries/${stale.id}`)
    }

    const created = await page.request.post('/api/libraries', { data: { name } })
    const createdBody = await created.text()
    expect(created.status(), `create -> ${created.status()}: ${createdBody.slice(0, 300)}`).toBe(201)
    const libraryId = (JSON.parse(createdBody) as { id: string }).id

    let documentId: string | null = null
    const tickedPortals: string[] = []

    try {
      // A duplicate name is a mistake worth naming, not a second library that looks
      // identical in every list.
      const duplicate = await page.request.post('/api/libraries', { data: { name } })
      expect(duplicate.status(), 'a duplicate library name was accepted').toBe(409)

      // --- upload once -----------------------------------------------------
      const upload = await page.request.post(`/api/libraries/${libraryId}/documents`, {
        multipart: {
          files: {
            name: `${name}.pdf`,
            mimeType: 'application/pdf',
            buffer: buildPdf(`library fixture ${new Date().toISOString()}`),
          },
        },
      })
      const uploadBody = await upload.text()
      expect(upload.status(), `upload -> ${upload.status()}: ${uploadBody.slice(0, 400)}`).toBe(201)

      const results = (JSON.parse(uploadBody) as { results: UploadOutcome[] }).results
      expect(results).toHaveLength(1)
      expect(results[0].status, `upload outcome: ${results[0].message}`).toBe('queued')
      documentId = results[0].documentId ?? null
      expect(documentId, 'the queued document carried no id').toBeTruthy()

      // A library document with no client_id is the point of migration 0013: before
      // it, `documents.client_id` was NOT NULL and this insert was impossible.
      const listed = (await (
        await page.request.get(`/api/libraries/${libraryId}/documents`)
      ).json()) as { documents: Array<{ id: string; name: string }> }
      expect(
        listed.documents.some((entry) => entry.id === documentId),
        'the uploaded document is not in the library',
      ).toBe(true)

      // --- it actually indexes ---------------------------------------------
      //
      // The load-bearing assertion of this whole phase, and the one that could not
      // be inferred: a library document has no `client_id`, so every derived row the
      // pipeline writes — pages, paragraphs, chunks, the parse job itself, the usage
      // event — had to be taught to carry `library_id` instead. Migration 0013's XOR
      // check refuses a row with neither, so a single missed site does not degrade
      // gracefully: the parse fails outright.
      //
      // Polled rather than assumed, and against the real worker in the client app,
      // because that is the only thing that proves the refactor.
      const indexed = await expect
        .poll(
          async () => {
            const payload = (await (
              await page.request.get(`/api/libraries/${libraryId}/documents`)
            ).json()) as {
              documents: Array<{
                id: string
                status: string
                errorMessage: string | null
                chunkCount: number
              }>
            }
            const row = payload.documents.find((entry) => entry.id === documentId)
            // A failure is terminal — surface its message instead of polling until
            // the timeout and reporting nothing useful.
            if (row?.status === 'failed') {
              throw new Error(`the library document failed to index: ${row.errorMessage}`)
            }
            return row?.status ?? 'missing'
          },
          {
            message: 'the library document never reached "indexed"',
            timeout: 180_000,
            intervals: [2_000, 3_000, 5_000],
          },
        )
        .toBe('indexed')
        .then(async () => {
          const payload = (await (
            await page.request.get(`/api/libraries/${libraryId}/documents`)
          ).json()) as { documents: Array<{ id: string; pageCount: number | null; chunkCount: number }> }
          return payload.documents.find((entry) => entry.id === documentId)
        })

      expect(indexed?.pageCount, 'an indexed library document has no pages').toBe(1)
      expect(
        indexed?.chunkCount,
        'an indexed library document has no passages, so nothing could ever cite it',
      ).toBeGreaterThan(0)

      // Non-PDF content is refused per file, and the request itself still succeeds —
      // 207, never a 4xx, or the per-file reason is discarded by the client.
      const rejected = await page.request.post(`/api/libraries/${libraryId}/documents`, {
        multipart: {
          files: {
            name: 'not-a-pdf.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from('this is not a pdf', 'utf8'),
          },
        },
      })
      expect(rejected.status(), 'a non-PDF was not reported per file').toBe(207)
      const rejectedResults = (JSON.parse(await rejected.text()) as { results: UploadOutcome[] })
        .results
      expect(rejectedResults[0].status).toBe('rejected')

      // --- who gets it -----------------------------------------------------
      const portals = (await (await page.request.get('/api/session/portals')).json()) as {
        portals: Array<{ id: string; label: string }>
      }
      test.skip(portals.portals.length === 0, 'no portals exist to tick')

      const first = portals.portals[0]
      const tick = await page.request.put(`/api/libraries/${libraryId}/portals/${first.id}`)
      expect(tick.status(), `tick -> ${tick.status()}: ${await tick.text()}`).toBe(200)
      tickedPortals.push(first.id)

      const afterTick = await readLibrary(page, libraryId)
      expect(
        afterTick.portals.map((portal) => portal.portalRowId),
        'the ticked portal is not listed as receiving the library',
      ).toContain(first.id)

      // Ticking twice is the same state, not an error: whether a portal receives a
      // library is a boolean, and a repeated click means "on".
      const again = await page.request.put(`/api/libraries/${libraryId}/portals/${first.id}`)
      expect(again.status(), 'a repeated tick was refused').toBe(200)
      const afterAgain = await readLibrary(page, libraryId)
      expect(
        afterAgain.portals.filter((portal) => portal.portalRowId === first.id),
        'a repeated tick created a second grant',
      ).toHaveLength(1)

      // --- a second portal costs nothing ------------------------------------
      const second = portals.portals[1]
      if (second) {
        const before = await readLibrary(page, libraryId)
        const tickSecond = await page.request.put(
          `/api/libraries/${libraryId}/portals/${second.id}`,
        )
        expect(tickSecond.status()).toBe(200)
        tickedPortals.push(second.id)

        const after = await readLibrary(page, libraryId)
        expect(after.portals.map((portal) => portal.portalRowId)).toContain(second.id)
        // The cost argument, asserted: giving a library to another portal adds a
        // grant, not a document and not an embedding run.
        expect(after.documentCount, 'the document count changed when a portal was added').toBe(
          before.documentCount,
        )
      }

      // --- deleting is refused while it is in use ---------------------------
      const refusedWhileTicked = await page.request.delete(`/api/libraries/${libraryId}`)
      const refusalBody = await refusedWhileTicked.text()
      expect(
        refusedWhileTicked.status(),
        `a library in use was deletable: ${refusalBody.slice(0, 200)}`,
      ).toBe(409)
      // The refusal has to name what to untick, or it is a dead end.
      expect(refusalBody, 'the refusal did not name the portal').toContain(first.label)

      // --- untick ------------------------------------------------------------
      for (const portalRowId of [...tickedPortals]) {
        const untick = await page.request.delete(
          `/api/libraries/${libraryId}/portals/${portalRowId}`,
        )
        expect(untick.status(), `untick -> ${untick.status()}`).toBe(200)
        tickedPortals.splice(tickedPortals.indexOf(portalRowId), 1)
      }

      const afterUntick = await readLibrary(page, libraryId)
      expect(afterUntick.portals, 'the library still goes to a portal after unticking').toEqual([])
      // Unticking revokes access and destroys nothing — that is the whole difference
      // between untick and delete.
      expect(afterUntick.documentCount, 'unticking removed documents').toBeGreaterThan(0)

      // --- and still refused while it holds documents ------------------------
      const refusedWhileFull = await page.request.delete(`/api/libraries/${libraryId}`)
      expect(
        refusedWhileFull.status(),
        'a library holding documents was deletable',
      ).toBe(409)
    } finally {
      // Untick anything still ticked, then empty it, then delete it. Order matters:
      // `library_id` is ON DELETE RESTRICT, so the library cannot go first.
      const failures: string[] = []

      for (const portalRowId of tickedPortals) {
        const response = await page.request.delete(
          `/api/libraries/${libraryId}/portals/${portalRowId}`,
        )
        if (response.status() !== 200) {
          failures.push(`portal ${portalRowId} left ticked (${response.status()})`)
        }
      }

      const remaining = (await (
        await page.request.get(`/api/libraries/${libraryId}/documents`)
      ).json()) as { documents: Array<{ id: string; deletedAt: string | null }> }
      for (const document of remaining.documents.filter((entry) => entry.deletedAt === null)) {
        const response = await page.request.delete(
          `/api/libraries/${libraryId}/documents/${document.id}`,
        )
        if (response.status() !== 202) {
          failures.push(`document ${document.id} not deleted (${response.status()})`)
        }
      }

      // Archive is the terminal state, not a fallback.
      //
      // This library has been embedded, so it holds a `usage_events` row and the API
      // refuses to delete it — with a 409 that says to archive instead. That refusal
      // is the product behaving correctly (cost history outlives the library), so
      // the teardown asserts the refusal rather than treating it as a failure, and
      // then does the thing the refusal recommends.
      const deleted = await page.request.delete(`/api/libraries/${libraryId}`)
      if (deleted.status() !== 409) {
        failures.push(
          `deleting a library with cost history returned ${deleted.status()}, expected a ` +
            `409 explaining that it can only be archived`,
        )
      }

      const archived = await page.request.patch(`/api/libraries/${libraryId}`, {
        data: { archived: true, name: `${name}-teardown` },
      })
      if (archived.status() !== 200) {
        failures.push(`the fixture library is still offered in pickers (${archived.status()})`)
      }

      expect(failures, `cleanup left state behind:\n${failures.join('\n')}`).toEqual([])
    }
  })

  test('refuses a source id that is not a library', async ({ page }) => {
    // This used to borrow a real `app_upload` source id from `GET /api/sources`,
    // which was the strongest form of the check: a valid `document_sources` row of
    // the wrong kind. §6A.1 removed that route and the kind along with it, so there
    // is no longer any way to obtain such an id through the API.
    //
    // What is left is the weaker half — a well-formed id that names nothing — plus a
    // note about what is no longer covered. The `kind = 'library'' clause in
    // `loadLibrary` still matters: legacy `app_upload` rows are still in the
    // database until 6B retires them, and they are exactly what it refuses. That
    // path is covered by `scripts/verify-library-rls.mjs` at the SQL level, which
    // can see rows the API cannot name.
    const response = await page.request.get(
      '/api/libraries/00000000-0000-0000-0000-000000000000/documents',
    )
    expect(response.status(), 'a non-library id was accepted as a library').toBe(404)
  })
})

/** Read one library out of the list, failing clearly when it is missing. */
async function readLibrary(
  page: import('@playwright/test').Page,
  libraryId: string,
): Promise<LibraryRow> {
  const response = await page.request.get('/api/libraries')
  expect(response.status()).toBe(200)
  const payload = (await response.json()) as { libraries: LibraryRow[] }
  const found = payload.libraries.find((library) => library.id === libraryId)
  expect(found, `library ${libraryId} vanished from the list`).toBeTruthy()
  return found as LibraryRow
}
