/**
 * The KIRIA visual system, asserted — Phase 9 §6.
 *
 * Three checks, and §6 is blunt about why the first one exists:
 *
 * > This is the only guard that survives someone adjusting a hex later, and it takes
 * > twenty lines.
 *
 * A rebrand is a diff full of hex values. Every one of them is plausible, none of them
 * is reviewable by eye, and the failure mode — a label nobody can read on a client's
 * screen — shows up after the deploy. So the contrast ratios are computed from the
 * token values, in both colour modes, for every pair the UI actually renders.
 *
 * ---------------------------------------------------------------------------
 * Why this test lives in the client app and reaches into the other two
 *
 * The platform shares no code between apps, so the brand exists as three copies. That
 * is the same situation `drift.test.ts` handles for the backend helpers, and the answer
 * is the same: one test that reads all three. It sits in this app because this is the
 * app a client sees, and because the citation rule — the part of the brand that is
 * load-bearing rather than decorative — is this app's.
 *
 * Run: npm test  (from apps/compass-ai/backend)
 */

import { readFileSync, readdirSync } from 'node:fs'
import { kiriaColors, kiriaPaper } from '../../src/theme/kiria-tokens.js'
import { semanticColors as clientColors } from '../../src/theme.js'
import { semanticColors as adminColors } from '../../../compass-admin/src/theme.js'
import { semanticColors as insightsColors } from '../../../compass-insights/src/theme.js'

let failures = 0

// ---------------------------------------------------------------------------
// resolving a semantic token to a hex
// ---------------------------------------------------------------------------

type Ramp = Record<string, { value: string }>
type SemanticValue = string | { base?: string; _dark?: string }
type SemanticMap = Record<string, { value: SemanticValue }>

/** `{colors.blue.600}` -> `#004aad`. A literal hex passes through unchanged. */
function resolveRef(reference: string): string | null {
  const direct = /^#[0-9a-fA-F]{6}$/.exec(reference)
  if (direct) return reference.toLowerCase()

  const match = /^\{colors\.([a-z]+)\.(\d+)\}$/.exec(reference)
  if (!match) return null
  const ramp = (kiriaColors as unknown as Record<string, Ramp>)[match[1]]
  const step = ramp?.[match[2]]
  return step ? step.value.toLowerCase() : null
}

/** The hex a semantic token resolves to in one colour mode. */
function resolve(map: SemanticMap, name: string, mode: 'base' | '_dark'): string | null {
  const entry = map[name]
  if (!entry) return null
  const value = entry.value
  const reference = typeof value === 'string' ? value : (value[mode] ?? value.base)
  return typeof reference === 'string' ? resolveRef(reference) : null
}

// --- WCAG ------------------------------------------------------------------

