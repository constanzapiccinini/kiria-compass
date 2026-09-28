/**
 * Static invariants that no type checker can see.
 *
 * Three guards, each of which exists because the thing it checks shipped broken once:
 *
 *   1. **Library ingest caps** must match the migration defaults, or a library
 *      document is quietly ingested under a different ceiling than a tenant's.
 *   2. **§6.5 visibility** — a document query may use a tenancy predicate as a UNION
 *      term but never as its whole scope. Filtering on `client_id` alone hid every
 *      library document from staff on production.
 *   3. **`${…}` inside a single-quoted string** — well-typed, lint-clean, and wrong.
 *   4. **No caller of a route §6A.1 deleted.** A route can be removed from the
 *      backend while a screen still calls it; the call then fails at runtime, in a
 *      place unrelated to the deletion.
 *   5. **The fit-to-width arithmetic** (§7.2) — the one part of the layout phase a
 *      test can reach without a browser. What that does and does not prove is
 *      written above the block itself.
 *   6. **Economy and the download buttons stay gone** (§7.5, §7.6). Each was removed
 *      by deleting a control, which is a one-line change to undo by accident.
 *   7. **No gap in a statement's `$n` placeholders.** Postgres refuses a prepared
 *      statement that declares a parameter it never uses, and the indexing screen
 *      shipped a 500 for a day because of it.
 *   8. **Clustering is deterministic, and its cost is measured** (§5, §8 of Phase 8).
 *      Including the property it does NOT have — stability under insertion — so a
 *      month-over-month comparison is not built on an assumption.
 *   9. **The flagging job keeps both of its filters.** Losing one sends an opted-out
 *      client's text to a model; losing the other re-screens every clean question
 *      forever. Neither shows up in the run's own output.
 *  10. **The flag parser can return a flag.** "Nothing was flagged" and "the parser
 *      never matches" are the same number, and the first production run reported it.
 *
 * The source-config cases that this file was named after are gone with the feature
 * they tested. `config.filter` was a boolean expression that could not be
 * parameterised, which made it the codebase's one SQL-injection surface and worth
 * eleven test cases; §6A.1 deleted the table-source reader, the sync scheduler and
 * the config parser, because nothing in either environment had ever used them. There
 * is no authored text going into SQL any more, so there is nothing left to validate —
 * the surface was removed rather than defended.
 *
 * Run: npm test  (from apps/compass-ai/backend)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { LIBRARY_INGEST_SETTINGS } from '../src/lib/settings.js'
import { fitScale, widestPage, MIN_SCALE, MAX_SCALE, PAGE_PADDING } from '../../src/lib/fit.js'
import { parseFlagReply } from '../src/lib/insights.js'

let failures = 0

// ---------------------------------------------------------------------------
// library ingest caps (§5B)
//
// A library has no `client_settings` row to read, so these constants stand in for
// one. The risk they carry is drift: if the column defaults in `0001_init.sql` or
// `0002_batch_embeddings.sql` are ever edited, a library document would quietly be
// ingested under different caps than a new tenant's first upload.
//
// This cannot compare against the live database without a network call, so it pins
// the two properties that actually matter. A budget silently becoming a number would
// mean a library document is charged against a per-tenant allowance that no single
// tenant owns; and a cap silently becoming null would remove the ceiling on a single
// runaway scan.
// ---------------------------------------------------------------------------

if (LIBRARY_INGEST_SETTINGS.monthlyTokenBudget !== null) {
  console.log('FAIL (a library must not carry a per-tenant monthly token budget)'); failures++
}
if (LIBRARY_INGEST_SETTINGS.monthlyOcrPageBudget !== null) {
  console.log('FAIL (a library must not carry a per-tenant monthly OCR budget)'); failures++
}
if (
  !Number.isInteger(LIBRARY_INGEST_SETTINGS.maxOcrPagesPerUpload) ||
  LIBRARY_INGEST_SETTINGS.maxOcrPagesPerUpload <= 0
) {
  console.log('FAIL (a library still needs a per-upload OCR page cap)'); failures++
}
// Mirrors 0001/0002 exactly. Any change here should be a deliberate edit made
// alongside the migration, not a surprise.
const expectedLibraryCaps = {
  retrievalMode: 'precision',
  maxAnswerTokens: 800,
  maxRetrievedTokens: 1500,
  maxOcrPagesPerUpload: 10000,
  ocrTablesEnabled: false,
  ocrFormsEnabled: false,
  ocrQueriesEnabled: false,
  batchEmbeddingEnabled: false,
  batchEmbeddingMinChunks: 400,
}
for (const [key, expected] of Object.entries(expectedLibraryCaps)) {
  const actual = LIBRARY_INGEST_SETTINGS[key as keyof typeof expectedLibraryCaps]
  if (actual !== expected) {
    console.log(
      `FAIL (library cap ${key} is ${JSON.stringify(actual)}, migration default is ${JSON.stringify(expected)})`,
    )
    failures++
  }
}

// ---------------------------------------------------------------------------
// §6.5: no document read in this app may filter on `client_id`
//
// A static check, deliberately, because this trap has now been sprung twice and both
// times it was invisible at runtime:
//
//   Phase 4 — an upload with no `source_id` was indexed, paid for, and visible in
//             zero portals. It looked fine to whoever uploaded it.
//   Phase 5 — the employee branch of `GET /api/documents` filtered on `client_id`, so
//             every LIBRARY document (which has `client_id = NULL` by design) was
//             hidden from staff in the list and 404'd on open, while the chat happily
//             cited it. Measured on production: 0 documents for staff, 1 for a client.
//
// The rule is **not** "never mention client_id". Staff legitimately read
// `d.client_id = $n OR EXISTS (… portal_documents_admin …)`, because a document whose
// source lost its binding appears in no portal view and staff must still reach it.
// The invariant is narrower and is the one §6.5 actually draws:
//
//   a tenancy predicate may be a UNION term, never the whole scope.
//
// So every SQL statement that mentions `client_id = $` must also reach a portal. The
// first version of this guard just banned the column and would have blocked the
// correct fix — a check that forbids the right answer is worse than no check.
// ---------------------------------------------------------------------------

const documentRoutesSource = readFileSync(
  new URL('../src/routes/documents.ts', import.meta.url),
  'utf8',
)

/** Every template-literal in the file — which is where all of its SQL lives. */
const sqlStatements = [...documentRoutesSource.matchAll(/`([^`]*)`/g)]
  .map((match) => match[1])
  .filter((text) => /\bFROM\b/i.test(text) && /\bdocuments\b/.test(text))

if (sqlStatements.length === 0) {
  console.log('FAIL (§6.5: found no document SQL to check — did the file move?)')
  failures++
}

for (const statement of sqlStatements) {
  const scopesByTenant = /client_id\s*=\s*\$/.test(statement)
  const reachesPortal = /portal_id\s*=\s*\$|portal_visible_documents|portal_documents_admin/.test(
    statement,
  )
  if (scopesByTenant && !reachesPortal) {
    console.log(
      'FAIL (§6.5: a document query is scoped by client_id alone, which hides every ' +
        'library and group document):\n      ' +
        statement.replace(/\s+/g, ' ').trim().slice(0, 160),
    )
    failures++
  }
  if (!scopesByTenant && !reachesPortal) {
    console.log(
      'FAIL (§6.5: a document query has no portal scope at all):\n      ' +
        statement.replace(/\s+/g, ' ').trim().slice(0, 160),
    )
    failures++
  }
}

// ---------------------------------------------------------------------------
// `${…}` inside a single-quoted string
//
// A whole class of bug that `tsc` cannot see, because the string is well-typed
// either way. It bit while parameterising `lib/folders.ts` on its owner: three SQL
// statements were plain single-quoted strings before the change, and inserting
// `${owner.column}` into them put those eleven characters into the SQL itself. It
// type-checks, it lints, and it fails the first time a folder is created.
//
// Both backends are scanned rather than just this one: the hazard is the same in
// each, and there is one test runner. Reading the sibling app's source from here is
// unusual and deliberate — the alternative is a second runner for one check.
// ---------------------------------------------------------------------------

const backendRoots = [
  new URL('../src/', import.meta.url),
  new URL('../../../compass-admin/backend/src/', import.meta.url),
]

function sourceFiles(dir: URL): URL[] {
  const found: URL[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) found.push(...sourceFiles(child))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(child)
  }
  return found
}

/**
 * True when this line opens a single-quoted string and writes `${` inside it.
 *
 * A regex cannot answer this. The first attempt was `/'[^'\n]*\$\{/` and it reported
 * three false failures, each a different way of being wrong:
 *
 *   `${present.join(' ')} otherKeys=…`      an apostrophe-quoted string INSIDE a
 *                                           template's interpolation
 *   `Type the portal's name ("${label}")`   an apostrophe in prose
 *   'content-disposition': `…${filename}…`  a quoted object key, then a template
 *
 * So this walks the line instead, tracking what kind of string it is inside, with a
 * stack because a template's `${…}` can contain another string. Fifteen lines to
 * avoid a check that cries wolf — and a check that cries wolf gets deleted by
 * whoever hits it next, which would take the real protection with it.
 */
function hasLiteralInterpolation(line: string): boolean {
  const stack: Array<'single' | 'double' | 'template' | 'interp'> = []
  let i = 0

  while (i < line.length) {
    const top = stack[stack.length - 1]
    const ch = line[i]

    if (top === 'single' || top === 'double') {
      if (ch === '\\') { i += 2; continue }
      if (ch === (top === 'single' ? "'" : '"')) { stack.pop(); i += 1; continue }
      if (top === 'single' && line.startsWith('${', i)) return true
      i += 1
      continue
    }

    if (top === 'template') {
      if (ch === '\\') { i += 2; continue }
      if (line.startsWith('${', i)) { stack.push('interp'); i += 2; continue }
      if (ch === '`') { stack.pop(); i += 1; continue }
      i += 1
      continue
    }

    // Outside any string, or inside a template's interpolation.
    if (ch === "'") { stack.push('single'); i += 1; continue }
    if (ch === '"') { stack.push('double'); i += 1; continue }
    if (ch === '`') { stack.push('template'); i += 1; continue }
    if (top === 'interp' && ch === '}') { stack.pop(); i += 1; continue }
    i += 1
  }
  return false
}

for (const root of backendRoots) {
  for (const file of sourceFiles(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      // Comments discuss this pattern — including the one above — so they are skipped.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (!hasLiteralInterpolation(line)) return
      const name = decodeURIComponent(file.pathname.split('/').slice(-2).join('/'))
      console.log(
        `FAIL (\${…} inside a single-quoted string — it will not interpolate) ` +
          `${name}:${index + 1}\n      ${line.trim().slice(0, 140)}`,
      )
      failures++
    })
  }
}

