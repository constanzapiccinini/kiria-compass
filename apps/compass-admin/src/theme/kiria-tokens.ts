/**
 * KIRIA colour ramps — GENERATED, do not edit.
 *
 * Produced by `scripts/generate-kiria-tokens.mjs` from the brand hexes in Phase 9 §1.
 * To change a colour, edit `BRAND` in that script and re-run it; it rewrites this file
 * in every app at once. Editing one copy by hand is caught by the drift test.
 *
 * The brand hex is the **600** step of its ramp, so `{colors.blue.600}` is the pure
 * colour and everything else is a tint or shade of it, mixed in linear light.
 *
 * These are raw values with no meaning attached. What each one is FOR lives in each
 * app's `theme.ts` semantic tokens, and the three apps deliberately differ there —
 * yellow is the citation highlight in the client app and the alert-severity scale in
 * the two staff apps (§1, §2).
 */

export const kiriaColors = {
  /** Neutrals, anchored at --paper-gray (50) and --ink (950). Blue-cast on purpose. */
  ink: {
    50: { value: '#f4f6fa' },
    100: { value: '#eef0f4' },
    200: { value: '#e1e3e7' },
    300: { value: '#cfd1d5' },
    400: { value: '#a9abae' },
    500: { value: '#84868a' },
    600: { value: '#6a6c6f' },
    700: { value: '#515256' },
    800: { value: '#36383b' },
    900: { value: '#202224' },
    925: { value: '#121416' },
    950: { value: '#010104' },
  },
  /** --kiria-blue. Structure: primary buttons, active nav, focus ring. ~8:1 on white at 600. */
  blue: {
    50: { value: '#f1f5fc' },
    100: { value: '#e1ecfe' },
    200: { value: '#bed8ff' },
    300: { value: '#8eb8fa' },
    400: { value: '#5d94ea' },
    500: { value: '#306ecf' },
    600: { value: '#004aad' },
    700: { value: '#003f96' },
    800: { value: '#00347f' },
    900: { value: '#002a69' },
  },
  /** --teal. Interaction: links, interactive text, selected states. ~6:1 on white at 600. */
  teal: {
    50: { value: '#f1f6fa' },
    100: { value: '#e3effa' },
    200: { value: '#c2ddf8' },
    300: { value: '#93c3ee' },
    400: { value: '#65a4dd' },
    500: { value: '#3784c5' },
    600: { value: '#0065a6' },
    700: { value: '#00558d' },
    800: { value: '#004574' },
    900: { value: '#00355b' },
  },
  /** --light-blue. DECORATIVE OR DARK-GROUND ONLY — ~2:1 on white at 600, it fails as text. */
  sky: {
    50: { value: '#f4f8fc' },
    100: { value: '#eaf6ff' },
    200: { value: '#d8eeff' },
    300: { value: '#bee3ff' },
    400: { value: '#9fd6ff' },
    500: { value: '#7ec8fd' },
    600: { value: '#6bb9f0' },
    700: { value: '#4795ca' },
    800: { value: '#1c71a4' },
    900: { value: '#004e77' },
  },
  /** --cobalt. Reserved for the header gradient’s far end. Nothing else (§1). */
  cobalt: {
    50: { value: '#f1f4fe' },
    100: { value: '#e5ebff' },
    200: { value: '#c8d4ff' },
    300: { value: '#9eb2ff' },
    400: { value: '#7289ff' },
    500: { value: '#4e5def' },
    600: { value: '#3432cc' },
    700: { value: '#2c1fbd' },
    800: { value: '#2500ac' },
    900: { value: '#1d008e' },
  },
  /** --yellow. The highlighter. Unusable as text (~1.2:1) and excellent as a ground under ink (~18:1) — which is exactly why it is a highlighter and not a text colour. */
  yellow: {
    50: { value: '#fafaf3' },
    100: { value: '#fafbe9' },
    200: { value: '#fafbd0' },
    300: { value: '#fafbb0' },
    400: { value: '#faf991' },
    500: { value: '#f8f77a' },
    600: { value: '#f6f470' },
    700: { value: '#c4c135' },
    800: { value: '#908d00' },
    900: { value: '#5f5d00' },
  },
  /** --red. Destructive actions and errors only. */
  red: {
    50: { value: '#fef3f2' },
    100: { value: '#ffe9e8' },
    200: { value: '#ffd2d0' },
    300: { value: '#ffadab' },
    400: { value: '#ff8080' },
    500: { value: '#f34f59' },
    600: { value: '#d7263d' },
    700: { value: '#ba002b' },
    800: { value: '#940020' },
    900: { value: '#710016' },
  },
} as const

/**
 * The two ends of the brand’s paper, kept as their own names.
 *
 * `paper` is pure white and is NOT `ink.50` — a surface that sits above the canvas
 * needs to be lighter than it, and the canvas is already the lightest ramp step.
 */
export const kiriaPaper = {
  paper: '#ffffff',
  ink: '#010104',
} as const

/**
 * Corner radii, unchanged from the pre-brand theme.
 *
 * Kept because they were never the problem: §0 says nothing about the current look
 * is load-bearing "except one idea worth keeping", and that idea is the accent, not
 * the geometry. Changing radii alongside every colour would make a visual regression
 * impossible to attribute.
 */
export const kiriaRadii = {
  card: { value: '10px' },
  control: { value: '8px' },
} as const
