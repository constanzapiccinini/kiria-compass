/**
 * The copied helpers must stay byte-identical to Compass Admin's — §5.
 *
 * ---------------------------------------------------------------------------
 * Why this app copies instead of importing
 *
 * The platform gives each app its own backend and shares no code between them. §5 is
 * explicit about the consequence: `compass-insights` contains **no pipeline code at
 * all** — it reads and it manages queues — and "the helpers it does need (`auth`,
 * `admin-auth`, `store`, `config`) are copied verbatim, like `folders.ts` was, and get
 * the byte-comparison drift test alongside them".
 *
 * That is not an endorsement of duplication. It is the acknowledgement that the
 * duplication is unavoidable here, plus the one mechanism that makes it survivable: if
 * a security fix lands in one copy and not the other, this test says so on the next
 * commit rather than in an incident six months later. Two copies of `store.ts` whose
 * RLS context handling has silently diverged is exactly how a tenancy bug ships.
 *
 * ---------------------------------------------------------------------------
 * `observability.ts` is here for one function, deliberately
 *
 * `admin-auth.ts` imports `logStep` from it, and `admin-auth.ts` is one of the files
 * that must stay verbatim. Copying a **stripped** observability — just `logStep` —
 * would have meant `admin-auth.ts` could no longer be compared byte-for-byte, which
 * trades the guard for tidiness.
 *
 * So the copy carries `recordUsage`, `recordTrace` and `computeCost`, which this app
 * never calls: it makes no model calls to meter. Unused exports inside a
 * mechanically-verified copy are a different thing from hand-written dead code — the
 * trap this codebase keeps paying for is code that *looks* supported and is
 * unreachable, and a verbatim copy under a drift test is neither pretending nor
 * unmaintained. If the list ever shrinks, it shrinks in the admin app first and this
 * test reports it.
 *
 * ---------------------------------------------------------------------------
 * When this test fails
 *
 * It is telling you the two copies disagree. **Do not edit this app's copy to match
 * blindly** — read the diff first. If the admin app got a fix, port it. If this app
 * needed a genuine divergence, that is a design decision: move the file out of the
 * list below and write down why, so the next person sees a deliberate exception rather
 * than an unexplained failure they are tempted to delete.
 *
 * Run: npm test  (from apps/compass-insights/backend)
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** The files §5 sanctions copying, plus the one `admin-auth` drags in. */
const COPIED = [
  'auth.ts',
  'admin-auth.ts',
  'store.ts',
  'config.ts',
  // Dragged in by admin-auth and store, the same way observability is: they import
  // the Gate client factories from it, and keeping THEM verbatim requires keeping
  // their imports resolvable.
  'gate.ts',
  'observability.ts',
]

const ORIGIN = new URL('../../../compass-admin/backend/src/lib/', import.meta.url)
const COPY = new URL('../src/lib/', import.meta.url)

let failures = 0

for (const name of COPIED) {
  let origin: Buffer
  let copy: Buffer
  try {
    origin = readFileSync(new URL(name, ORIGIN))
  } catch {
    console.log(
      `FAIL (${name} is missing from compass-admin — either it moved, in which case ` +
        `this list is stale, or it was deleted and this copy is now the only one)`,
    )
    failures += 1
    continue
  }
  try {
    copy = readFileSync(new URL(name, COPY))
  } catch {
    console.log(`FAIL (${name} is missing from compass-insights)`)
    failures += 1
    continue
  }

  if (origin.equals(copy)) continue

  const digest = (buffer: Buffer): string =>
    createHash('sha256').update(buffer).digest('hex').slice(0, 12)

  // The first differing line, because "these files differ" sends the reader to a
  // diff tool and a line number sends them to the change.
  const originLines = origin.toString('utf8').split('\n')
  const copyLines = copy.toString('utf8').split('\n')
  let firstDiff = -1
  for (let i = 0; i < Math.max(originLines.length, copyLines.length); i += 1) {
    if (originLines[i] !== copyLines[i]) {
      firstDiff = i + 1
      break
    }
  }

  console.log(
    `FAIL (${name} has drifted from compass-admin's copy)\n` +
      `      admin  ${digest(origin)} (${originLines.length} lines)\n` +
      `      here   ${digest(copy)} (${copyLines.length} lines)\n` +
      `      first difference at line ${firstDiff}:\n` +
      `        admin: ${(originLines[firstDiff - 1] ?? '(end of file)').trim().slice(0, 100)}\n` +
      `        here:  ${(copyLines[firstDiff - 1] ?? '(end of file)').trim().slice(0, 100)}`,
  )
  failures += 1
}

// ---------------------------------------------------------------------------
// The frontend primitives too
//
// Not named by §5, which talks about backend helpers — but the argument is identical
// and the cost of checking is one loop. Staff move between Admin and Insights in the
// same sitting, so the two apps share `primitives.tsx`, `ui/native.tsx` and the theme
// verbatim. A divergence there is a visual inconsistency rather than a security bug,
// which is exactly the kind of drift nobody notices until both look wrong in
// different ways.
// ---------------------------------------------------------------------------

const COPIED_UI = ['components/primitives.tsx', 'components/ui/native.tsx', 'theme.ts']
const UI_ORIGIN = new URL('../../../compass-admin/src/', import.meta.url)
const UI_COPY = new URL('../../src/', import.meta.url)

for (const name of COPIED_UI) {
  try {
    const origin = readFileSync(new URL(name, UI_ORIGIN))
    const copy = readFileSync(new URL(name, UI_COPY))
    if (!origin.equals(copy)) {
      console.log(`FAIL (${name} has drifted from compass-admin's copy)`)
      failures += 1
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    console.log(`FAIL (${name} could not be compared: ${why})`)
    failures += 1
  }
}

// ---------------------------------------------------------------------------
// This app owns no pipeline code (§5)
//
// The load-bearing decision of the phase: the analysis runs in the client app's
// worker, and this app reads. Without a check, "no pipeline code at all" lasts until
// the first time someone needs an embedding here and reaches for the obvious import —
// at which point there are two embedding paths, two cost meters and two places for a
// model change to be half-applied.
// ---------------------------------------------------------------------------

const forbidden: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /createEmbeddings|\/embeddings\b/, why: 'embedding belongs to the client app worker' },
  { pattern: /chat\/completions|createCompletion/, why: 'no model calls in this app' },
  { pattern: /extractPdf|ocrPdf|textract/i, why: 'no ingestion in this app' },
  { pattern: /enqueueJob\(/, why: 'this app manages queues through routes, not by enqueueing directly' },
]

function sourceFiles(dir: URL): URL[] {
  const found: URL[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) found.push(...sourceFiles(child))
    else if (entry.name.endsWith('.ts')) found.push(child)
  }
  return found
}

for (const file of sourceFiles(new URL('../src/', import.meta.url))) {
  // The copied helpers are verified above and are allowed to contain whatever the
  // admin app contains; checking them here would report the admin app's code as this
  // app's violation.
  const name = decodeURIComponent(file.pathname)
  if (COPIED.some((copied) => name.endsWith(`/lib/${copied}`))) continue

  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const { pattern, why } of forbidden) {
      if (!pattern.test(line)) continue
      console.log(
        `FAIL (§5: pipeline code in the insights app — ${why}) ` +
          `${name.split('/').slice(-2).join('/')}:${index + 1}\n      ${line.trim().slice(0, 120)}`,
      )
      failures += 1
    }
  })
}

console.log(
  failures === 0
    ? 'PASS — the copied helpers are byte-identical and this app holds no pipeline code'
    : `${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