function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((offset) =>
    toLinear(parseInt(value.slice(offset, offset + 2), 16)),
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---------------------------------------------------------------------------
// 1. every pair the UI renders, in both modes
//
// `kind` sets the threshold, and the distinction is the one WCAG makes rather than one
// invented here: 'text' is 4.5:1 because it is read, 'ui' is 3:1 because a border or an
// icon only has to be *located*. Calling a border 'text' would fail a legal design and
// push someone toward darkening every hairline until the UI looks like a spreadsheet.
// ---------------------------------------------------------------------------

interface Pair {
  fg: string
  bg: string
  kind: 'text' | 'ui'
  /** Where this combination actually appears, so a failure names a screen. */
  where: string
}

const SHARED_PAIRS: Pair[] = [
  { fg: 'fg.default', bg: 'bg.canvas', kind: 'text', where: 'body text on the page ground' },
  { fg: 'fg.default', bg: 'bg.surface', kind: 'text', where: 'body text in a card' },
  { fg: 'fg.default', bg: 'bg.raised', kind: 'text', where: 'body text on a raised row' },
  { fg: 'fg.muted', bg: 'bg.canvas', kind: 'text', where: 'a muted label on the ground' },
  { fg: 'fg.muted', bg: 'bg.surface', kind: 'text', where: 'a muted label in a card' },
  { fg: 'fg.muted', bg: 'bg.raised', kind: 'text', where: 'a muted label on a raised row' },
  { fg: 'accent.fg', bg: 'bg.surface', kind: 'text', where: 'a link in a card' },
  { fg: 'accent.fg', bg: 'bg.canvas', kind: 'text', where: 'a link on the ground' },
  { fg: 'accent.solid', bg: 'bg.surface', kind: 'ui', where: 'the focus ring and active nav' },
  { fg: 'accent.solid', bg: 'bg.canvas', kind: 'ui', where: 'a primary button on the ground' },
  // border.default is absent on purpose. It is the decorative hairline, which WCAG
  // 1.4.11 exempts; border.strong is the one that outlines something you operate, and
  // that is the one held to 3:1. Adding border.default here was this test's first
  // finding and it was a finding about the test.
  { fg: 'border.strong', bg: 'bg.canvas', kind: 'ui', where: 'an input outline on the ground' },
  { fg: 'border.strong', bg: 'bg.surface', kind: 'ui', where: 'an input outline in a card' },
  { fg: 'accent.onSubtle', bg: 'accent.subtle', kind: 'text', where: 'the active nav item' },
  { fg: 'fg.default', bg: 'bg.subtle', kind: 'text', where: 'a hovered row' },
  { fg: 'fg.muted', bg: 'bg.emphasized', kind: 'text', where: 'a muted label on a selected row' },
  { fg: 'danger.fg', bg: 'bg.surface', kind: 'text', where: 'an error message' },
  { fg: 'danger.solid', bg: 'bg.surface', kind: 'ui', where: 'a destructive button border' },
  { fg: 'ok.fg', bg: 'bg.surface', kind: 'text', where: 'a healthy/pending label' },
  { fg: 'ok.fg', bg: 'ok.subtle', kind: 'text', where: 'a healthy/pending pill' },
  { fg: 'danger.fg', bg: 'danger.subtle', kind: 'text', where: 'an error pill' },
]

/**
 * The label on a filled button, checked against the fill it sits on.
 *
 * This started as "white on accent.solid" and that is what found the bug: in dark mode
 * the accent steps up to `blue.400` and white on it is 3.05:1. The fix was a token —
 * `accent.contrast` — so the label darkens when the fill lightens, and this pair now
 * checks the two tokens against each other rather than assuming one of them.
 */
const ON_SOLID: Array<{ solid: string; contrast: string; where: string }> = [
  { solid: 'accent.solid', contrast: 'accent.contrast', where: 'the primary button label' },
]

const CLIENT_PAIRS: Pair[] = [
  // The highlighter, checked as a ground under ink rather than as a text colour.
  // §1: "as a background under #010104 it is ≈ 18:1 — excellent. That asymmetry is
  // exactly why it is a highlighter and not a text colour."
  { fg: 'citation.fg', bg: 'citation.bg', kind: 'text', where: 'text under the citation swipe' },
  { fg: 'citation.ring', bg: 'bg.surface', kind: 'ui', where: 'the focused-citation ring' },
]

const STAFF_PAIRS: Pair[] = [
  { fg: 'warn.fg', bg: 'bg.surface', kind: 'text', where: 'an attention label' },
  { fg: 'warn.fg', bg: 'warn.subtle', kind: 'text', where: 'an attention pill' },
  { fg: 'warn.border', bg: 'bg.surface', kind: 'ui', where: 'an attention panel border' },
  { fg: 'warn.border', bg: 'bg.canvas', kind: 'ui', where: 'an attention panel on the ground' },
]

const SUITES: Array<{ app: string; colors: SemanticMap; pairs: Pair[] }> = [
  {
    app: 'compass-ai',
    colors: clientColors as SemanticMap,
    pairs: [...SHARED_PAIRS, ...CLIENT_PAIRS],
  },
  {
    app: 'compass-admin',
    colors: adminColors as SemanticMap,
    pairs: [...SHARED_PAIRS, ...STAFF_PAIRS],
  },
  {
    app: 'compass-insights',
    colors: insightsColors as SemanticMap,
    pairs: [...SHARED_PAIRS, ...STAFF_PAIRS],
  },
]

for (const suite of SUITES) {
  for (const mode of ['base', '_dark'] as const) {
    for (const pair of suite.pairs) {
      const fg = resolve(suite.colors, pair.fg, mode)
      const bg = resolve(suite.colors, pair.bg, mode)
      if (!fg || !bg) {
        console.log(
          `FAIL (${suite.app} ${mode}: ${pair.fg} on ${pair.bg} could not be resolved — ` +
            'either the token was renamed or it points at a ramp step that does not exist)',
        )
        failures++
        continue
      }
      const minimum = pair.kind === 'text' ? 4.5 : 3
      const ratio = contrast(fg, bg)
      if (ratio >= minimum) continue
      console.log(
        `FAIL (§6 contrast: ${suite.app}, ${mode === 'base' ? 'light' : 'dark'} — ` +
          `${pair.where}) ${pair.fg} ${fg} on ${pair.bg} ${bg} is ${ratio.toFixed(2)}:1, ` +
          `needs ${minimum}:1`,
      )
      failures++
    }

    for (const entry of ON_SOLID) {
      const solid = resolve(suite.colors, entry.solid, mode)
      const label = resolve(suite.colors, entry.contrast, mode)
      if (!solid || !label) continue
      const ratio = contrast(label, solid)
      if (ratio >= 4.5) continue
      console.log(
        `FAIL (§6 contrast: ${suite.app}, ${mode === 'base' ? 'light' : 'dark'} — ${entry.where}) ` +
          `${entry.contrast} ${label} on ${entry.solid} ${solid} is ${ratio.toFixed(2)}:1, needs 4.5:1`,
      )
      failures++
    }
  }
}

// ---------------------------------------------------------------------------
// 2. §1's own contrast claims, verified rather than trusted
//
// The spec states approximate ratios for each brand hex and warns that "swapping brand
// hexes in naively without re-checking is how a rebrand quietly breaks legibility". The
// numbers turned out to be accurate to two significant figures, which is worth pinning:
// if a future edit moves a brand hex, the ramp still generates and every semantic pair
// above may still pass while the colour is no longer KIRIA's.
// ---------------------------------------------------------------------------

const BRAND_CLAIMS: Array<[string, string, number, string]> = [
  ['blue.600', '#004aad', 8, 'safe for text, buttons, icons'],
  ['teal.600', '#0065a6', 6, 'safe for text and links'],
  ['cobalt.600', '#3432cc', 8.5, 'safe, but reserved for the gradient'],
  ['sky.600', '#6bb9f0', 2, 'FAILS on white — decorative or dark-ground only'],
  ['yellow.600', '#f6f470', 1.2, 'unusable as text; this is why it is a highlighter'],
  ['red.600', '#d7263d', 4.9, 'destructive actions and errors only'],
]

for (const [name, expectedHex, expectedRatio, note] of BRAND_CLAIMS) {
  const [ramp, step] = name.split('.')
  const actual = (kiriaColors as unknown as Record<string, Ramp>)[ramp]?.[step]?.value.toLowerCase()
  if (actual !== expectedHex) {
    console.log(
      `FAIL (§1: ${name} is ${actual ?? '(missing)'}, the brand hex is ${expectedHex} — ` +
        'the 600 step must be the pure brand colour)',
    )
    failures++
    continue
  }
  const ratio = contrast(actual, '#ffffff')
  // Half a point of tolerance: §1's figures are approximations and the point is to
  // catch a hex that moved, not to police rounding.
  if (Math.abs(ratio - expectedRatio) > 0.5) {
    console.log(
      `FAIL (§1: ${name} measures ${ratio.toFixed(2)}:1 on white, the spec says ` +
        `≈${expectedRatio}:1 — ${note})`,
    )
    failures++
  }
}

// The highlighter's whole justification, as a number.
const swipe = contrast(kiriaPaper.ink, kiriaColors.yellow[600].value)
if (swipe < 12) {
  console.log(
    `FAIL (§1: ink on the citation yellow is only ${swipe.toFixed(2)}:1 — the highlighter ` +
      'works because that pairing is excellent, and if it is not, yellow has no job here)',
  )
  failures++
}

// ---------------------------------------------------------------------------
// 3. the yellow audit (§6)
//
// > grep the built CSS for #F6F470 / its token and confirm it appears only in citation
// > components.
//
// Run against source rather than built CSS, and on purpose: the built bundle contains
// the whole ramp because the ramp is a token file, so a grep there reports a hit for
// every app and proves nothing. What can actually go wrong is a component reaching for
// yellow directly, and that is visible in the source.
//
// The client app may only touch yellow through `citation.*`. The staff apps may use
// `warn.*` — §2 grants them the alert-severity scale — but not raw `yellow.N` either,
// because the whole point of the semantic layer is that "attention" has one definition.
// ---------------------------------------------------------------------------

// `colorPalette` is in this pattern because of a real miss: the client app's auth
// modal had a `colorPalette="yellow"` refresh button, and the first version of this
// audit walked straight past it — it was looking for ramp steps and hexes, and Chakra
// has a third way to name a colour.
const YELLOW_DIRECT = /yellow\.\d{2,3}|#f6f470|colorPalette=["']yellow["']/i

function sourceFiles(dir: URL): URL[] {
  const found: URL[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) found.push(...sourceFiles(child))
    else if (/\.(tsx?|css)$/.test(entry.name)) found.push(child)
  }
  return found
}

