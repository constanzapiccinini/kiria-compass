/**
 * Build the browser console snippet that verifies portal-to-portal isolation.
 *
 * Why this exists as a script rather than a pasted snippet in a document: the two
 * portal context tokens live in `.env.<environment>` and must not be committed. This
 * reads them at run time and prints a ready-to-paste one-liner, so the runbook can
 * stay in git without carrying secrets, and the snippet is regenerated for free
 * whenever a token is rotated.
 *
 * Why the check is manual at all: the app resolves a tenant only for a session minted
 * *through the portal* (`/api/portal/app-launch`). Gate exposes no operation to add a
 * portal member or mint a portal session, so no automated path can produce one — see
 * apps/compass-ai/PHASE-4A.md, "Portal-bound sessions". A real browser already logged
 * into the portal is the only source.
 *
 * Usage:
 *   node scripts/portal-isolation-check.mjs <documentIdOnlyInPortalB> [envName]
 */

import { readFileSync } from 'node:fs'

const [documentId, envName = 'prod'] = process.argv.slice(2)

if (!documentId) {
  console.error(
    'Usage: node scripts/portal-isolation-check.mjs <documentIdOnlyInPortalB> [envName]\n\n' +
      'The document must exist in portal B and nowhere else — it is what portal A must\n' +
      'fail to reach. Without one the check cannot distinguish "correctly hidden" from\n' +
      '"does not exist", which is the mistake that makes this test worthless.',
  )
  process.exit(1)
}

const envFile = `.env.${envName}`
let env
try {
  env = readFileSync(envFile, 'utf8')
} catch {
  console.error(`${envFile} not found — run this from the project root.`)
  process.exit(1)
}

const read = (key) => (env.match(new RegExp(`^${key}=(.+)$`, 'm')) || [])[1]

const tokenA = read('COMPASS_PORTAL_TOKEN_A')
const tokenB = read('COMPASS_PORTAL_TOKEN_B')

const missing = [
  tokenA ? null : 'COMPASS_PORTAL_TOKEN_A',
  tokenB ? null : 'COMPASS_PORTAL_TOKEN_B',
].filter(Boolean)

if (missing.length > 0) {
  console.error(
    `${envFile} is missing: ${missing.join(', ')}\n\n` +
      'Read each from its portal page: open the page, and in the console run\n' +
      "  [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src'))\n" +
      'then pull `portalFeatureContextToken` out of the launcher URL.',
  )
  process.exit(1)
}

// The newline escape the browser interprets, assembled here so no layer between this
// file and the clipboard can collapse it.
const NEWLINE = `${String.fromCharCode(92)}n`

const snippet = [
  `(async()=>{`,
  // Guard first. A run on the portal domain hits nimbusweb.me/api/... which 404s on
  // every path, which looks exactly like a passing isolation test. That false pass is
  // the failure mode this line exists to make impossible.
  `if(!location.origin.includes('compass-ai'))return'WRONG FRAME: ran on '+location.origin+'. Switch the DevTools context dropdown from "top" to the compass-ai frame.';`,
  `const A='${tokenA}',B='${tokenB}',id='${documentId}';`,
  `const call=async(t,p)=>{const r=await fetch(p,{headers:{'x-portal-context':t}});let d='';try{const b=await r.json();d=b.client?b.client.name:(b.error?b.error.code:'');}catch(e){}return{s:r.status,d:d};};`,
  `const sA=await call(A,'/api/session'),sB=await call(B,'/api/session');`,
  // Which portal minted this session decides what the run can prove. Asking rather
  // than assuming is what makes one snippet usable in either frame.
  `const here=sA.s===200?'A':(sB.s===200?'B':null);`,
  `if(!here)return'NOT PORTAL-BOUND: this session resolves neither portal (A='+sA.s+' '+sA.d+', B='+sB.s+' '+sB.d+').${NEWLINE}Open a PORTAL page and run this inside its compass-ai frame - a tab opened straight at the app host never went through the portal launcher, so it is bound to nothing.';`,
  `const mine=here==='A'?A:B,other=here==='A'?B:A;`,
  `const own=await call(mine,'/api/documents/'+id),cross=await call(other,'/api/documents/'+id);`,
  `const out=['frame is bound to portal '+here+': '+(here==='A'?sA.d:sB.d)];`,
  `out.push('doc with THIS portal token  -> '+own.s+(own.d?' '+own.d:''));`,
  `out.push('doc with OTHER portal token -> '+cross.s+(cross.d?' '+cross.d:''));`,
  `out.push(here==='B'?'CONTROL run: expect 200 (owner can read) then 401 (other portal token refused)':'ISOLATION run: expect 404 (cannot reach portal B doc) then 401 (other portal token refused)');`,
  `return out.join('${NEWLINE}');`,
  `})()`,
].join('')

console.log(snippet)
