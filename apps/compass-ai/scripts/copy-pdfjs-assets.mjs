/**
 * Copy PDF.js character maps and standard font data into `public/pdfjs/`.
 *
 * PDF.js loads these at runtime by URL, not by import, so Vite cannot bundle them.
 * Without the cmaps, text in CJK and custom-encoded PDFs renders blank; without the
 * standard font data, PDFs relying on the base-14 fonts fall back to substitutes with
 * wrong metrics. Serving them from `public/` keeps them same-origin and versioned
 * with the deploy instead of depending on a CDN.
 *
 * Runs from `prebuild` and `predev`, and is a no-op when already up to date.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// Resolve the installed package rather than assuming a node_modules layout.
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
const target = join(appRoot, 'public', 'pdfjs')

const assets = ['cmaps', 'standard_fonts']

function countFiles(directory) {
  try {
    return readdirSync(directory).length
  } catch {
    return 0
  }
}

let copied = 0
mkdirSync(target, { recursive: true })

for (const asset of assets) {
  const source = join(pdfjsRoot, asset)
  if (!existsSync(source)) {
    throw new Error(`pdfjs-dist is missing "${asset}" at ${source}`)
  }

  const destination = join(target, asset)
  // Only recopy when the file count differs, so repeated dev starts stay instant.
  if (countFiles(destination) === countFiles(source)) continue

  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, { recursive: true })
  copied += 1
}

console.log(
  copied > 0
    ? `[pdfjs] copied ${assets.join(', ')} into public/pdfjs`
    : '[pdfjs] assets already up to date',
)
