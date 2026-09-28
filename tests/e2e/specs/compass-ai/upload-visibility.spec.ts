/**
 * An uploaded document must be visible to the client who owns it.
 *
 * This spec exists because that failed silently on production for a day, and every
 * other test passed while it did.
 *
 * Migration v4 made `portal_visible_documents` resolve visibility through
 * `documents.source_id`, and its backfill gave every *existing* document a source.
 * The upload route was never taught to set one, so each new upload landed with
 * `source_id = NULL` and was visible in **zero** portals — indexed, paid for, and
 * unreachable by any client.
 *
 * What made it invisible to us as well as to them: an employee's document list
 * deliberately does not go through the view (§6.5), because staff must still see rows
 * that are processing, failed, or orphaned. So the person who uploaded the file saw it
 * immediately, in the sidebar, with a green "Ready" dot. Only a client would have
 * noticed — by not seeing it.
 *
 * The assertion is therefore about the *client's* view specifically, not "the document
 * exists". It is the same distinction the bug turned on.
 */

import { expect, test } from '@playwright/test'
import { resolveTargetEnvironment, fixtureUser, type TargetEnvironment } from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'
import {
  portalApi,
  portalBoundSessionOrSkip,
  portalToken,
  missingTokenReason,
  type PortalApi,
  type PortalSession,
  portalBoundSessionAvailable,
  PORTAL_BOUND_SESSION_REASON,
} from '../../helpers/portal'
import { uploadPdf, buildPdf } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const FIXTURE = 'staff'
const token = portalToken(env, 'A')

test.describe('uploaded documents are visible to the client', () => {
  test.skip(
    fixtureUser(env, FIXTURE) === null || token === null,
    `needs a "${FIXTURE}" fixture and a portal token — ${missingTokenReason('A')}`,
  )
  test.skip(!portalBoundSessionAvailable(), PORTAL_BOUND_SESSION_REASON)

  let api: PortalApi | null = null
  let session: PortalSession | null = null

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, FIXTURE)
    api = portalApi(page.request, token as string)
    session = await portalBoundSessionOrSkip(api)
  })

  test('a freshly uploaded document is returned by the client-scoped list', async ({ page }) => {
    const scoped = api as PortalApi

    const name = `e2e-visibility-${Date.now().toString(36)}.pdf`
    // Uploaded through the admin app, which is where uploads live after §5C. The
    // point of the test is unchanged: the CLIENT-scoped list, resolved through the
    // visibility view, must return it — a NULL source_id would hide it from every
    // viewer however well it indexed.
    const uploaded = await uploadPdf(
      page,
      env,
      session!.clientId,
      name,
      buildPdf(
        ['1. Visibility', 'This document must be visible to the client who owns it.'],
        ['2. Detail', 'A NULL source_id would hide this from every client.'],
      ),
    )
    expect(uploaded.id, 'upload returned no document id').toBeTruthy()

    // The employee list is NOT the check. It bypasses the visibility view by design,
    // so it returned the document even while it was invisible to every client — which
    // is exactly why the original bug went unnoticed.
    const list = await scoped.get('/api/documents')
    expect(list.status()).toBe(200)

    const payload: unknown = await list.json()
    const documents =
      typeof payload === 'object' && payload !== null && 'documents' in payload
        ? ((payload as { documents: unknown }).documents as Array<{ id?: unknown }>)
        : []

    // The real assertion: the document resolves through the portal, which is what the
    // client-scoped read joins. `loadOwnedDocument` for a client actor goes through
    // `portal_visible_documents`, so a document with no source 404s here.
    const fetched = await scoped.get(`/api/documents/${uploaded.id}`)
    expect(
      fetched.status(),
      `the uploaded document is not visible through the portal (${fetched.status()}). ` +
        'A NULL documents.source_id is the usual cause: portal_visible_documents joins it.',
    ).toBe(200)

    expect(
      documents.some((document) => document.id === uploaded.id),
      'the uploaded document is missing from the document list',
    ).toBe(true)
  })
})