// ---------------------------------------------------------------------------
// §6A.1: nothing calls a route that no longer exists
//
// The phase deleted the table-source feature — `routes/sources.ts`,
// `lib/source-config.ts`, both screens — and the client-scoped document listing and
// upload with it. TypeScript cannot see any of that: a fetch URL is a string, so a
// screen calling `/api/sources` still compiles, still lints, and fails only when a
// person opens it.
//
// Matched on the URL shapes rather than on method names, because the method names
// were deleted too — what would survive a careless re-add is the string. `clientId`
// as a *query parameter on a document route* is the tell for the pre-§6A.2 shape:
// documents and folders are addressed by library now, and `/api/settings?clientId=`
// is still perfectly correct, which is why the patterns name their routes.
// ---------------------------------------------------------------------------

const removedRouteCalls: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /['"`]\/api\/sources/, why: 'the source routes were deleted by §6A.1' },
  {
    pattern: /\/api\/documents\?clientId=/,
    why: 'the client-scoped document listing and upload were deleted by §6A.1',
  },
  {
    pattern: /\/api\/documents\/folders\?clientId=/,
    why: 'a folder tree is read by libraryId since §6A.2',
  },
  {
    pattern: /\/api\/indexing\?clientId=/,
    why: 'indexing health is read by portalRowId since §6A.2 — a library document has no client_id',
  },
]

