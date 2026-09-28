/**
 * The fit-to-width arithmetic, as a pure function — §7.2.
 *
 * Extracted from `PdfViewer` for one reason: it is the only part of this phase that
 * can be tested without a browser. §7.8 asks for layout tests at three viewports,
 * and it is right that a browser is the only thing that can catch a layout
 * regression — but the client app cannot be reached in e2e at all, because Gate
 * exposes no way to mint a portal-bound session and `resolvePortalContext` refuses
 * everything else. A test that skips is worth nothing, so the arithmetic is pulled
 * out here where a test can actually run against it.
 *
 * What that does and does not buy is written down in `PHASE-7-COMPLETE.md`: it proves
 * the scale is never wider than the space, and it does not prove the page is on
 * screen. The second still needs eyes, or a session nobody can currently make.
 */

/** The viewer's clamps, shared with `PdfViewer`. */
export const MIN_SCALE = 0.5
export const MAX_SCALE = 2.5
/** `p="4"` on the scroll container, both sides. */
export const PAGE_PADDING = 32

/**
 * The scale at which the widest page fits the container.
 *
 * Returns null when there is nothing to compute from — an unmeasured document, a
 * container of zero width during mount, a padding wider than the container itself.
 * Null means "keep the current scale", which is the safe answer: the alternative is a
 * scale of 0 or Infinity, and both render a blank viewer.
 *
 * Truncated to two decimals — **not rounded** — so a one-pixel container change does
 * not re-render every canvas in the document.
 *
 * The distinction is not pedantry; rounding was the first implementation and it is
 * wrong. `Number((992 / 595).toFixed(2))` is 1.67, and 595 × 1.67 = 993.65 — two
 * pixels wider than the 992 available, which is a horizontal scrollbar on the exact
 * layout this phase exists to remove. Rounding up by half a hundredth of a scale
 * factor is a two-pixel overflow on a page that is 600pt wide, and it showed up at
 * five of the nine container widths tested. Truncating can only ever fit.
 */
export function fitScale(
  containerWidth: number | null,
  widestPageWidth: number | null,
  padding: number = PAGE_PADDING,
): number | null {
  if (containerWidth === null || widestPageWidth === null) return null
  if (!Number.isFinite(containerWidth) || !Number.isFinite(widestPageWidth)) return null
  if (containerWidth <= 0 || widestPageWidth <= 0) return null

  const available = containerWidth - padding
  if (available <= 0) return null

  const raw = available / widestPageWidth
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw))
  return Math.floor(clamped * 100) / 100
}

/**
 * The widest page, at scale 1, from a set of page widths.
 *
 * The **widest**, not the first, and that is the whole point of the function
 * existing. A document whose page 3 is a landscape fold-out would, fitted to page 1,
 * render every portrait page correctly and push that one off the right edge — and
 * nothing about the viewer would look wrong, which is the kind of bug that gets
 * reported as "the app cut off my drawing" months later.
 *
 * Returns null for an empty or entirely unreadable set rather than 0: a zero width
 * would divide into an infinite scale.
 */
export function widestPage(widths: readonly number[]): number | null {
  let widest = 0
  for (const width of widths) {
    if (Number.isFinite(width) && width > widest) widest = width
  }
  return widest > 0 ? widest : null
}
