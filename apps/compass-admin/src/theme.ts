/**
 * Chakra UI system for Compass Admin — the KIRIA visual system, Phase 9.
 *
 * Copied from the client app on purpose, and then deliberately narrowed. Two apps in
 * one product should not look like two products, and an operator switching between
 * them should not have to relearn what a colour means. If these ever need to diverge
 * further, do it here with a comment saying why — the shared part is the generated
 * ramp file, and that one is byte-identical by test.
 *
 * ---------------------------------------------------------------------------
 * The one difference that matters: yellow
 *
 * §2: the admin app "is internal, so it stays quieter: brand blue for structure, teal
 * for interaction, no gradient headers, and **yellow reserved for the alert-severity
 * scale** rather than sprayed across the eight screens."
 *
 * So this app has no `citation.*` — it has no reading view, and the highlighter has
 * nothing to highlight here — and it does have `warn.*`, which the client app is not
 * allowed. That is the whole split, and it is not arbitrary: in the client app yellow
 * means *this is the passage your answer came from*, and there must be exactly one
 * meaning for it on a surface a client sees. Internally, nobody is reading a citation,
 * so the highlighter is free to do the job it does in the graphics system — mark the
 * one thing that matters on the screen.
 *
 * "Reserved for the alert-severity scale" is a ceiling, not a licence. Yellow is for
 * *attention that is not failure*: eleven documents still indexing, a portal whose
 * binding has drifted. Red stays for wrong.
 *
 * ---------------------------------------------------------------------------
 * No gradient
 *
 * §2 says so explicitly, and the reason is §5: one emphasis per view. A gradient header
 * on every one of eight dense operational screens is decoration competing with the one
 * number on each screen that an operator is actually there to read.
 */

import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react'
import { kiriaColors, kiriaPaper, kiriaRadii } from './theme/kiria-tokens'

