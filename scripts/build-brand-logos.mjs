/**
 * Prepare the KIRIA wordmark for the apps — Phase 9 §2.
 *
 *   node scripts/build-brand-logos.mjs
 *
 * Reads the two source PNGs from the brand assets folder, trims each to its own ink, and
 * writes `public/brand/wordmark.png` and `wordmark-white.png` into every app.
 *
 * ---------------------------------------------------------------------------
 * Why trim
 *
 * `KIRIA LOGO 1X1.png` is 2000×2000 with the mark occupying the middle third — as a
 * header image that is mostly transparent padding, and every attempt to size it ends up
 * fighting the padding rather than setting the mark's height. The 960×442 crop is
 * closer, but still carries a margin. Trimming to the alpha bounding box makes
 * `height: 22px` mean the wordmark is 22px tall, which is the only way a logo slot is
 * predictable.
 *
 * ---------------------------------------------------------------------------
 * §7.1 stands: these are still raster
 *
 * > **Request SVG versions**: a PNG wordmark at 22px will look soft on a retina screen
 * > and there is no fixing that in CSS.
 *
 * True, and unchanged — no SVG exists in the assets folder. What is fixable is the
 * *degree*: the source is 960px wide for a mark rendered around 110px, so it has roughly
 * 8x the pixels a 2x display needs and downsampling will be clean. It will be sharp
 * enough that nobody files a bug, and it is still not a vector.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = 'C:/Users/const/OneDrive/Desktop/KIRIA ASSETS/'
const APPS = ['apps/compass-ai', 'apps/compass-admin', 'apps/compass-insights']

// --- a minimal PNG codec for 8-bit RGBA, non-interlaced ---------------------
//
// Written out rather than pulled in as a dependency: this runs once to produce committed
// assets, and the two files it has to read are both exactly this format. A dependency
// that exists to be run by hand three times is a dependency somebody has to keep.

function decode(path) {
  const b = readFileSync(path)
  const width = b.readUInt32BE(16)
  const height = b.readUInt32BE(20)
  if (b[24] !== 8 || b[25] !== 6 || b[28] !== 0) {
    throw new Error(`${path}: expected 8-bit RGBA non-interlaced`)
  }

  const idat = []
  let off = 8
  while (off < b.length) {
    const len = b.readUInt32BE(off)
    if (b.toString('latin1', off + 4, off + 8) === 'IDAT') {
      idat.push(b.subarray(off + 8, off + 8 + len))
    }
    off += 12 + len
  }

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const up = prev[x]
      const ul = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += up
      else if (filter === 3) v += (a + up) >> 1
      else if (filter === 4) {
        const p = a + up - ul
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - ul)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul
      }
      cur[x] = v & 0xff
    }
  }
  return { width, height, data: out }
}

function encode({ width, height, data }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'latin1')
    body.copy(out, 8)
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'latin1'), body])), 8 + body.length)
    return out
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Crop to the bounding box of everything with meaningful alpha. */
function trim({ width, height, data }) {
  let top = height
  let left = width
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 8) continue
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  if (right < 0) throw new Error('image is fully transparent')

  const w = right - left + 1
  const h = bottom - top + 1
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    data.copy(out, y * w * 4, ((top + y) * width + left) * 4, ((top + y) * width + left + w) * 4)
  }
  return { width: w, height: h, data: out }
}

/**
 * Downsample by whole-area averaging, in premultiplied alpha.
 *
 * Premultiplying is the part that matters and the part that is easy to skip. The source
 * is a mark on transparency, so the RGB of a fully transparent pixel is arbitrary —
 * often black. Averaging straight RGBA drags that arbitrary colour into every edge pixel
 * and the mark comes back with a dark fringe, which looks like bad anti-aliasing and is
 * actually bad arithmetic.
 */