for (const app of ['compass-ai', 'compass-admin', 'compass-insights']) {
  for (const file of sourceFiles(new URL(`../../../${app}/src/`, import.meta.url))) {
    const name = decodeURIComponent(file.pathname)
    // The token file IS the ramp and the theme file is where meaning is assigned;
    // both are allowed to name yellow, and reporting them would be reporting the
    // definition as a violation.
    if (/\/theme\/kiria-tokens\.ts$|\/theme\.ts$/.test(name)) continue

    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        if (!YELLOW_DIRECT.test(line)) return
        console.log(
          `FAIL (§1: yellow reached for directly, outside the semantic layer) ` +
            `${app}/${name.split('/src/')[1]}:${index + 1}\n      ${line.trim().slice(0, 110)}\n` +
            `      Use citation.* in the client app, warn.* in the staff apps.`,
        )
        failures++
      })
  }
}

// ---------------------------------------------------------------------------
// 4. one source of truth (§2)
//
// > Put the tokens in a single generated `src/theme/kiria-tokens.ts`, copied verbatim
// > into each app — apps share no code by platform design — with the byte-comparison
// > drift test that `folders.ts` already established. Three apps drifting apart on
// > brand hexes is the same failure mode as three copies of a helper, and it is more
// > visible to clients.
//
// The file is generated, so the fix for a failure here is never to edit a copy: it is
// `node scripts/generate-kiria-tokens.mjs`, which rewrites all three.
// ---------------------------------------------------------------------------

