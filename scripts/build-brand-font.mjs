/**
 * Build the self-hosted brand webfont — Phase 9 §1.
 *
 * > **Fonts must be self-hosted** — no Google Fonts, no CDN. Convert `NunitoSans.ttf` to
 * > woff2, subset to latin, drop it in `public/fonts/`, declare `@font-face` with
 * > `font-display: swap`, and preload the one weight above the fold.
 *
 *   node scripts/build-brand-font.mjs
 *
 * Writes `public/fonts/nunito-sans-latin.woff2` into every app, byte-identical, from the
 * source TTF in the brand assets folder. The output is committed; this script is how it
 * is reproduced, not something a build runs.
 *
 * ---------------------------------------------------------------------------
 * Why one variable file rather than two static weights
 *
 * The source is a variable font, and the apps use **five** weights, counted rather than
 * assumed: 400 body, 500 (×26), 600 (×15), 700 panel titles (×3), 800 for the
 * tracked-uppercase label register (×9).
 *
 * Measured both ways before choosing:
 *
 *   variable 400-800, latin + punctuation   72.9 KB   ← one file, all five weights
 *   static 400 / 700 / 800, same subset     ~38 KB each
 *
 * Five statics is about 190 KB and five requests. The variable file is 73 KB and one,
 * and it gives the intermediate weights as real weights rather than as a browser's
 * synthetic bolding — which is what you get when a weight is asked for and absent, and
 * it looks smeared next to the real thing.
 *
 * The other three axes are pinned to their defaults. `opsz`, `wdth` and `YTLC` are
 * genuinely useful in a type specimen and are dead weight in a product UI that never
 * varies them; dropping them is most of the size saving.
 *
 * ---------------------------------------------------------------------------
 * The subset
 *
 * Latin, plus the punctuation this product actually emits. That last part is not
 * decoration: the UI is full of en-dashes and typographic quotes, the em-dash appears in
 * almost every empty state, and `…` is in the loading text — a missing glyph falls back
 * to a different face mid-word, which looks like a rendering bug rather than a subset
 * boundary. `§` is here because the interface quotes spec sections at people.
 *
 * Spanish matters too. The org writes to clients in it, and client names in production
 * already include accented characters, so the accented Latin-1 range is not optional.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCE =
  'C:/Users/const/OneDrive/Desktop/KIRIA ASSETS/Nunito_Sans/' +
  'NunitoSans-VariableFont_YTLC,opsz,wdth,wght.ttf'

const APPS = ['apps/compass-ai', 'apps/compass-admin', 'apps/compass-insights']

/** Basic Latin, Latin-1 accented letters, and the punctuation the UI emits. */
function subsetText() {
  const ranges = [
    [0x20, 0x7e], // printable ASCII
    [0xa0, 0xff], // Latin-1 supplement — accented Spanish, ¿ ¡ £ © ° ·
    [0x2010, 0x2027], // hyphens, dashes, quotes, ellipsis, bullet
    [0x2030, 0x203a], // ‰ ′ ″ ‹ ›
    [0x20ac, 0x20ac], // €
    [0x2192, 0x2192], // → , used in "Compass Admin → Alerts"
    [0x00a7, 0x00a7], // §
  ]
  let out = ''
  for (const [from, to] of ranges) {
    for (let code = from; code <= to; code += 1) out += String.fromCodePoint(code)
  }
  return out
}

const source = readFileSync(SOURCE)

const woff2 = await subsetFont(source, subsetText(), {
  targetFormat: 'woff2',
  // Keep weight variable, pin everything else. `*` would keep all four axes and most of
  // the file size with it.
  variationAxes: { wght: { min: 400, max: 800 } },
})

console.log(
  `source ${(source.length / 1024).toFixed(0)} KB -> woff2 ${(woff2.length / 1024).toFixed(1)} KB ` +
    `(${((1 - woff2.length / source.length) * 100).toFixed(0)}% smaller)`,
)

// A ceiling rather than a target, and set from the measurement above rather than from a
// round number: 73 KB is what this subset costs today, so 90 KB leaves room for a few
// more glyphs and trips if an axis is accidentally un-pinned — which is the mistake that
// would otherwise quintuple it without anybody noticing.
if (woff2.length > 90 * 1024) {
  console.warn(
    `WARNING: ${(woff2.length / 1024).toFixed(0)} KB — the subset has grown well past the ` +
      '73 KB it measured at. Check that only `wght` is variable and that the character ' +
      'ranges have not widened.',
  )
}

for (const app of APPS) {
  const dir = join(ROOT, app, 'public', 'fonts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'nunito-sans-latin.woff2'), woff2)
  console.log(`wrote ${app}/public/fonts/nunito-sans-latin.woff2`)
}