function downscale({ width, height, data }, maxWidth) {
  if (width <= maxWidth) return { width, height, data }

  const scale = maxWidth / width
  const w = maxWidth
  const h = Math.max(1, Math.round(height * scale))
  const out = Buffer.alloc(w * h * 4)

  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor((y * height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h))
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor((x * width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * width + sx) * 4
          const alpha = data[i + 3] / 255
          r += data[i] * alpha
          g += data[i + 1] * alpha
          b += data[i + 2] * alpha
          a += data[i + 3]
          n += 1
        }
      }

      const o = (y * w + x) * 4
      // Un-premultiply on the way out, guarding the fully-transparent case.
      //
      // The factor is `255 / a`, where both `r` and `a` are sums over the same n source
      // pixels — so n cancels and must NOT appear. Writing `n / (a / 255)` instead made
      // every channel n times too large, everything clamped to 255, and the wordmark
      // came out of the first run as a white silhouette with its subtitle missing
      // entirely. It looked like an alpha bug and was an arithmetic one.
      const k = a > 0 ? 255 / a : 0
      out[o] = Math.min(255, Math.round(r * k))
      out[o + 1] = Math.min(255, Math.round(g * k))
      out[o + 2] = Math.min(255, Math.round(b * k))
      out[o + 3] = Math.round(a / n)
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * The widest the wordmark is ever rendered, times three.
 *
 * It appears at roughly 22px tall in a header (about 49px wide) and around 140px wide in
 * the client empty state. 480px covers the larger of those at 3x, which is more than any
 * shipping display asks for, and it is the difference between 183 KB and something a
 * client's first paint does not wait on.
 */
const MAX_WIDTH = 480

/**
 * Drop the "ADVISORY PARTNERS" line, keeping KIRIA and the pulse rule.
 *
 * **This is the fix for a defect the screenshot review found, not a preference.** The
 * full lockup is 2.23:1, so in a 22px-tall rail slot the tagline renders about three
 * pixels high — not soft, illegible: a grey smudge under the name. §7.1 predicted
 * softness from a raster wordmark; the real problem was that the *primary* lockup is
 * simply the wrong lockup at product scale.
 *
 * Every place this mark appears in the apps is between 22px and 52px tall, and the
 * tagline is unreadable at all of them, so the compact lockup is the only one shipped.
 * An unused full-size variant would be a file the drift test guards and nothing loads.
 *
 * The cut is measured, and measured **from the bottom**. Scanning down for the first
 * blank band does not work: the KIRIA letterforms have detached strokes across their
 * tops, so the first blank row in the image is inside the K, and the first attempt cut
 * there — producing a 480×44 strip at aspect 10.9 instead of a wordmark. Coming up from
 * the bottom, the last ink block is unambiguously the tagline and the blank band above
 * it is unambiguously the gap.
 */
function dropTagline(image) {
  const { width, height, data } = image

  const rowHasInk = (y) => {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 24) return true
    }
    return false
  }

  let y = height - 1
  while (y >= 0 && !rowHasInk(y)) y -= 1 // trailing blank (none, after a trim)
  while (y >= 0 && rowHasInk(y)) y -= 1 // the tagline itself
  while (y >= 0 && !rowHasInk(y)) y -= 1 // the gap above it

  const cut = y + 1
  // Refuse a cut that would keep less than half the mark: that means the shape was not
  // what this expects, and a silently mangled logo is worse than an untrimmed one.
  if (cut < height * 0.5 || cut >= height) {
    console.warn(
      `  (tagline not found in a recognisable place — keeping the full lockup; ` +
        `cut would have been ${cut} of ${height})`,
    )
    return image
  }
  const out = Buffer.alloc(width * cut * 4)
  data.copy(out, 0, 0, width * cut * 4)
  return trim({ width, height: cut, data: out })
}

const sources = [
  ['KIRIA LOGO.png', 'wordmark.png', 'the blue wordmark, for light surfaces'],
  ['KIRIA - logo white.png', 'wordmark-white.png', 'the white wordmark, for dark surfaces'],
]