const APP_NAMES = ['compass-ai', 'compass-admin', 'compass-insights'] as const

const tokenCopies = APP_NAMES.map((app) => ({
  app,
  bytes: readFileSync(new URL(`../../../${app}/src/theme/kiria-tokens.ts`, import.meta.url)),
}))

for (const copy of tokenCopies.slice(1)) {
  if (copy.bytes.equals(tokenCopies[0].bytes)) continue
  console.log(
    `FAIL (§2: ${copy.app}/src/theme/kiria-tokens.ts has drifted from compass-ai’s copy ` +
      `— re-run scripts/generate-kiria-tokens.mjs rather than editing a copy)`,
  )
  failures++
}

// The staff apps share their whole semantic layer too, which is a stronger claim than
// the tokens alone and the one that keeps "quieter, but the same product" true.
const staffThemes = ['compass-admin', 'compass-insights'].map((app) =>
  readFileSync(new URL(`../../../${app}/src/theme.ts`, import.meta.url)),
)
if (!staffThemes[0].equals(staffThemes[1])) {
  console.log(
    'FAIL (compass-insights/src/theme.ts has drifted from compass-admin’s — the two staff ' +
      'apps are meant to be the same theme, and a divergence here is a deliberate design ' +
      'decision that should be written down rather than discovered)',
  )
  failures++
}

// ---------------------------------------------------------------------------
// 5. the brand assets are present and identical in all three apps
//
// The font and the wordmarks are generated into each app by
// scripts/build-brand-font.mjs and scripts/build-brand-logos.mjs, for the same reason
// the token file is: the platform shares nothing between apps. Same failure mode too —
// one app quietly ends up a version behind and only a client notices.
//
// A missing file here is the more likely accident. A public/ asset that is referenced
// but absent does not break the build, does not fail typecheck, and shows up as a
// broken image or a silent fallback font on production.
// ---------------------------------------------------------------------------

const ASSETS = [
  'fonts/nunito-sans-latin.woff2',
  'brand/wordmark.png',
  'brand/wordmark-white.png',
  'brand/favicon.png',
]

for (const asset of ASSETS) {
  const copies = APP_NAMES.map((app) => {
    try {
      return {
        app,
        bytes: readFileSync(new URL(`../../../${app}/public/${asset}`, import.meta.url)),
      }
    } catch {
      return { app, bytes: null }
    }
  })

  const missing = copies.filter((copy) => copy.bytes === null)
  if (missing.length > 0) {
    console.log(
      `FAIL (brand asset public/${asset} is missing from ` +
        `${missing.map((copy) => copy.app).join(', ')} — re-run ` +
        'scripts/build-brand-font.mjs and scripts/build-brand-logos.mjs)',
    )
    failures++
    continue
  }

  const first = copies[0]
  for (const copy of copies.slice(1)) {
    if (copy.bytes!.equals(first.bytes!)) continue
    console.log(
      `FAIL (brand asset public/${asset} differs between ${first.app} and ${copy.app} ` +
        '— re-run the generator rather than copying one over the other)',
    )
    failures++
  }
}

console.log(
  failures === 0
    ? 'PASS — every semantic pair meets WCAG in both modes, the brand hexes are the 600 steps, yellow is only reached through the semantic layer, the three token copies are identical, and the brand assets are present in every app'
    : `${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