const spaRoots = [
  new URL('../../src/', import.meta.url),
  new URL('../../../compass-admin/src/', import.meta.url),
]

for (const root of spaRoots) {
  for (const file of sourceFiles(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      // Comments discuss these routes by name — including the ones explaining why
      // they are gone — so they are skipped.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      for (const { pattern, why } of removedRouteCalls) {
        if (!pattern.test(line)) continue
        const name = decodeURIComponent(file.pathname.split('/').slice(-3).join('/'))
        console.log(
          `FAIL (§6A.1: a screen calls a route that no longer exists — ${why}) ` +
            `${name}:${index + 1}\n      ${line.trim().slice(0, 140)}`,
        )
        failures++
      }
    })
  }
}

// ---------------------------------------------------------------------------
// §7.2: fit to width
//
// The complaint this phase answers — "I only see the whole document if I close both
// sidebars" — is arithmetic. At the old fixed `scale = 1.1`, a US Letter page wants
// ~673px, and the sidebar (288) + thumbnail rail (132) + padding (32) + floating chat
// (416) want 868px more than most portal iframes have.
//
// **What this proves and what it does not.** It proves the computed scale never asks
// for more width than the container has, that it respects the clamps, and that it
// uses the widest page rather than the first. It does **not** prove the page is
// visibly on screen — that needs a browser at three viewports, which §7.8 asks for
// and which cannot run here: the client app requires a portal-bound session, Gate
// exposes no way to mint one, and a test that skips is worth nothing. So the browser
// half of §7.8 is an open gap, recorded in PHASE-7-COMPLETE.md rather than papered
// over with a skipped spec.
// ---------------------------------------------------------------------------

/** US Letter and A4 at scale 1, in CSS px — the two sizes that actually turn up. */
const LETTER = 612
const A4 = 595

// The invariant, stated directly: a fitted page never wants more room than it has.
for (const containerWidth of [320, 480, 640, 768, 900, 1024, 1280, 1440, 1920]) {
  for (const pageWidth of [A4, LETTER, 842, 1224]) {
    const scale = fitScale(containerWidth, pageWidth)
    if (scale === null) {
      console.log(
        `FAIL (§7.2: no scale for a ${containerWidth}px container and a ${pageWidth}pt page)`,
      )
      failures++
      continue
    }
    const rendered = pageWidth * scale
    const available = containerWidth - PAGE_PADDING
    // MIN_SCALE is a floor the clamp enforces, so a very narrow container legitimately
    // overflows rather than rendering an unreadable page. That case is excluded here
    // and asserted directly below.
    if (scale > MIN_SCALE && rendered > available + 1) {
      console.log(
        `FAIL (§7.2: a ${pageWidth}pt page at scale ${scale} wants ${Math.round(rendered)}px ` +
          `but only ${available}px is available in a ${containerWidth}px container)`,
      )
      failures++
    }
  }
}

// The clamps hold at both ends.
if (fitScale(200, LETTER) !== MIN_SCALE) {
  console.log(`FAIL (§7.2: a container too narrow for MIN_SCALE returned ${fitScale(200, LETTER)})`)
  failures++
}
if (fitScale(4000, A4) !== MAX_SCALE) {
  console.log('FAIL (§7.2: a very wide container was not clamped to MAX_SCALE)')
  failures++
}

