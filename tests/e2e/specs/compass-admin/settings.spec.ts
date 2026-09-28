/**
 * Cost caps and budgets — moved here from `compass-ai` by §5C.
 *
 * Settings are an admin concern now: the client app configures nothing, for anyone.
 * The validation asserted here used to live in `grounding.spec.ts` against
 * `PATCH /api/session/settings`, a route this phase deleted — and it was permanently
 * skipped there, because that suite needs a portal-bound session Gate cannot mint.
 * Here it needs only a staff session, so it runs.
 *
 * Why the validation matters enough to test: every one of these values is a spending
 * limit or a retrieval bound, and the settings PATCH takes a JSON body. A cap that
 * silently accepted 99999 would let one form submission multiply a client's monthly
 * bill, and a cap that silently *ignored* a bad value would look like it applied.
 * Both failures are quiet, which is why the refusal has to name the field.
 */

import { expect, test } from '@playwright/test'
import { resolveTargetEnvironment, fixtureUser, type TargetEnvironment } from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

test.describe('compass admin — settings validation', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  test('rejects out-of-range caps and names the field, without changing anything', async ({
    page,
  }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE)
    // The session cookie is per app host; without visiting this one the platform edge
    // answers 401 before the backend sees the request.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })

    const portals = (await (await page.request.get('/api/session/portals')).json()) as {
      portals: Array<{ clientId: string; label: string }>
    }
    test.skip(portals.portals.length === 0, 'no portals to read settings for')
    const { clientId } = portals.portals[0]

    const read = async (): Promise<Record<string, unknown>> => {
      const response = await page.request.get(
        `/api/settings?clientId=${encodeURIComponent(clientId)}`,
      )
      expect(response.status(), await response.text()).toBe(200)
      return ((await response.json()) as { settings: Record<string, unknown> }).settings
    }

    const before = await read()

    // Each of these is out of the range the schema's CHECK constraints allow, so a
    // handler that passed it through would surface as a 500 from Postgres rather than
    // as something an operator can act on.
    const rejected: Array<[string, unknown]> = [
      ['maxAnswerTokens', 99999],
      ['maxRetrievedTokens', 1],
      ['maxOcrPagesPerUpload', 0],
      // §7.5 removed the retrieval mode entirely, so this is no longer "an invalid
      // value for a real setting" — it is a setting that does not exist. Both of the
      // properties this test cares about still hold, which is why it stays: a 400,
      // and a message that names the field. What changed is the reason, and the
      // message now says Precision is the only behaviour rather than listing the two
      // values it used to accept.
      ['retrievalMode', 'precision'],
      ['retrievalMode', 'economy'],
    ]

    const failures: string[] = []
    for (const [field, value] of rejected) {
      const response = await page.request.put(`/api/settings/clients/${clientId}`, {
        data: { [field]: value },
      })
      const body = await response.text()

      if (response.status() !== 400) {
        failures.push(`${field}=${JSON.stringify(value)} -> ${response.status()}, expected 400`)
        continue
      }
      // Naming the field is the point: "invalid settings" leaves an operator with a
      // form of eleven values and no idea which one to fix.
      if (!body.includes(field)) {
        failures.push(`${field} was refused but the message does not name it: ${body.slice(0, 160)}`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])

    // A refused write must change nothing. A handler that validated late could apply
    // some fields and then fail, leaving a tenant on a configuration nobody chose.
    expect(await read(), 'a refused settings write changed the stored values').toEqual(before)
  })
})
