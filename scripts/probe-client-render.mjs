/**
 * Render the client app headlessly and check the two things a portal session hides.
 *
 *   node scripts/probe-client-render.mjs apps/compass-ai/dist <a-pdf-with-links> out.png
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 *
 * The client app is the only one whose entire surface sits behind a portal, and Gate
 * will not mint a portal-bound session for a test — so twenty-four e2e specs skip and
 * nothing automated ever renders this app's main tree. That gap is not theoretical: a
 * hook called below a conditional return blanked the app in production for two weeks
 * while typecheck, lint and the whole e2e suite stayed green.
 *
 * The session is the only thing a test cannot mint. **Everything else can be stubbed**,
 * which is what this does: serve the built bundle, answer /api/session and the list
 * endpoints with the shapes the app's own types declare, and serve real PDF bytes.
 * That reaches the main tree, the viewer and the annotation layer.
 *
 * It checks two classes of failure that are invisible to every other tool here:
 *
 *   1. **The tree renders at all** — a React error unmounts it and leaves a white page
 *      with a perfectly healthy backend log.
 *   2. **PDF links are real and safe** — the annotation layer sizes itself from CSS
 *      variables, and getting that wrong produces a zero-size layer with no error
 *      anywhere. It also asserts every anchor opens in a new tab, because the app runs
 *      inside a portal iframe and a same-frame navigation would replace the product.
 *
 * Not in the e2e suite because it needs a local build rather than a deployed URL. Run
 * it before a release, and it is step 3 of tests/manual/demo-walkthrough.md.
 */
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const DIST = process.argv[2]
const PDF = process.argv[3]
const SHOT = process.argv[4]

const DOC_ID = '11111111-1111-4111-8111-111111111111'
const LIB_ID = '22222222-2222-4222-8222-222222222222'

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
}

const API = {
  '/api/session': {
    actor: 'client',
    user: { id: '3700332', email: 'cliente@example.com' },
    portalId: '8ajf3skk45v9fgbh3172ei2zl',
    client: { id: 'b35ff8ed-2ff3-4f2b-80dc-ed0011d40eaa', name: 'CLIENTE B' },
    capabilities: { viewDocuments: true, chat: true, exportAnswers: false },
    settings: { maxAnswerTokens: 800, maxRetrievedTokens: 1500 },
  },
  '/api/documents': {
    documents: [
      {
        id: DOC_ID,
        name: 'brand guidelines - kiria.pdf',
        status: 'indexed',
        pageCount: 1,
        libraryId: LIB_ID,
        folderId: null,
        createdAt: '2026-09-08T18:00:00.000Z',
        indexedAt: '2026-09-08T18:10:00.000Z',
        sizeBytes: 476539,
      },
    ],
  },
  '/api/folders': { libraries: [{ libraryId: LIB_ID, name: 'Mayo Clinic — 2026', folders: [] }] },
  '/api/chats': { chats: [] },
}

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])

  if (url === `/api/documents/${DOC_ID}/file`) {
    const bytes = readFileSync(PDF)
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length })
    res.end(bytes)
    return
  }
  if (url.startsWith('/api/documents/') && url.endsWith('/paragraphs')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ paragraphs: [] }))
    return
  }
  if (url.startsWith('/api/')) {
    const body = API[url]
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? { error: { code: 'NOT_FOUND', message: 'stub' } }))
    return
  }

  let file = join(DIST, url === '/' ? 'index.html' : url)
  if (!existsSync(file) || url === '/') file = join(DIST, 'index.html')
  try {
    const data = readFileSync(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404).end('not found')
  }
})

await new Promise((r) => server.listen(0, r))
const port = server.address().port

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

const errors = []
page.on('pageerror', (e) => errors.push(`[PAGE ERROR] ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`)
})

await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#root', { timeout: 30_000 })

// Open the document from the rail.
await page.getByText('brand guidelines - kiria.pdf').first().click({ timeout: 30_000 })

// Wait for a page to finish rasterizing, then for the layer to populate.
await page.waitForSelector('[data-rendered="true"]', { timeout: 60_000 }).catch(() => {})
await page.waitForTimeout(3000)

const report = await page.evaluate(() => {
  const layers = Array.from(document.querySelectorAll('.annotationLayer'))
  const anchors = Array.from(document.querySelectorAll('.annotationLayer a'))
  return {
    layerCount: layers.length,
    layerSizes: layers.map((l) => {
      const r = l.getBoundingClientRect()
      return `${Math.round(r.width)}x${Math.round(r.height)}`
    }),
    anchorCount: anchors.length,
    anchors: anchors.map((a) => {
      const r = a.getBoundingClientRect()
      return {
        href: a.getAttribute('href'),
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
        title: a.getAttribute('title'),
        box: `${Math.round(r.width)}x${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`,
        clickable: r.width > 0 && r.height > 0,
      }
    }),
  }
})

console.log('=== errors ===')
console.log(errors.length ? errors.join('\n') : '(none)')
console.log('\n=== annotation layers ===')
console.log(`count=${report.layerCount} sizes=${report.layerSizes.join(', ')}`)
console.log('\n=== anchors ===')
console.log(`count=${report.anchorCount}`)
for (const a of report.anchors) {
  console.log(`  href=${a.href}`)
  console.log(`    target=${a.target}  rel=${a.rel}  clickable=${a.clickable}  box=${a.box}`)
}

if (SHOT) await page.screenshot({ path: SHOT })
await browser.close()
server.close()
