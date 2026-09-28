/**
 * Generate the KIRIA colour ramps — Phase 9 §2.
 *
 * ---------------------------------------------------------------------------
 * Why generated rather than hand-written
 *
 * §2: "Generate the tint/shade ramps from the brand hexes rather than eyeballing them,
 * and keep the brand hex as the 600 step so the pure colour is what appears at full
 * strength."
 *
 * Eyeballed ramps drift in lightness and hue between colours, and the drift shows up as
 * a blue that looks heavier than the teal beside it at the same step. Generating them
 * means step 400 means the same thing in every ramp, which is the only reason a
 * semantic token can say `{colors.blue.600}` and be swapped for `{colors.teal.600}`
 * without a designer re-checking it.
 *
 * ---------------------------------------------------------------------------
 * How: OKLCH, and why not a plain mix
 *
 * The first version of this script mixed each brand hex toward white and black in
 * linear-light sRGB. It produced two defects that are worth recording, because both
 * look plausible until you put the ramp on screen:
 *
 *   * **The tints went grey and drifted purple.** Mixing `#004AAD` toward white loses
 *     chroma much faster than lightness, so `blue.400` came out `#99a3cc` — a
 *     lavender-grey with no relationship to the brand. Next to it, `blue.600` was a
 *     visible discontinuity rather than the same colour at full strength.
 *   * **The neutral ramp was unusable.** Interpolating paper-gray to ink in linear
 *     light put `ink.900` at `#424344`, a mid-grey. Body text set in it would have
 *     been the single most visible regression in the phase.
 *
 * Both are the same mistake: linear light is how photons add, not how a ramp is read.
 * So the ladder is built in **OKLCH** — perceptual lightness, chroma and hue as
 * separate axes. Lightness moves; hue is held exactly; chroma is scaled by how much
 * room is left before the step would leave the sRGB gamut, and then clipped by
 * bisection if it still would.
 *
 * The ladder is built **relative to the brand colour's own lightness**, not to a fixed
 * table of L values. That is what lets the brand hex sit at 600 in every ramp: yellow
 * is far lighter than blue, and a fixed ladder could honour the 600 rule for one of
 * them or the other, never both.
 *
 * The neutral ramp is anchored at both ends by brand values — `--paper-gray` (#F4F6FA)
 * at 50 and `--ink` (#010104) at 950 — and keeps paper-gray's faint blue chroma the
 * whole way down. A pure-grey neutral next to these blues reads as a different, colder
 * product.
 *
 *   node scripts/generate-kiria-tokens.mjs
 *
 * Writes `src/theme/kiria-tokens.ts` into every app in APPS, byte-identical. That
 * identity is enforced separately by each app's drift test — this script is how the
 * copies are produced, not how they are kept honest.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const APPS = ['apps/compass-ai', 'apps/compass-admin', 'apps/compass-insights']

/**
 * The brand hexes, verbatim from Phase 9 §1's table.
 *
 * These are the only numbers in this file that were chosen by a person. Everything else
 * is derived, which is the point: a rebrand edits this object.
 */
const BRAND = {
  ink: '#010104',
  blue: '#004AAD',
  teal: '#0065A6',
  sky: '#6BB9F0', // --light-blue
  cobalt: '#3432CC',
  yellow: '#F6F470',
  red: '#D7263D',
  paper: '#FFFFFF',
  paperGray: '#F4F6FA',
}

/**
 * Where each step sits between the light anchor and the dark anchor, with the brand
 * colour's own lightness at 0 (step 600).
 *
 * Negative is toward the light anchor, positive toward the dark one, both as a fraction
 * of the room available on that side. The curve is deliberately uneven: the light end
 * needs fine steps because that is where subtle surface tints live and where a
 * too-large jump is immediately visible, and the dark end needs coarse ones because
 * there is little usable range below a mid-lightness colour before every step becomes
 * the same near-black.
 */
const LADDER = {
  50: -0.97,
  100: -0.92,
  200: -0.8,
  300: -0.62,
  400: -0.42,
  500: -0.21,
  600: 0,
  700: 0.22,
  800: 0.45,
  900: 0.68,
}

/** OKLCH lightness the 50 step reaches for, and the floor the 900 step reaches for. */
const LIGHT_ANCHOR = 0.985
const DARK_ANCHOR = 0.24

// --- colour maths ----------------------------------------------------------

function hexToRgb(hex) {
  const value = hex.replace('#', '')
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

function rgbToHex([r, g, b]) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)))
  return '#' + [r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')
}

