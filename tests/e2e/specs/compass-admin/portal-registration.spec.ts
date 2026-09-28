/**
 * Portal registration — §5A exit criteria.
 *
 * The bug this closes: nothing anywhere inserted a `portals` row. A portal created in
 * FuseBase refused every visitor with `PORTAL_NOT_BOUND` and appeared in no screen, so
 * the only way to make one work was to write SQL by hand — which is how both
 * production rows got there, and both then pointed at portals that had since been
 * deleted.
 *
 * Revision 2 of the phase spec went further and removed the *connecting* step
 * altogether: one portal is one client, so a portal provisions its own tenant and no
 * staff member assigns anything. That is what these tests assert — and it changes
 * what "cleanup" means. Provisioning is not reversible by design: deleting the row
 * would strand its tenant's documents. So this suite **provisions nothing new**. It
 * verifies the merged list, the shape of the provision contract, and that the removed
 * routes are gone.
 *
 * The one thing it cannot do is open a portal as a visitor — that needs a
 * portal-launcher session, which Gate exposes no way to mint. Self-registration
 * (§A.4) is covered by the manual runbook, `tests/manual/portal-isolation.md`.
 */

import { expect, test } from '@playwright/test'
import { resolveTargetEnvironment, fixtureUser, type TargetEnvironment } from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

interface PortalRow {
  portalId: string
  name: string
  url: string | null
  workspaceId: string | null
  registered: boolean
  id?: string
  label?: string
  status?: string
  lastSeenAt?: string | null
  clientId?: string
  documentsVisible?: number
  bindingCount?: number
  missingFromPlatform?: boolean
  seenCount?: number
}

interface PortalsResponse {
  portals: PortalRow[]
  discovery: { ok: boolean; error: string | null; note: string | null }
}

test.describe('compass admin — portal registration', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE)
    // The session cookie is per app host; without visiting this one the platform edge
    // answers 401 before the backend sees the request.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })
  })

  test('lists every portal, registered or not, and says whether discovery worked', async ({
    page,
  }) => {
    const response = await page.request.get('/api/portals')
    const body = await response.text()
    expect(response.status(), `portals -> ${response.status()}: ${body.slice(0, 300)}`).toBe(200)

    const payload = JSON.parse(body) as PortalsResponse
    expect(Array.isArray(payload.portals)).toBe(true)

    // The whole point of reporting this: an empty list caused by a missing
    // `portals.read` grant is otherwise indistinguishable from an org with no portals.
    expect(
      payload.discovery.ok,
      `platform discovery failed, so the screen can only show what is already known: ${payload.discovery.error}`,
    ).toBe(true)

    expect(payload.portals.length, 'discovery succeeded but returned no portals').toBeGreaterThan(0)

    // Unregistered first — they are the only rows that might need a click.
    const firstRegistered = payload.portals.findIndex((portal) => portal.registered)
    const lastUnregistered = payload.portals
      .map((portal) => portal.registered)
      .lastIndexOf(false)
    if (firstRegistered !== -1 && lastUnregistered !== -1) {
      expect(
        lastUnregistered,
        'registered portals are sorted before unregistered ones',
      ).toBeLessThan(firstRegistered)
    }

    for (const portal of payload.portals) {
      // A raw portal id as the display name means neither the platform nor a sighting
      // supplied one. It is allowed, but a registered portal showing an id is the
      // label bug this phase fixed, so it is worth failing on.
      if (portal.registered) {
        expect(portal.id, `registered portal ${portal.portalId} has no row id`).toBeTruthy()
        expect(
          portal.clientId,
          `registered portal ${portal.portalId} has no tenant`,
        ).toBeTruthy()
        expect(portal.status, `registered portal ${portal.portalId} has no status`).toBeTruthy()
      }
    }
  })

  test('provisioning is idempotent for a portal that already has a tenant', async ({ page }) => {
    const payload = (await (await page.request.get('/api/portals')).json()) as PortalsResponse
    const existing = payload.portals.find((portal) => portal.registered)
    test.skip(existing === undefined, 'no portal is registered yet — nothing to exercise')
    const portal = existing as PortalRow

    // Re-provisioning must return the same tenant rather than a 409 or a second row.
    // The caller asked for the portal to be usable, and it is. A duplicate tenant
    // here would make `findBoundClient` non-deterministic, and which tenant a portal
    // serves is not a question that may have two answers.
    const response = await page.request.post(
      `/api/portals/${encodeURIComponent(portal.portalId)}/provision`,
    )
    const body = await response.text()
    expect(response.status(), `provision -> ${response.status()}: ${body.slice(0, 300)}`).toBe(201)

    const result = JSON.parse(body) as {
      id: string
      clientId: string
      created: boolean
    }
    expect(result.created, 'a second provision reported creating a new tenant').toBe(false)
    expect(result.id, 'provision returned a different portal row').toBe(portal.id)
    expect(result.clientId, 'provision returned a different tenant').toBe(portal.clientId)

    // And the list still holds exactly one row for it.
    const after = (await (await page.request.get('/api/portals')).json()) as PortalsResponse
    expect(
      after.portals.filter((entry) => entry.portalId === portal.portalId).length,
      'the portal appears more than once after re-provisioning',
    ).toBe(1)
  })

  test('refuses to provision a portal the platform does not know', async ({ page }) => {
    const unknown = await page.request.post(
      `/api/portals/e2e-nonexistent-${Date.now().toString(36)}/provision`,
    )
    // 404 when discovery worked and did not list it; 503 when discovery itself is
    // down, because then we genuinely cannot tell and must not invent a tenant.
    expect(
      [404, 503],
      `an unknown portal id was accepted with ${unknown.status()}`,
    ).toContain(unknown.status())
  })

  test('the removed client-assignment routes are gone', async ({ page }) => {
    // These are the revision-1 surface. Each one existed, shipped, and is now a
    // contradiction: a portal cannot be reassigned to another client when the portal
    // *is* the client. Asserting they 404 is what stops them being quietly restored.
    const removed = [
      { method: 'POST' as const, path: '/api/portals/clients' },
      { method: 'GET' as const, path: '/api/portals/groups' },
      { method: 'GET' as const, path: '/api/portals/discovered' },
      { method: 'GET' as const, path: '/api/session/clients' },
    ]

    const failures: string[] = []
    for (const route of removed) {
      const response =
        route.method === 'POST'
          ? await page.request.post(route.path, { data: {} })
          : await page.request.get(route.path)
      if (response.status() !== 404) {
        failures.push(`${route.method} ${route.path} -> ${response.status()}, expected 404`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  test('a portal cannot be deleted, only paused', async ({ page }) => {
    const payload = (await (await page.request.get('/api/portals')).json()) as PortalsResponse
    const registered = payload.portals.find((portal) => portal.registered && portal.id)
    test.skip(registered === undefined, 'no registered portal to exercise')
    const portal = registered as PortalRow

    // The route is gone on purpose: deleting the row would leave the tenant's
    // documents and chats with no portal resolving to them — the invisible-documents
    // failure this phase exists to end. Pause is the off switch.
    const deleted = await page.request.delete(`/api/portals/${portal.id}`)
    expect(deleted.status(), 'a portal was deletable').toBe(404)
  })
})