for (const [source, name, what] of sources) {
  const trimmed = downscale(dropTagline(trim(decode(ASSETS + source))), MAX_WIDTH)
  const png = encode(trimmed)
  console.log(
    `${name}: ${trimmed.width}x${trimmed.height} ` +
      `(aspect ${(trimmed.width / trimmed.height).toFixed(2)}), ` +
      `${(png.length / 1024).toFixed(0)} KB — ${what}`,
  )
  for (const app of APPS) {
    const dir = join(ROOT, app, 'public', 'brand')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), png)
  }
}

// ---------------------------------------------------------------------------
// The favicon, from the brand's own letterform
//
// The wordmark is 2.2:1 — at 16px square it is an illegible smear, which is why the
// first pass shipped a mark I had drawn. Now that the real asset is here, the honest
// favicon is the brand's own K rather than anything of mine: cropped from the wordmark,
// padded to a square, on the brand blue so it reads at tab size.
//
// Cropped by measurement rather than by eye. The K is the first glyph, so the crop is
// "everything left of the first full-height gap in the ink" — which finds the letter
// wherever the wordmark's proportions land, instead of hard-coding pixel offsets that
// would silently mis-crop if the source is ever re-exported.
// ---------------------------------------------------------------------------

function firstGlyph(image) {
  const { width, height, data } = image
  // The wordmark's top band is the KIRIA letterforms; the rule and subtitle sit below.
  const band = Math.floor(height * 0.6)
  const inked = []
  for (let x = 0; x < width; x += 1) {
    let any = false
    for (let y = 0; y < band; y += 1) {
      if (data[(y * width + x) * 4 + 3] > 24) {
        any = true
        break
      }
    }
    inked.push(any)
  }

  let end = 0
  let run = 0
  for (let x = 0; x < width; x += 1) {
    if (inked[x]) {
      run = 0
      end = x
    } else {
      run += 1
      // A gap wider than 2% of the mark is a letter space rather than a counter.
      if (run > width * 0.02 && end > 0) break
    }
  }

  let top = band
  let bottom = 0
  for (let y = 0; y < band; y += 1) {
    for (let x = 0; x <= end; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= 24) continue
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }

  const w = end + 1
  const h = bottom - top + 1
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    data.copy(out, y * w * 4, ((top + y) * width) * 4, ((top + y) * width + w) * 4)
  }
  return { width: w, height: h, data: out }
}

/** Composite onto an opaque square of `bg`, with the glyph inset and centred. */
function onSquare(glyph, size, bg, inset = 0.24) {
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = bg[0]
    out[i * 4 + 1] = bg[1]
    out[i * 4 + 2] = bg[2]
    out[i * 4 + 3] = 255
  }

  const box = Math.round(size * (1 - inset * 2))
  const scale = Math.min(box / glyph.width, box / glyph.height)
  const w = Math.max(1, Math.round(glyph.width * scale))
  const h = Math.max(1, Math.round(glyph.height * scale))
  const small = downscale(glyph, w)
  const offX = Math.round((size - w) / 2)
  const offY = Math.round((size - small.height) / 2)

  for (let y = 0; y < small.height; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = (y * w + x) * 4
      const alpha = small.data[si + 3] / 255
      if (alpha <= 0) continue
      const di = ((offY + y) * size + (offX + x)) * 4
      if (offY + y < 0 || offY + y >= size) continue
      // The glyph is drawn in white over the brand blue: the wordmark's own gradient is
      // mid-blue on white and would vanish on it.
      for (let c = 0; c < 3; c += 1) {
        out[di + c] = Math.round(255 * alpha + out[di + c] * (1 - alpha))
      }
    }
  }
  return { width: size, height: size, data: out }
}

const wordmark = trim(decode(ASSETS + 'KIRIA LOGO.png'))
const icon = onSquare(firstGlyph(wordmark), 128, [0x00, 0x4a, 0xad])
const iconPng = encode(icon)
console.log(`favicon.png: 128x128, ${(iconPng.length / 1024).toFixed(0)} KB — the brand K on --kiria-blue`)
for (const app of APPS) {
  writeFileSync(join(ROOT, app, 'public', 'brand', 'favicon.png'), iconPng)
}

console.log(`\nwritten into ${APPS.length} apps`)
