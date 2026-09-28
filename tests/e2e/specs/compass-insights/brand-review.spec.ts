/**
 * Screenshot review for the KIRIA rebrand — Phase 9 §6.
 *
 * > Screenshot review, actually looked at. Playwright captures of the reading view, the
 * > chat with an answer and citations, an empty state and the admin's Libraries screen,
 * > in light and dark, at 1440 and 1024 — attached to the phase doc. A branding phase
 * > whose only evidence is "typecheck passed" has not been reviewed.
 *
 * So this spec's job is to **produce artefacts a person looks at**, not to assert. It
 * makes exactly two assertions, and both are about whether the screenshot is worth
 * looking at: that the page rendered at all, and that the brand blue is actually present
 * in the painted pixels. A green suite here means "there are pictures to review", never
 * "the brand is correct" — that judgement is not a machine's.
 *
 * ---------------------------------------------------------------------------
 * The font-blocked run (§6)
 *
 * > load the app with the woff2 blocked and confirm the fallback stack renders a usable
 * > layout with no shifted rows.
 *
 * This was vacuous when it was written — there was no woff2 to block, because the brand
 * assets had not arrived — and it is real now: the apps self-host one subset Nunito Sans
 * file and this run aborts it. Writing it while it could prove nothing is the reason it
 * did not have to be remembered and re-derived once the font landed.
 *
 * What it measures is the one thing that actually goes wrong when a webfont fails to
 * arrive: rows shifting, because the fallback has different metrics. A screenshot alone
 * would not show it — the page looks fine in both, just set in a different face.
 *
 * ---------------------------------------------------------------------------
 * Why it lives under compass-insights
 *
 * It has to reach all three apps, and only the cross-app project has no baseURL of its
 * own. Rather than add a project, it sits in a suite that already runs and builds
 * absolute URLs per app from the environment, the same way the portal specs do.
 */

import { expect, test, type Page } from '@playwright/test'
import {
  appBaseUrl,
  fixtureUser,
  resolveTargetEnvironment,
  type TargetEnvironment,
} from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

/** §6's two widths: a laptop and the narrow end of one. */
const WIDTHS = [1440, 1024] as const

/** KIRIA blue, as `rgb()` — what a browser reports for `#004AAD`. */
const BRAND_BLUE = 'rgb(0, 74, 173)'

/**
 * Assert the brand is actually painted, not merely defined.
 *
 * A theme file full of correct hexes proves nothing if a component never reads it —
 * that is precisely how the pre-brand `slate.950` survived in `ChatWidget` after the
 * ramp it referred to had been deleted. This walks the computed styles of everything on
 * screen and looks for the blue.
 */
async function brandBlueIsPainted(page: Page): Promise<boolean> {
  return page.evaluate((blue) => {
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(element)
      for (const property of [
        style.color,
        style.backgroundColor,
        style.borderTopColor,
        style.borderLeftColor,
        style.outlineColor,
        style.fill,
      ]) {
        if (property === blue) return true
      }
    }
    return false
  }, BRAND_BLUE)
}

/** Force a colour mode and let Chakra repaint before the shutter. */
async function inMode(page: Page, mode: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: mode })
  await page.waitForTimeout(250)
}

/** The painted page ground, which is what tells us whether a colour mode applied. */
async function pageGround(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor)
}

/**
 * DARK MODE IS NOT WIRED, AND THIS RECORDS THAT RATHER THAN HIDING IT.
 *
 * Phase 9 §7.4 opens with "the apps support it". They do not. Chakra v3 activates its
 * `_dark` conditions from a class that a colour-mode provider puts on the root, and no
 * app here has one — `next-themes` is a dependency of compass-ai and is imported
 * nowhere. So every `_dark` value in every theme and every component has been dead
 * code since it was written, and the rebrand's derived dark palette, though generated
 * and contrast-tested, currently renders for nobody.
 *
 * The screenshot review is what found it: the "dark" captures came back identical to
 * the light ones. Without this assertion the suite would keep producing pairs of
 * identical images under two names, which is worse than no evidence — it is evidence
 * that says something false.
 *
 * **When dark mode is wired, this assertion flips and should be inverted.** That is
 * deliberate: switching it on makes a large amount of never-rendered UI live at once,
 * and it should be reviewed then rather than discovered.
 */