// Null rather than 0 or Infinity for every degenerate input. Each of these renders a
// blank viewer if it comes back as a number.
const degenerate: Array<[number | null, number | null, string]> = [
  [null, LETTER, 'unmeasured container'],
  [900, null, 'unmeasured document'],
  [0, LETTER, 'zero-width container'],
  [900, 0, 'zero-width page'],
  [PAGE_PADDING, LETTER, 'container exactly as wide as its padding'],
  [Number.NaN, LETTER, 'NaN container'],
  [900, Number.POSITIVE_INFINITY, 'infinite page width'],
]
for (const [container, page, label] of degenerate) {
  const scale = fitScale(container, page)
  if (scale !== null) {
    console.log(`FAIL (§7.2: ${label} produced a scale of ${scale}, expected null)`)
    failures++
  }
}

// Two decimals, so a one-pixel container change does not re-render every canvas.
const rounded = fitScale(1001, 777)
if (rounded !== null && String(rounded).replace(/^\d+\./, '').length > 2) {
  console.log(`FAIL (§7.2: the scale ${rounded} is not rounded to two decimals)`)
  failures++
}

// The widest page decides, not the first. A document whose page 3 is a landscape
// fold-out must not be pushed off the right edge while every other page looks right —
// which is exactly what fitting to page 1 does.
const mixed = [A4, A4, 842, A4]
if (widestPage(mixed) !== 842) {
  console.log(`FAIL (§7.2: widestPage picked ${widestPage(mixed)} out of ${mixed.join(', ')})`)
  failures++
}
if (widestPage([]) !== null || widestPage([0, Number.NaN]) !== null) {
  console.log('FAIL (§7.2: an unreadable page set must be null, not 0 — 0 divides into Infinity)')
  failures++
}
const fitToWidest = fitScale(900, widestPage(mixed))
const fitToFirst = fitScale(900, mixed[0])
if (fitToWidest === null || fitToFirst === null || fitToWidest >= fitToFirst) {
  console.log('FAIL (§7.2: fitting to the widest page is not tighter than fitting to the first)')
  failures++
}

// ---------------------------------------------------------------------------
// §7.5 and §7.6: Economy and the downloads stay gone
//
// Both were removed by deleting a control, which is a one-line change to undo by
// accident — and the backend now refuses `retrievalMode` outright, so a restored
// toggle would send a patch that 400s from a screen that looks perfectly fine.
// ---------------------------------------------------------------------------

const goneFromUi: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\beconomy\b/i, why: 'Economy mode was removed by §7.5' },
  { pattern: /downloadMarkdown|safeFilename/, why: 'the download helpers were removed by §7.6' },
  {
    pattern: /Download conversation|Download \.md/,
    why: 'the download buttons were removed by §7.6',
  },
]

for (const root of spaRoots) {
  for (const file of sourceFiles(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      // Comments explain the removals by name, so they are skipped.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      for (const { pattern, why } of goneFromUi) {
        if (!pattern.test(line)) continue
        const name = decodeURIComponent(file.pathname.split('/').slice(-3).join('/'))
        console.log(
          `FAIL (§7: a removed control is back — ${why}) ${name}:${index + 1}\n` +
            `      ${line.trim().slice(0, 140)}`,
        )
        failures++
      }
    })
  }
}

// ---------------------------------------------------------------------------
// A gap in a statement's `$n` placeholders
//
// Postgres refuses a prepared statement that declares a parameter it never uses:
// `could not determine data type of parameter $1`, because there is no context from
// which to infer the type. A statement using `$2` and `$3` but not `$1` is therefore
// always broken — and the shape is invisible to everything else. It type-checks, it
// lints, the SQL reads correctly, and the failure is a 400 from Gate that the app
// turns into a plain 500.
//
// It shipped. `GET /api/indexing` was rewritten in §6A.2 to take a portal instead of
// a tenant, and three of its statements kept receiving all three arguments while
// mentioning only two of them. The indexing screen returned 500 for a day, and the
// e2e suite is what caught it — after the deploy, not before.
//
// The check is textual and exact: within one statement the placeholders used must be
// exactly 1..max with nothing missing. It says nothing about how many arguments the
// caller passes — that is genuinely not knowable from the text — but this half is the
// half that was wrong.
// ---------------------------------------------------------------------------

/** Statement-shaped literals only: a fragment may legitimately start at `$2`. */
function looksLikeStatement(text: string): boolean {
  return (
    (/\bSELECT\b/i.test(text) && /\bFROM\b/i.test(text)) ||
    /\bINSERT\s+INTO\b/i.test(text) ||
    (/\bUPDATE\b/i.test(text) && /\bSET\b/i.test(text)) ||
    /\bDELETE\s+FROM\b/i.test(text)
  )
}