/** Exported for the contrast test — see the client app's theme for why. */
export const semanticColors = {
  'bg.canvas': {
    value: { base: '{colors.ink.50}', _dark: '{colors.ink.950}' },
  },
  'bg.surface': {
    value: { base: kiriaPaper.paper, _dark: '{colors.ink.925}' },
  },
  'bg.raised': {
    value: { base: '{colors.ink.100}', _dark: '{colors.ink.900}' },
  },
  'fg.default': {
    value: { base: '{colors.ink.900}', _dark: '{colors.ink.100}' },
  },
  // ink.700, not 600. 600 is 4.10:1 on a selected row's ground — the contrast test
  // found it the moment 'bg.emphasized' stopped being Chakra's grey and became ours.
  // Muted text is still text, and "muted" is a hierarchy, not a licence.
  'fg.muted': {
    value: { base: '{colors.ink.700}', _dark: '{colors.ink.400}' },
  },
  /**
   * Two tokens the components were already using and no theme here defined.
   *
   * `bg.subtle` (hover) and `bg.emphasized` (the active nav item) come from Chakra's
   * defaults when a theme is silent about them, and every app in this repo was silent.
   * The effect was invisible in code review and obvious in a screenshot: after a rebrand
   * that replaced every ramp, the most-looked-at element on the page — the selected nav
   * item — was still Chakra's grey, because the brand had nothing to say about the token
   * it used.
   *
   * §2's "keep the semantic-token structure exactly as it is, so no component changes"
   * holds only for the tokens the theme actually owns. These two were the gap.
   */
  'bg.subtle': {
    value: { base: '{colors.ink.100}', _dark: '{colors.ink.900}' },
  },
  'bg.emphasized': {
    value: { base: '{colors.ink.200}', _dark: '{colors.ink.800}' },
  },
  /**
   * The decorative hairline — card edges, table rules, dividers.
   *
   * Deliberately low contrast, and deliberately **not** subject to §6's 3:1 floor.
   * WCAG 1.4.11 applies to boundaries a person must perceive in order to operate a
   * control; it exempts "part of a graphic that is not required to understand the
   * content", which is exactly what a card edge is. Holding a hairline to 3:1 forces it
   * to near-black and turns every panel into a spreadsheet cell — the contrast test
   * asked for that once and the answer was to name the two kinds of border separately
   * rather than to darken this one.
   */
  'border.default': {
    value: { base: '{colors.ink.200}', _dark: '{colors.ink.800}' },
  },
  /**
   * The boundary of something you operate — a text input, a select, a quiet button.
   *
   * This one **is** held to 3:1, and adding it fixed a real defect that predates the
   * rebrand: inputs were outlined in the decorative hairline at about 1.3:1 on white,
   * so the edge of a field was essentially invisible. That was true of the slate theme
   * too. The contrast test is what surfaced it, which is the argument for having
   * written it.
   */
  'border.strong': {
    value: { base: '{colors.ink.500}', _dark: '{colors.ink.600}' },
  },

  'accent.solid': {
    value: { base: '{colors.blue.600}', _dark: '{colors.blue.400}' },
  },
  'accent.fg': {
    value: { base: '{colors.teal.600}', _dark: '{colors.teal.300}' },
  },
  'accent.subtle': {
    value: { base: '{colors.blue.100}', _dark: '{colors.blue.900}' },
  },
  /**
   * The label on `accent.subtle` — an active nav item, a selected row.
   *
   * Blue rather than teal: teal is for something you click to go elsewhere, and the
   * item you are already on is not a link. It is structure, and structure is blue.
   */
  'accent.onSubtle': {
    value: { base: '{colors.blue.700}', _dark: '{colors.blue.200}' },
  },
  /**
   * What goes ON accent.solid, which is not always white.
   *
   * In dark mode the accent steps up the ramp to `blue.400` so it is legible against
   * ink — and white on `blue.400` is 3.05:1, which fails for a button label. The
   * label has to darken as the ground lightens. Hard-coding `white` in the button
   * (which is what the pre-brand primitives did) is only correct in light mode, and
   * the failure is invisible to anyone developing in light mode.
   */
  'accent.contrast': {
    value: { base: '#ffffff', _dark: '{colors.ink.950}' },
  },

  // --- attention, not failure (§2's alert-severity scale) -------------------
  /**
   * Yellow, and only here.
   *
   * `warn.fg` is **not** `yellow.600`. The brand yellow is a highlighter — 1.16:1 on
   * white — so as text it is invisible, which is the asymmetry §1 spells out. The dark
   * end of the same ramp is the legible form of the same colour, and `warn.subtle` is
   * the ground that carries the actual brand hue where it belongs: behind ink, where
   * it measures about 18:1.
   */
  'warn.fg': { value: { base: '{colors.yellow.900}', _dark: '{colors.yellow.400}' } },
  'warn.solid': { value: { base: '{colors.yellow.600}', _dark: '{colors.yellow.600}' } },
  'warn.subtle': { value: { base: '{colors.yellow.200}', _dark: '{colors.yellow.900}' } },
  // yellow.800, not 700: 700 measures 1.9:1 on white and a panel edge that marks
  // something needing attention is a boundary you have to be able to find.
  'warn.border': { value: { base: '{colors.yellow.800}', _dark: '{colors.yellow.700}' } },

  // --- wrong ----------------------------------------------------------------
  'danger.fg': { value: { base: '{colors.red.700}', _dark: '{colors.red.300}' } },
  'danger.solid': { value: { base: '{colors.red.600}', _dark: '{colors.red.400}' } },
  'danger.subtle': { value: { base: '{colors.red.50}', _dark: '{colors.red.900}' } },

  // --- fine, or on its way to fine -------------------------------------------
  //
  // Teal, because the KIRIA palette has no green (§1). "Indexed" and "queued" used to
  // be green and amber; the first is teal now and the second is warn, so the two states
  // an operator scans for still separate at a glance.
  'ok.fg': { value: { base: '{colors.teal.700}', _dark: '{colors.teal.300}' } },
  'ok.subtle': { value: { base: '{colors.teal.50}', _dark: '{colors.teal.900}' } },
}

const config = defineConfig({
  globalCss: {
    'html, body, #root': { height: '100%' },
    body: {
      bg: 'bg.canvas',
      color: 'fg.default',
      fontFeatureSettings: '"cv11", "ss01"',
    },
    '*::selection': { bg: 'accent.subtle' },
  },
  theme: {
    tokens: {
      fonts: {
        /** The brand face, self-hosted — see the client app's theme. */
        heading: {
          value:
            '"Nunito Sans", ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
        },
        body: {
          value:
            '"Nunito Sans", ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
        },
        mono: { value: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
      },
      colors: kiriaColors,
      radii: kiriaRadii,
      letterSpacings: {
        label: { value: '0.08em' },
      },
    },
    semanticTokens: { colors: semanticColors },
  },
})

export const system = createSystem(defaultConfig, config)
