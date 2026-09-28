/**
 * Chakra UI system for Compass AI — the KIRIA visual system, Phase 9.
 *
 * The colour ramps are generated (`src/theme/kiria-tokens.ts`, byte-identical in all
 * three apps). This file is the part that carries meaning: which brand colour each
 * thing in the product is allowed to be.
 *
 * ---------------------------------------------------------------------------
 * The one rule
 *
 * §1: **colour is meaning, not decoration.** Concretely, in this app:
 *
 *   * **blue** is structure — primary buttons, active nav, the focus ring;
 *   * **teal** is interaction — links and interactive text;
 *   * **yellow is the citation highlight and nothing else.**
 *
 * That last one is the whole idea and it is not a stylistic preference. KIRIA's
 * signature device is a highlighter swipe over the phrase that carries the insight; in
 * this product the phrase that carries the insight is the cited paragraph. The brand
 * device and the core interaction are the same gesture, so yellow appears there and in
 * no other component — not on buttons, not on badges, not on the chat pill. There is a
 * grep in the test suite that says so.
 *
 * This is why the pre-brand theme's `amber` accent is gone rather than recoloured. It
 * was doing two jobs — "this is interactive" and "this is the citation" — and the
 * brand only sanctions yellow for the second. `accent.*` is now blue and teal;
 * `citation.*` is its own family with its own name, so the highlighter is never
 * borrowing the accent and cannot be widened by someone reusing `accent.solid`.
 *
 * ---------------------------------------------------------------------------
 * Warning colour, and what happened to amber
 *
 * There is deliberately no amber. The staff apps map "attention, not failure" onto
 * yellow, which §2 explicitly permits them ("yellow reserved for the alert-severity
 * scale"). This app may not: it is the surface a client sees, and yellow here means
 * citation. So the handful of client-facing states that used to be amber — a document
 * still being prepared, for one — are **teal**, because informational is what they
 * actually are, and red is reserved for things that are wrong.
 *
 * ---------------------------------------------------------------------------
 * Dark mode is derived, not inherited
 *
 * §7.4 gives a choice: derive a dark palette deliberately, or drop dark mode, because
 * "a half-derived dark theme is where brand colours end up as mud". Derived, and here
 * is the derivation:
 *
 *   * the ground is `--ink` itself (#010104), the brand's own darkest value rather
 *     than a grey somebody picked;
 *   * surfaces lift through `ink.925` and `ink.900` — that extra step exists so a card
 *     does not float in a void;
 *   * blue and teal step **up** the ramp (600 → 400/300), because a mid-dark blue on a
 *     near-black ground is unreadable; the tint steps keep the hue and gain lightness,
 *     which is exactly what the OKLCH ladder was built for;
 *   * **yellow does not change.** The citation highlight sits on a rendered PDF page,
 *     and a PDF page is white in both modes. A "dark-mode citation colour" would be a
 *     colour applied to a surface that is not dark.
 */

import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react'
import { kiriaColors, kiriaPaper, kiriaRadii } from './theme/kiria-tokens'

/**
 * The semantic layer, exported so the contrast test can read it.
 *
 * §6 asks for "every foreground/background semantic pair, asserted at ≥4.5:1 for text
 * and ≥3:1 for UI borders and icons, computed from the token values". Exporting the map
 * is what makes "computed from the token values" true rather than approximately true —
 * the alternative is a test with the hexes copied into it, which passes forever after
 * somebody changes a token.
 */
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

  // --- structure and interaction -------------------------------------------
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

  // --- the highlighter ------------------------------------------------------
  /**
   * The citation, and the only yellow in this app.
   *
   * `bg` is the swipe itself, used at partial alpha over rendered text — see
   * `PdfPage.tsx`. A flat opaque swatch over words is unreadable, which §1 says will
   * be the first thing anyone notices.
   *
   * `ring` is blue on purpose: the highlight says *this is the passage*, the ring says
   * *this is the one you jumped to*. Two statements need two colours, and a darker
   * yellow ring would collapse them into one.
   */
  'citation.bg': { value: '{colors.yellow.600}' },
  'citation.ring': { value: { base: '{colors.blue.600}', _dark: '{colors.blue.400}' } },
  'citation.fg': { value: '{colors.ink.950}' },

  // --- states ---------------------------------------------------------------
  /** Wrong: a failed upload, an error, a destructive button. */
  'danger.fg': { value: { base: '{colors.red.700}', _dark: '{colors.red.300}' } },
  'danger.solid': { value: { base: '{colors.red.600}', _dark: '{colors.red.400}' } },
  'danger.subtle': { value: { base: '{colors.red.50}', _dark: '{colors.red.900}' } },

  /**
   * Fine, or on its way to fine — indexed, succeeded, still preparing.
   *
   * Teal, because **the KIRIA palette has no green** (§1's table). Rather than invent
   * one, the two states that used to be green and amber in this product both land
   * here, and the pill prints the word besides. Where the distinction has to survive
   * at a glance, the staff apps separate them with `warn.*` — the client app does
   * not, because it may not use yellow at all.
   */
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
    // Selection is blue, not yellow. Selecting text is not citing it, and a yellow
    // selection would put the highlighter on every paragraph a reader drags across.
    '*::selection': { bg: 'accent.subtle' },
  },
  theme: {
    tokens: {
      fonts: {
        /**
         * The brand face, self-hosted (§1).
         *
         * `@font-face` is in `globals.css` rather than here, because it has to be
         * parsed before React mounts. The system stack behind it is the real fallback:
         * with `font-display: swap` a blocked woff2 renders in it immediately rather
         * than showing nothing.
         */
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
        /** §1's tracked uppercase register, for small labels only. */
        label: { value: '0.08em' },
      },
    },
    semanticTokens: { colors: semanticColors },
  },
})

export const system = createSystem(defaultConfig, config)