const DARK_IS_WIRED = false

/**
 * Which colour modes are worth capturing.
 *
 * One, while DARK_IS_WIRED is false. §6 asks for "light and dark", and capturing both
 * produced two byte-identical files under two names — evidence that says something
 * false, which is worse than no evidence. The dark assertion below still runs on every
 * capture, so the day a provider is added the suite says so rather than silently
 * resuming a claim it could not previously support.
 */
const MODES = (DARK_IS_WIRED ? ['light', 'dark'] : ['light']) as ReadonlyArray<'light' | 'dark'>

test.describe('brand review captures', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  for (const width of WIDTHS) {
    for (const mode of MODES) {
      test(`insights overview — ${width} ${mode}`, async ({ page }) => {
        await signInOrSkip(page, env, STAFF_FIXTURE)
        await page.setViewportSize({ width, height: 900 })
        await inMode(page, mode)
        await page.goto('/', { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('#root', { timeout: 45_000 })
        // The rail and the first panel, rather than a fixed timeout: a screenshot of a
        // spinner is a screenshot nobody can review.
        await page.getByText('Compass Insights').first().waitFor({ timeout: 30_000 })
        // Wait for the data, not for a duration.
        //
        // Two bugs deep, this one. The first capture caught a spinner because there was
        // no wait. The second still caught it because the wait looked for 'Loading...'
        // and the component renders 'Loading…' with a real ellipsis — so the locator
        // matched nothing, reported zero, and passed. A regex over both forms now, and
        // the screenshots were re-read afterwards rather than trusted.
        await expect(page.getByText(/Loading[.…]/)).toHaveCount(0, { timeout: 45_000 })
        await page.waitForTimeout(600)

        const ground = await pageGround(page)
        await page.screenshot({
          path: `../../artifacts/brand/insights-overview-${width}-${mode}.png`,
          fullPage: false,
        })

        // rgb(1, 1, 4) is --ink, which is bg.canvas in dark mode. Checked on every
        // capture, not only the dark ones — while dark is unwired there ARE no dark
        // captures, and a guard that only runs in a mode that never runs is not a guard.
        const isDarkGround = ground === 'rgb(1, 1, 4)'
        {
          expect(
            isDarkGround,
            DARK_IS_WIRED
              ? 'dark mode is wired but the page ground is not --ink'
              : 'the page rendered DARK, which means a colour-mode provider has been ' +
                'added since Phase 9. Flip DARK_IS_WIRED in this spec and review every ' +
                '_dark value — none of them had ever rendered before.',
          ).toBe(DARK_IS_WIRED)
        }

        expect(
          await brandBlueIsPainted(page),
          'KIRIA blue does not appear in any computed style on this screen — the theme ' +
            'defines it but nothing on the page is reading it',
        ).toBe(true)
      })

      test(`insights review queue — ${width} ${mode}`, async ({ page }) => {
        await signInOrSkip(page, env, STAFF_FIXTURE)
        await page.setViewportSize({ width, height: 900 })
        await inMode(page, mode)
        await page.goto('/', { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('#root', { timeout: 45_000 })
        await page.getByRole('button', { name: 'Review' }).click()
        await expect(page.getByText(/Loading[.…]/)).toHaveCount(0, { timeout: 45_000 })
        await page.waitForTimeout(600)

        await page.screenshot({
          path: `../../artifacts/brand/insights-review-${width}-${mode}.png`,
          fullPage: false,
        })
      })
    }
  }

  /**
   * The fallback-font run.
   *
   * Vacuous today and wired anyway — see the file docblock. What it measures is the one
   * thing that actually goes wrong when a webfont fails: rows shifting, because the
   * fallback has different metrics and a layout built around the brand face's width
   * reflows. Comparing row geometry with and without the font is the check; a
   * screenshot alone would not show it.
   */
  test('the layout survives a blocked webfont', async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE)
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })
    await expect(page.getByText(/Loading[.…]/)).toHaveCount(0, { timeout: 45_000 })
    await page.waitForTimeout(600)
    const before = await page.evaluate(() => document.body.scrollHeight)

    // Everything a self-hosted brand face could be served as. None of these match
    // anything today, which is the point of asserting the outcome rather than the
    // interception.
    await page.route('**/*.{woff,woff2,ttf,otf}', (route) => route.abort())
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })
    await expect(page.getByText(/Loading[.…]/)).toHaveCount(0, { timeout: 45_000 })
    await page.waitForTimeout(600)
    const after = await page.evaluate(() => document.body.scrollHeight)

    await page.screenshot({ path: '../../artifacts/brand/insights-no-webfont-1440.png' })

    // A tolerance rather than equality: the page holds live data and a row can genuinely
    // differ between two loads. What this catches is a reflow, not a pixel.
    expect(
      Math.abs(after - before),
      'the page height moved when the webfont was blocked, so the fallback stack has ' +
        'different metrics to the brand face and rows shift for anyone whose network ' +
        'blocks it — the fallback needs adjusting, or a size-adjust descriptor',
    ).toBeLessThan(80)
  })
})