for (const root of [...backendRoots, ...spaRoots]) {
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/`([^`]*)`/g)) {
      const text = match[1]
      if (!looksLikeStatement(text)) continue

      const used = new Set(
        [...text.matchAll(/\$(\d+)/g)].map((placeholder) => Number(placeholder[1])),
      )
      if (used.size === 0) continue

      const highest = Math.max(...used)
      const missing: number[] = []
      for (let n = 1; n <= highest; n += 1) if (!used.has(n)) missing.push(n)
      if (missing.length === 0) continue

      const line = source.slice(0, match.index).split('\n').length
      const name = decodeURIComponent(file.pathname.split('/').slice(-3).join('/'))
      console.log(
        `FAIL (a statement declares $${highest} but never uses $${missing.join(', $')} — ` +
          `Postgres cannot infer the type of an unused parameter and refuses the whole ` +
          `statement) ${name}:${line}\n      ` +
          text.replace(/\s+/g, ' ').trim().slice(0, 160),
      )
      failures++
    }
  }
}

// ---------------------------------------------------------------------------
// §5 and §8: clustering is deterministic, and "a few thousand vectors in JS is fine"
// is measured rather than repeated
//
// §5 says the quiet part out loud — "measure before assuming otherwise" — so the last
// block here times the real thing instead of quoting the spec back.
//
// §8 asks whether clustering is deterministic for a fixed input. It is, for a fixed
// *set*; it is not stable under insertion, and no greedy scheme is. Both properties
// are asserted, because the second one is the one someone will otherwise assume away
// when they compare two months.
// ---------------------------------------------------------------------------

const {
  clusterByThreshold,
  cosine,
  isUnitLength,
  DEFAULT_THRESHOLD,
} = await import('../src/lib/clustering.js')

/** A deterministic pseudo-random generator, so a failure is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

/**
 * A unit vector at a **known** cosine to `base`.
 *
 * `base * weight + orthogonal * sqrt(1 - weight²)`, normalised — so the cosine to
 * `base` is `weight`, by construction rather than by hope.
 *
 * The first fixture added uniform noise and trusted a spread parameter to land the
 * similarity somewhere sensible. At 256 dimensions it did not: every vector came out
 * nearly orthogonal to its own centre, the test reported "the threshold is wrong", and
 * the fixture was at least as much to blame. A test whose inputs are not understood
 * cannot tell you which side the bug is on.
 */
function atCosine(
  base: readonly number[],
  weight: number,
  random: () => number,
): number[] {
  // A random direction, then the component along `base` removed, leaving something
  // orthogonal to it.
  const raw = Array.from({ length: base.length }, () => random() - 0.5)
  let dot = 0
  for (let i = 0; i < base.length; i += 1) dot += raw[i] * base[i]
  const perpendicular = raw.map((value, i) => value - dot * base[i])

  let sumSquares = 0
  for (const value of perpendicular) sumSquares += value * value
  const magnitude = Math.sqrt(sumSquares)
  const unitPerpendicular = perpendicular.map((value) => value / magnitude)

  const across = Math.sqrt(Math.max(0, 1 - weight * weight))
  return base.map((value, i) => value * weight + unitPerpendicular[i] * across)
}

const DIMS = 256
const random = makeRandom(20260909)

/**
 * Three centres, mutually near-orthogonal — which is what random high-dimensional
 * vectors are, and is why real unrelated questions sit at 0.15.
 */
const centres = [0, 1, 2].map(() => {
  const raw = Array.from({ length: DIMS }, () => random() - 0.5)
  let sumSquares = 0
  for (const value of raw) sumSquares += value * value
  const magnitude = Math.sqrt(sumSquares)
  return raw.map((value) => value / magnitude)
})

/** Members sit at 0.80 from their own centre; centres sit near 0 from each other. */
const MEMBER_COSINE = 0.8
/** Between the two, so "same cluster" and "different cluster" are unambiguous. */
const TEST_THRESHOLD = 0.5

const items = centres.flatMap((centre, centreIndex) =>
  Array.from({ length: 8 }, (_, memberIndex) => ({
    // Ids deliberately NOT in centre order, so a run that depended on input order
    // rather than on the sort would produce different clusters.
    id: `${(memberIndex * 3 + centreIndex).toString().padStart(3, '0')}-c${centreIndex}`,
    vector: atCosine(centre, MEMBER_COSINE, random),
    clientId: `client-${centreIndex % 2}`,
  })),
)

// The fixture states what it is, then checks it. Without this the assertions below are
// about an input nobody has verified.
{
  // Items are generated centre by centre — eight of centre 0, then eight of centre 1
  // — so 0 and 3 are the SAME centre and 0 and 8 are different. The first version of
  // this check compared items[0] with items[1] and reported two members of one centre
  // as "different centres above the threshold", blaming the fixture for working.
  const sameCentre = cosine(items[0].vector, items[3].vector)
  const otherCentre = cosine(items[0].vector, items[8].vector)
  if (!(sameCentre > TEST_THRESHOLD)) {
    console.log(
      `FAIL (the fixture is wrong, not the code: two members of one centre sit at ` +
        `${sameCentre.toFixed(3)}, below the ${TEST_THRESHOLD} test threshold)`,
    )
    failures++
  }
  if (!(otherCentre < TEST_THRESHOLD)) {
    console.log(
      `FAIL (the fixture is wrong, not the code: members of different centres sit at ` +
        `${otherCentre.toFixed(3)}, above the ${TEST_THRESHOLD} test threshold)`,
    )
    failures++
  }
}

// --- the vectors this operates on must be unit length ---------------------
//
// The whole module treats a dot product as the cosine. A non-unit vector would make
// every similarity too small, every cluster too fine, and the screen quietly wrong
// with nothing to see.
for (const item of items) {
  if (!isUnitLength(item.vector)) {
    console.log('FAIL (§5: a test vector is not unit length, so cosine != dot product)')
    failures++
    break
  }
}

if (Math.abs(cosine(items[0].vector, items[0].vector) - 1) > 1e-6) {
  console.log('FAIL (§5: a unit vector is not similarity 1 with itself)')
  failures++
}

// --- deterministic for a fixed input --------------------------------------
const first = clusterByThreshold(items, TEST_THRESHOLD)
const second = clusterByThreshold([...items].reverse(), TEST_THRESHOLD)

const shape = (clusters: ReturnType<typeof clusterByThreshold>): string =>
  JSON.stringify(clusters.map((c) => c.members.map((m) => m.id)))

if (shape(first) !== shape(second)) {
  console.log(
    'FAIL (§8: clustering is not deterministic — the same set in a different input ' +
      `order produced different clusters)\n      forward: ${shape(first).slice(0, 120)}` +
      `\n      reversed: ${shape(second).slice(0, 120)}`,
  )
  failures++
}

// --- the clusters are the ones planted ------------------------------------
//
// Not just "it produced some clusters": three separated centres must come back as
// three groups, or the threshold is doing nothing and every question is its own theme.
if (first.length !== 3) {
  console.log(
    `FAIL (§5: three well-separated centres produced ${first.length} cluster(s), not 3 — ` +
      `the threshold ${DEFAULT_THRESHOLD} is wrong for 256-dimension embeddings)`,
  )
  failures++
} else {
  for (const cluster of first) {
    const suffixes = new Set(cluster.members.map((m) => m.id.split('-')[1]))
    if (suffixes.size !== 1) {
      console.log(
        `FAIL (§5: a cluster mixes centres — ${[...suffixes].join(', ')} — so the ` +
          'threshold is too loose',
      )
      failures++
    }
  }
}

// --- clientCount is the k in k-anonymity ----------------------------------
//
// §2's CHECK refuses an org theme below three clients, and this is the number that
// feeds it. If it counted rows rather than distinct clients, a theme asked eight times
// by one client would look like eight clients and clear the threshold.
for (const cluster of first) {
  if (cluster.clientCount > 2) {
    console.log(
      `FAIL (§2: a cluster reports ${cluster.clientCount} clients, but the fixture only ` +
        'has two — clientCount is counting members rather than distinct clients)',
    )
    failures++
    break
  }
}

// --- and it is NOT stable under insertion, which is stated not hidden ------
//
// Asserted so the limitation is a tested fact rather than a comment. If a future
// change made clustering insertion-stable, this test fails and the docblock in
// clustering.ts — and any month-over-month claim built on it — gets revisited
// deliberately.
const midpoint = (() => {
  const raw = centres[0].map((value, index) => value + centres[1][index])
  let sumSquares = 0
  for (const value of raw) sumSquares += value * value
  const magnitude = Math.sqrt(sumSquares)
  return raw.map((value) => value / magnitude)
})()
const bridging = {
  id: '999-bridge',
  vector: atCosine(midpoint, 0.99, random),
  clientId: 'client-0',
}
const withBridge = clusterByThreshold([...items, bridging], TEST_THRESHOLD)
if (withBridge.length === first.length && shape(withBridge) === shape(first)) {
  console.log(
    'FAIL (§8: adding a question between two centres changed nothing, which contradicts ' +
      'the documented limitation — either the fixture no longer bridges or the algorithm ' +
      'became insertion-stable; both need the docblock updated)',
  )
  failures++
}

// --- the measurement §5 asks for -----------------------------------------
const scaleRandom = makeRandom(1)
const many = Array.from({ length: 3000 }, (_, index) => ({
  id: index.toString().padStart(6, '0'),
  vector: atCosine(centres[index % 3], 0.55 + (index % 5) * 0.08, scaleRandom),
  clientId: `client-${index % 7}`,
}))

const startedAt = Date.now()
const scaled = clusterByThreshold(many, TEST_THRESHOLD)
const elapsedMs = Date.now() - startedAt

console.log(
  `      (measured: 3000 vectors of ${DIMS} dims -> ${scaled.length} clusters in ${elapsedMs}ms)`,
)

// A ceiling, not a benchmark. The point is to fail loudly if this ever becomes the
// reason a nightly job times out, rather than to police milliseconds.
if (elapsedMs > 10000) {
  console.log(
    `FAIL (§5: clustering 3000 vectors took ${elapsedMs}ms — the "a few thousand ` +
      'vectors in JS is fine" assumption no longer holds and this needs pgvector or a ' +
      'different approach)',
  )
  failures++
}


// ---------------------------------------------------------------------------
// The flagging job's selection carries both of its filters (§2, §5, 0025)
//
// Two bugs live in this one statement, and neither would ever look like a bug.
//
//   * Drop `analytics_opt_out = FALSE` and an opted-out client's questions get sent
//     to a model. The queue would look correct; the promise would be broken.
//   * Drop `flag_screened_at IS NULL` and every clean question is re-screened on
//     every run, forever — the whole cost of the feature, spent on answers already
//     known. This is the bug that was actually written, before 0025 existed: the
//     first version filtered on the absence of a `review_flags` row, which reads
//     correctly and is wrong precisely because a clean question leaves no row.
//
// Checked statically because neither failure shows up in the output. A run that
// re-screens reports the same counts as one that does not.
// ---------------------------------------------------------------------------

const insightsSource = readFileSync(
  new URL('../src/lib/insights.ts', import.meta.url),
  'utf8',
)

// Anchored on the function, not on `const pending = await query(` — the embedding job
// opens with the same two words, and the first version of this guard read that one and
// reported the flagging job's filters as missing.
const flagBody = insightsSource.slice(
  insightsSource.indexOf('export async function runInsightFlag'),
)
const flagSelect = /const pending = await query\(([\s\S]*?)\n {2}\)/.exec(flagBody)
if (!flagSelect) {
  console.log(
    'FAIL (the flagging job\'s pending-question query could not be found in insights.ts — ' +
      'if it was renamed, this guard needs renaming with it rather than deleting)',
  )
  failures++
} else {
  for (const [needle, why] of [
    ['analytics_opt_out = FALSE', 'an opted-out client\'s questions would be sent to the model'],
    ['flag_screened_at IS NULL', 'every clean question would be re-screened on every run'],
  ]) {
    if (flagSelect[1].includes(needle)) continue
    console.log(`FAIL (§2/§5: the flagging job's query has lost \`${needle}\` — ${why})`)
    failures++
  }
}

// ---------------------------------------------------------------------------
// The flag parser can actually return a flag (§5)
//
// The first production screen looked at seven questions and flagged none. That is
// the right answer for those seven — they are about locations and candidate counts —
// but "flagged 0" and "the parser never matches" produce identical output, and only
// one of them is a working compliance queue.
//
// So the parser is exercised against reply text of the shape the model actually
// produces, including the shapes it produces when it is not following instructions:
// a preamble line, a code that is not on the list, a question number outside the
// batch. Each of those must be dropped without taking the valid lines with it.
// ---------------------------------------------------------------------------

const parseQuestions = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }]