/** sRGB 0-255 -> linear-light 0-1. */
function toLinear(channel) {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** linear-light 0-1 -> sRGB 0-255. */
function fromLinear(channel) {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  return c * 255
}

// --- OKLab / OKLCH (Björn Ottosson's transform) -----------------------------

function hexToOklab(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

/** Back to sRGB. Returns channels in 0-255 that may fall outside the gamut. */
function oklabToRgbRaw({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function inGamut(rgb) {
  return rgb.every((channel) => channel >= -0.5 && channel <= 255.5)
}

function toOklch(hex) {
  const { L, a, b } = hexToOklab(hex)
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) }
}

/**
 * OKLCH back to a hex, reducing chroma until the colour fits in sRGB.
 *
 * Clipping the RGB channels instead would shift the hue — a blue that has run out of
 * gamut clips its blue channel and comes back purple. Bisecting on chroma keeps the hue
 * exactly and gives up only saturation, which is the axis with the least meaning here.
 */
function oklchToHex({ L, C, h }) {
  const at = (chroma) => oklabToRgbRaw({ L, a: Math.cos(h) * chroma, b: Math.sin(h) * chroma })
  if (inGamut(at(C))) return rgbToHex(at(C))

  let low = 0
  let high = C
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2
    if (inGamut(at(mid))) low = mid
    else high = mid
  }
  return rgbToHex(at(low))
}

/** WCAG relative luminance. */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two hexes. */
export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * A ten-step ramp with `base` at 600.
 *
 * Hue is held exactly at the brand colour's. Chroma tapers toward the light end —
 * `C * (1 - t²)` — because a very light step at full chroma is not a tint, it is a
 * different, acidic colour, and because near white there is no gamut left to hold it
 * anyway. The dark steps keep full chroma: a shade that loses saturation reads as
 * grey-blue rather than dark blue, and the bisection above will take back whatever the
 * gamut genuinely cannot hold.
 */
function ramp(base) {
  const { L, C, h } = toOklch(base)
  const out = {}
  for (const [step, position] of Object.entries(LADDER)) {
    if (position === 0) {
      out[step] = base.toLowerCase()
      continue
    }
    const t = Math.abs(position)
    const targetL = position < 0 ? L + (LIGHT_ANCHOR - L) * t : L - (L - DARK_ANCHOR) * t
    const targetC = position < 0 ? C * (1 - t ** 2) : C
    out[step] = oklchToHex({ L: targetL, C: targetC, h })
  }
  return out
}

/**
 * The neutral ramp, anchored at both ends by brand values rather than derived from one.
 *
 * `--ink` is very nearly black (#010104) and `--paper-gray` is very nearly white with a
 * blue cast (#F4F6FA). Interpolating between them in linear light keeps that cast all
 * the way down the scale, which is what stops the greys from reading colder than the
 * blues they sit beside.
 */
function inkRamp() {
  const light = toOklch(BRAND.paperGray)
  const dark = toOklch(BRAND.ink)

  // Perceptual lightness per step, chosen for the jobs these greys actually do:
  // 100-300 are surfaces and borders, 500-600 are muted labels that must still pass
  // 4.5:1 on white, 800-900 are body text, 950 is the dark-mode ground.
  const lightness = {
    50: light.L,
    100: 0.955,
    200: 0.915,
    300: 0.86,
    400: 0.74,
    500: 0.62,
    600: 0.53,
    700: 0.44,
    800: 0.34,
    900: 0.25,
    // A surface that sits ABOVE the near-black canvas in dark mode. Without it the
    // jump from #010104 to ink.900 is the whole lift in one step, and every card
    // reads as a panel floating in a void rather than a page.
    925: 0.19,
    950: dark.L,
  }

  const out = {}
  for (const [step, L] of Object.entries(lightness)) {
    if (step === '50') {
      out[step] = BRAND.paperGray.toLowerCase()
      continue
    }
    if (step === '950') {
      out[step] = BRAND.ink.toLowerCase()
      continue
    }
    // Paper-gray's own chroma and hue, held the whole way down, so the greys keep the
    // brand's blue cast instead of turning neutral halfway.
    out[step] = oklchToHex({ L, C: light.C, h: light.h })
  }
  return out
}

// --- emit ------------------------------------------------------------------

const ramps = {
  ink: inkRamp(),
  blue: ramp(BRAND.blue),
  teal: ramp(BRAND.teal),
  sky: ramp(BRAND.sky),
  cobalt: ramp(BRAND.cobalt),
  yellow: ramp(BRAND.yellow),
  red: ramp(BRAND.red),
}

const NOTES = {
  ink: 'Neutrals, anchored at --paper-gray (50) and --ink (950). Blue-cast on purpose.',
  blue: '--kiria-blue. Structure: primary buttons, active nav, focus ring. ~8:1 on white at 600.',
  teal: '--teal. Interaction: links, interactive text, selected states. ~6:1 on white at 600.',
  sky: '--light-blue. DECORATIVE OR DARK-GROUND ONLY — ~2:1 on white at 600, it fails as text.',
  cobalt: '--cobalt. Reserved for the header gradient’s far end. Nothing else (§1).',
  yellow:
    '--yellow. The highlighter. Unusable as text (~1.2:1) and excellent as a ground under ink (~18:1) — which is exactly why it is a highlighter and not a text colour.',
  red: '--red. Destructive actions and errors only.',
}

function emit() {
  const lines = []
  lines.push('/**')
  lines.push(' * KIRIA colour ramps — GENERATED, do not edit.')
  lines.push(' *')
  lines.push(' * Produced by `scripts/generate-kiria-tokens.mjs` from the brand hexes in Phase 9 §1.')
  lines.push(' * To change a colour, edit `BRAND` in that script and re-run it; it rewrites this file')
  lines.push(' * in every app at once. Editing one copy by hand is caught by the drift test.')
  lines.push(' *')
  lines.push(' * The brand hex is the **600** step of its ramp, so `{colors.blue.600}` is the pure')
  lines.push(' * colour and everything else is a tint or shade of it, mixed in linear light.')
  lines.push(' *')
  lines.push(' * These are raw values with no meaning attached. What each one is FOR lives in each')
  lines.push(" * app's `theme.ts` semantic tokens, and the three apps deliberately differ there —")
  lines.push(' * yellow is the citation highlight in the client app and the alert-severity scale in')
  lines.push(' * the two staff apps (§1, §2).')
  lines.push(' */')
  lines.push('')
  lines.push('export const kiriaColors = {')
  for (const [name, scale] of Object.entries(ramps)) {
    lines.push(`  /** ${NOTES[name]} */`)
    lines.push(`  ${name}: {`)
    for (const [step, hex] of Object.entries(scale)) {
      lines.push(`    ${step}: { value: '${hex}' },`)
    }
    lines.push('  },')
  }
  lines.push('} as const')
  lines.push('')
  lines.push('/**')
  lines.push(' * The two ends of the brand’s paper, kept as their own names.')
  lines.push(' *')
  lines.push(' * `paper` is pure white and is NOT `ink.50` — a surface that sits above the canvas')
  lines.push(' * needs to be lighter than it, and the canvas is already the lightest ramp step.')
  lines.push(' */')
  lines.push('export const kiriaPaper = {')
  lines.push(`  paper: '${BRAND.paper.toLowerCase()}',`)
  lines.push(`  ink: '${BRAND.ink.toLowerCase()}',`)
  lines.push('} as const')
  lines.push('')
  lines.push('/**')
  lines.push(' * Corner radii, unchanged from the pre-brand theme.')
  lines.push(' *')
  lines.push(' * Kept because they were never the problem: §0 says nothing about the current look')
  lines.push(' * is load-bearing "except one idea worth keeping", and that idea is the accent, not')
  lines.push(' * the geometry. Changing radii alongside every colour would make a visual regression')
  lines.push(' * impossible to attribute.')
  lines.push(' */')
  lines.push('export const kiriaRadii = {')
  lines.push("  card: { value: '10px' },")
  lines.push("  control: { value: '8px' },")
  lines.push('} as const')
  lines.push('')
  return lines.join('\n')
}

const source = emit()

for (const app of APPS) {
  const dir = join(ROOT, app, 'src', 'theme')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'kiria-tokens.ts'), source)
  console.log(`wrote ${app}/src/theme/kiria-tokens.ts`)
}

// A quick readout, so running the generator tells you what it produced rather than
// only that it produced something.
console.log('\ncontrast on white (#ffffff):')
for (const [name, scale] of Object.entries(ramps)) {
  if (name === 'ink') continue
  console.log(`  ${name.padEnd(7)} 600 ${scale[600]}  ${contrast(scale[600], '#ffffff').toFixed(2)}:1`)
}
console.log(`  ink     900 ${ramps.ink[900]}  ${contrast(ramps.ink[900], '#ffffff').toFixed(2)}:1`)
console.log(
  `\nink on yellow: ${contrast(BRAND.ink, ramps.yellow[600]).toFixed(2)}:1  ` +
    `(the highlighter, §1)`,
)