/**
 * The admin's Libraries screen — §6 names it explicitly.
 *
 * Absolute URL rather than the project's `baseURL`, which points at Insights. This is
 * the same thing the portal specs do, and it is the reason this file lives where it
 * does rather than in its own project.
 *
 * The client app's reading view and the chat-with-citations capture — the other two §6
 * asks for — are **not** here, and cannot be. Both need a portal-bound session, which
 * Gate cannot mint; it is the same blocker that skips ~24 client-app e2e tests and has
 * been recorded since Phase 7. The citation highlight is therefore the one part of this
 * rebrand that no automated capture can show, and it is the part that matters most, so
 * it needs a human to open a portal and look. That is written into the phase doc rather
 * than left as a gap somebody has to notice.
 */
test.describe('admin brand review', () => {
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  // The two screens §5 changed: each now has exactly one number in brand blue at 800,
  // and the point of capturing them is to check that the one chosen is the one an
  // operator actually opens the screen for.
  for (const screen of ['Indexing', 'Usage', 'Alerts'] as const) {
    test(`admin ${screen.toLowerCase()} — 1440`, async ({ page }) => {
      const adminUrl = appBaseUrl(env, 'compass-admin')
      await signInOrSkip(page, env, STAFF_FIXTURE)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(adminUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('#root', { timeout: 45_000 })
      const item = page.getByRole('button', { name: new RegExp(screen, 'i') }).first()
      await item.waitFor({ timeout: 30_000 })
      await item.click()
      await expect(page.getByText(/Loading[.…]/)).toHaveCount(0, { timeout: 45_000 })
      await page.waitForTimeout(800)
      await page.screenshot({
        path: `../../artifacts/brand/admin-${screen.toLowerCase()}-1440.png`,
        fullPage: false,
      })
    })
  }

  for (const width of WIDTHS) {
    test(`admin libraries — ${width}`, async ({ page }) => {
      const adminUrl = appBaseUrl(env, 'compass-admin')
      await signInOrSkip(page, env, STAFF_FIXTURE)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(adminUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('#root', { timeout: 45_000 })

      const libraries = page.getByRole('button', { name: /Libraries/i }).first()
      await libraries.waitFor({ timeout: 30_000 })
      await libraries.click()
      await expect(page.getByText(/Loading[.…]/)).toHaveCount(0, { timeout: 45_000 })
      await page.waitForTimeout(800)

      await page.screenshot({
        path: `../../artifacts/brand/admin-libraries-${width}.png`,
        fullPage: false,
      })

      expect(
        await brandBlueIsPainted(page),
        'KIRIA blue does not appear anywhere on the admin Libraries screen',
      ).toBe(true)
    })
  }
})