const parseCases: Array<[string, string, Array<[string, string, number]>]> = [
  [
    'the ordinary case',
    '1|adverse_event|0.9\n3|complaint|0.4',
    [['q1', 'adverse_event', 0.9], ['q3', 'complaint', 0.4]],
  ],
  ['nothing flagged', 'NONE', []],
  [
    'one question, two codes',
    '2|off_label|0.7\n2|privacy|0.55',
    [['q2', 'off_label', 0.7], ['q2', 'privacy', 0.55]],
  ],
  [
    'a preamble the model was told not to write',
    'Here are the flagged questions:\n1|privacy|0.8',
    [['q1', 'privacy', 0.8]],
  ],
  [
    'a code that is not on the list is dropped, the valid line is not',
    '1|serious_concern|0.9\n2|other|0.3',
    [['q2', 'other', 0.3]],
  ],
  [
    'a question number outside the batch is dropped',
    '9|adverse_event|0.9\n1|adverse_event|0.6',
    [['q1', 'adverse_event', 0.6]],
  ],
  [
    'a confidence over 1 is clamped rather than dropped',
    '1|adverse_event|4.0',
    [['q1', 'adverse_event', 1]],
  ],
  ['prose only, so nothing is invented', 'I could not find anything concerning.', []],
]

for (const [label, reply, expected] of parseCases) {
  const actual = parseFlagReply(reply, parseQuestions).map(
    (flag) => [flag.id, flag.code, flag.confidence] as [string, string, number],
  )
  if (JSON.stringify(actual) === JSON.stringify(expected)) continue
  console.log(
    `FAIL (§5: the flag parser mishandles ${label}) ` +
      `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
  failures++
}
// ---------------------------------------------------------------------------
// No React hook below a conditional return (all three apps)
//
// This one blanked the client app in production for two weeks and nothing caught it.
//
// `App.tsx` called `useCallback` for `rateAnswer` below the `portalError`, `booting`
// and `fatalError` early returns. First render: `booting` is true, the component
// returns early, that hook never runs. Session arrives, `booting` flips, the render
// reaches the hook and calls one more than last time — React error #310, and React's
// response is to unmount the tree. A white page.
//
// It is worth being precise about why it survived so long:
//
//   * **typecheck and lint both passed.** Hook order is a runtime property.
//   * **The e2e specs that would have caught it all skip** — twenty-four of them —
//     because Gate will not mint a portal-bound session for a test. So the one app
//     whose entire surface is behind a portal is the one with no automated coverage.
//   * **The backend looked healthy**, and was: it logged `portal.resolved` and then
//     nothing, because there was no app left to make the next request. Reading those
//     logs alone, the product looked fine.
//
// A static check is a poor substitute for rendering the thing, and it is what is
// available here. It catches the exact shape that caused this: a `use*(` call at
// component-body indentation appearing after an `if (…) {` / `return` at the same
// level.
// ---------------------------------------------------------------------------

function hooksBelowEarlyReturn(file: URL): string[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const problems: string[] = []

  let sawEarlyReturn = false
  let earlyReturnLine = 0
  let depth = 0

  lines.forEach((line, index) => {
    // A new top-level component or function resets the scan. Hook rules are per
    // component, so a return in one says nothing about a hook in the next.
    if (/^(export )?(default )?function |^(export )?const \w+ = \(|^(export )?function\*/.test(line)) {
      sawEarlyReturn = false
      depth = 0
    }

    // Only component-body level — two spaces. A hook inside a nested callback or a
    // conditional block is a different (and usually also wrong) thing, and flagging
    // it here would bury the signal this guard exists for.
    const atBodyLevel = /^ {2}\S/.test(line)
    if (!atBodyLevel) return

    if (/^ {2}if \(/.test(line)) depth = 1
    if (depth === 1 && /^ {2}\}/.test(line)) depth = 0

    // `  if (x) {` … `    return (` … `  }` — the early-return shape.
    if (/^ {2}if \(/.test(line)) {
      const closing = lines.slice(index).findIndex((l, i) => i > 0 && /^ {2}\}/.test(l))
      const block = lines.slice(index, index + (closing === -1 ? 0 : closing))
      if (block.some((l) => /^ {4}return[ (]/.test(l))) {
        sawEarlyReturn = true
        earlyReturnLine = index + 1
      }
    }

    if (sawEarlyReturn && /^ {2}(const|let)?\s*[\w[\]{},: ]*=?\s*use[A-Z]\w*\(/.test(line)) {
      problems.push(
        `${line.trim().slice(0, 70)} (line ${index + 1}, below the early return on line ${earlyReturnLine})`,
      )
    }
  })

  return problems
}

function tsxFiles(dir: URL): URL[] {
  const found: URL[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) found.push(...tsxFiles(child))
    else if (entry.name.endsWith('.tsx')) found.push(child)
  }
  return found
}

for (const app of ['compass-ai', 'compass-admin', 'compass-insights']) {
  for (const file of tsxFiles(new URL(`../../../${app}/src/`, import.meta.url))) {
    const problems = hooksBelowEarlyReturn(file)
    if (problems.length === 0) continue
    const name = decodeURIComponent(file.pathname).split('/').slice(-2).join('/')
    for (const problem of problems) {
      console.log(
        `FAIL (a React hook is called below a conditional return, which unmounts the ` +
          `tree the moment the condition flips — React #310) ${app}/${name}: ${problem}`,
      )
      failures++
    }
  }
}

// ---------------------------------------------------------------------------
// PDF links open in a new tab, and only in a new tab
//
// The viewer renders link annotations from client-supplied PDFs. Two properties keep
// that safe, and only one of them is ours:
//
//   * pdf.js rejects every scheme but http/https/ftp/mailto/tel, so a `javascript:`
//     annotation never reaches us with a URL. That is the library's guarantee.
//   * **Every anchor is forced to `target="_blank"` with `rel="noopener noreferrer"`.**
//     That one is ours, it is three lines, and deleting it looks like tidying up: the
//     PDF's own `newWindow` flag is right there and honouring it reads as the polite
//     thing to do. It is not — this app runs inside a portal iframe, so a same-frame
//     navigation replaces the product with whatever a client's file points at.
//
// Checked statically because the e2e specs that would exercise it all skip for want of
// a portal-bound session. `scripts/probe-client-render.mjs` checks the rendered result
// and is the stronger test; this one runs on every commit.
// ---------------------------------------------------------------------------

const linkServiceSource = readFileSync(
  new URL('../../src/lib/pdf-links.ts', import.meta.url),
  'utf8',
)

for (const [needle, why] of [
  ["link.target = '_blank'", 'a PDF link could navigate the portal iframe away from the app'],
  [
    "link.rel = 'noopener noreferrer'",
    'the opened page would get a handle on our window and a referrer naming the portal',
  ],
]) {
  if (linkServiceSource.includes(needle)) continue
  console.log(`FAIL (pdf-links.ts no longer sets \`${needle}\` — ${why})`)
  failures++
}

// The forcing must be unconditional. `if (newWindow)` around it would restore exactly
// the behaviour the docblock explains is unsafe.
if (/if\s*\(\s*newWindow\s*\)/.test(linkServiceSource)) {
  console.log(
    'FAIL (pdf-links.ts branches on the PDF\'s own `newWindow` flag — the new-tab ' +
      'forcing is deliberately unconditional; a file does not get to choose)',
  )
  failures++
}

console.log(
  failures === 0
    ? 'PASS — library caps, §6.5 visibility, no literal interpolation, no deleted-route calls, fit-to-width, no placeholder gaps, clustering, flag-screen filters, flag parser, hook order, pdf link safety'
    : `${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
