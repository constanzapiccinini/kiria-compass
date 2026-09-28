/**
 * The app shell does not scroll sideways, at three viewports — §7.8.
 *
 * ---------------------------------------------------------------------------
 * What this can assert, and the honest limit
 *
 * §7.8 asks for the real thing: open a document, assert the rendered page is no wider
 * than its scroll container, expand the chat and assert it does not intersect the
 * page canvas, collapse the sidebar and assert the page re-fits. Every one of those
 * needs a **document open in the viewer**, which needs a portal-bound session — and
 * Gate exposes no way to mint one, which is why roughly twenty-five specs in this
 * suite skip permanently.
 *
 * The spec is emphatic that a layout test which skips is worth nothing, and it is
 * right. So this asserts the part that needs no session and still catches a real
 * class of the reported bug: **the shell itself must never overflow horizontally**,
 * at 1440×900, 1280×800 and 1024×768. Two of the three root causes in §7.1 produce
 * exactly that symptom — a chat panel clamped to nearly the viewport width, and fixed
 * pixel widths that add up to more than the space — and both would fail here whatever
 * the session state is. `100vh` inside a resizing iframe (§7.4) shows up the same way
 * vertically, so that is measured too.
 *
 * What remains uncovered, and is recorded in `PHASE-7-COMPLETE.md` rather than
 * disguised: the page-fits-container assertion, the chat-does-not-cover-the-document
 * assertion, and the re-fit-on-collapse assertion. The fit arithmetic behind all
 * three is unit-tested in `apps/compass-ai/backend/tests/invariants.test.ts` — which
 * proves the numbers and not the pixels, and found a two-pixel overflow bug in the
 * rounding while doing so.
 */

import { expect, test } from '@playwright/test'
import { fixtureUser, resolveTargetEnvironment, type TargetEnvironment } from '../../helpers/env'
import { signInOrSkip } from '../../helpers/compass'

const env: TargetEnvironment = resolveTargetEnvironment()
const STAFF_FIXTURE = 'staff'

/** The three widths §7.8 names. 1024 is the docking breakpoint itself. */
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const

interface Overflow {
  documentScrollWidth: number
  documentClientWidth: number
  bodyScrollWidth: number
  /** The widest offending element, for a failure message that says what to look at. */
  widest: { tag: string; className: string; width: number } | null
}

test.describe(`compass ai — layout (${env.name})`, () => {
  // A session is needed to reach the app's own shell at all: the bare host serves a
  // platform embed wrapper, and the SPA mounts only after magic-link activation
  // redirects onto it. That is a sign-in, NOT the portal-bound session this suite
  // cannot mint — the shell renders for a staff session too, with the portal context
  // unresolved, and its layout is exactly what these assertions are about.
  test.skip(fixtureUser(env, STAFF_FIXTURE) === null, `needs a "${STAFF_FIXTURE}" fixture`)

  test.beforeEach(async ({ page }) => {
    await signInOrSkip(page, env, STAFF_FIXTURE)
  })

  for (const viewport of VIEWPORTS) {
    test(`the shell does not scroll sideways at ${viewport.width}×${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ ...viewport })
      // Reloaded after the resize: the shell reads its own container on mount, and a
      // resize applied to an already-mounted page measures the wrong thing.
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      // The shell renders whatever the session state is — signed out, an auth error,
      // or the viewer. All three are the app's own layout, and none of them may
      // overflow.
      await page.waitForSelector('#root', { timeout: 45_000 })

      const overflow = await page.evaluate<Overflow>(() => {
        let widest: Overflow['widest'] = null
        for (const element of Array.from(document.querySelectorAll('*'))) {
          const rect = element.getBoundingClientRect()
          // `right` rather than `width`: an element can be narrower than the viewport
          // and still stick out because of where it starts, which is precisely what a
          // panel positioned from the right edge does when the viewport shrinks.
          if (rect.right <= window.innerWidth + 1) continue
          if (widest === null || rect.right > widest.width) {
            widest = {
              tag: element.tagName.toLowerCase(),
              className: String(element.className).slice(0, 120),
              width: Math.round(rect.right),
            }
          }
        }
        return {
          documentScrollWidth: document.documentElement.scrollWidth,
          documentClientWidth: document.documentElement.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          widest,
        }
      })

      expect(
        overflow.documentScrollWidth,
        `the page scrolls sideways at ${viewport.width}px: scrollWidth ` +
          `${overflow.documentScrollWidth} > clientWidth ${overflow.documentClientWidth}` +
          (overflow.widest
            ? `\n  widest offender: <${overflow.widest.tag} class="${overflow.widest.className}"> ` +
              `reaching ${overflow.widest.width}px`
            : ''),
      ).toBeLessThanOrEqual(overflow.documentClientWidth)

      expect(
        overflow.widest,
        'an element extends past the right edge of the viewport',
      ).toBeNull()
    })
  }

  test('the shell fills the viewport height without overflowing it', async ({ page }) => {
    // §7.4: `100vh` in a portal brick, and on a mobile browser with a retracting
    // toolbar, is the classic cut-off bottom row — the chat input sitting just below
    // the fold. `100dvh` with a `100vh` fallback is the fix; this is the assertion
    // that it holds.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 45_000 })

    const height = await page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight,
      client: document.documentElement.clientHeight,
      root: document.getElementById('root')?.getBoundingClientRect().height ?? 0,
    }))

    expect(
      height.scroll,
      `the page scrolls vertically at 800px tall: scrollHeight ${height.scroll} > ` +
        `clientHeight ${height.client}. The shell should size to the viewport and let ` +
        'its inner panes scroll.',
    ).toBeLessThanOrEqual(height.client + 1)

    // A shell shorter than the viewport is the other failure — a squashed layout with
    // dead space under it, which is what a mis-specified height produces.
    expect(
      height.root,
      `the shell is ${Math.round(height.root)}px tall in an 800px viewport`,
    ).toBeGreaterThan(height.client * 0.9)
  })
})
