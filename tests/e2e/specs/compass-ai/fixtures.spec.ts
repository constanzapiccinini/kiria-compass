/**
 * The fixture upload path itself.
 *
 * `uploadPdf` and `deleteDocument` are used by five specs that are all skipped for
 * want of a portal-bound session. So when §5C deleted `POST /api/documents` from the
 * client app, those fixtures broke and **nothing went red** — the specs were already
 * skipping before they ever reached the broken call. They would have failed for an
 * unrelated reason the day a portal-bound session became available, and whoever was
 * debugging that would have blamed the session work.
 *
 * This test exists so that cannot happen again. It exercises the fixture helpers on
 * their own, with no portal token and no portal-bound session, so it **runs** — and
 * fails loudly the next time the route those helpers depend on moves.
 *
 * It is a test of the harness rather than of the product, which is unusual and
 * deliberate: a fixture that silently stops working is worse than a missing test,
 * because it makes five other specs lie about why they failed.
 */

import { expect, test } from '@playwright/test'
import { appBaseUrl, fixtureUser, resolveTargetEnvironment, type TargetEnvironment } from '../../helpers/env'
import { buildPdf, deleteDocument, signInOrSkip, uploadPdf } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

test.describe('the fixture upload path', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  test('uploads and deletes a document through the admin app', async ({ page }) => {
    test.setTimeout(120_000)

    await signInOrSkip(page, env, STAFF_FIXTURE)

    // The tenancy key is read from the admin app rather than from a portal session:
    // this test is about the fixture plumbing, and requiring a portal-bound session
    // here would make it skip for exactly the reason it exists to work around.
    const adminBase = appBaseUrl(env, 'compass-admin')
    const adminPage = await page.context().newPage()
    let clientId: string
    try {
      await adminPage.goto(`${adminBase}/`, { waitUntil: 'domcontentloaded' })
      await adminPage.waitForSelector('#root', { timeout: 45_000 })
      // Absolute URL on purpose. `request` resolves a relative path against the
      // **project's** configured baseURL, which for this project is the CLIENT app —
      // the host that no longer has this route. Using a relative path here failed
      // with an undefined body, which is how the same mistake in the helper was found.
      const portals = (await (
        await adminPage.request.get(`${adminBase}/api/session/portals`)
      ).json()) as {
        portals: Array<{ clientId: string }>
      }
      test.skip(portals.portals.length === 0, 'no portals to upload for')
      clientId = portals.portals[0].clientId
    } finally {
      await adminPage.close()
    }

    // The helper opens its own page on the admin host inside this same browser
    // context, which is the part worth proving: the platform session cookie is per
    // app host, so a fixture that used a fresh request context would get a 401 from
    // the edge before the app saw anything.
    const uploaded = await uploadPdf(
      page,
      env,
      clientId,
      `e2e-fixture-path-${Date.now().toString(36)}.pdf`,
      buildPdf(['1. Fixture', 'Proves the fixture upload path still works.'], ['2. End', 'Done.']),
    )

    expect(uploaded.id, 'the fixture upload returned no document id').toBeTruthy()

    // Deleting is asserted rather than best-effort here: this suite runs against a
    // real organisation, and a leftover document is something a client can see.
    // The library goes with it. Without this second argument the fixture leaves an
    // `e2e-fixture-…` library ticked to a real client's portal, which is the residue
    // this suite has produced on production more than once.
    await deleteDocument(page, env, uploaded.id, uploaded.libraryId)
  })
})
