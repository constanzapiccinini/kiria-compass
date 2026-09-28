# Phase 9 — KIRIA branding

Shipped to production across all three apps. What follows is what the translation
actually decided, the nine defects the review found (eight of them mine, one older than
this phase), and what remains open.

The typeface and the wordmark are **in**, on a second pass: the brand assets were not in
the repository when the phase started and arrived afterwards from
`Desktop\KIRIA ASSETS`.

---

## 0. The authority, and what it confirmed

§0 names `references/brand-system.md` in the `fanny-neha-linkedin-graphics` skill. That
skill is not installed and never was. The assets themselves — `Nunito_Sans/`, the logo
PNGs and `brand guidelines - kiria.pdf` — were supplied directly.

The phase's first pass ran without them, on §1 alone, which turned out to be safe: §1 is
not a pointer to the brand system, it *is* the translation, with every hex written out.
**Checked afterwards against the guidelines PDF**, by extracting the fill colours its own
content streams declare:

| §1 says | the guidelines PDF uses | |
| --- | --- | --- |
| `#004AAD` blue | `#004aad` | exact |
| `#6BB9F0` light-blue | `#6bb9f0` | exact |
| `#3432CC` cobalt | `#3432cc` | exact |
| `#0065A6` teal | `#0066a6` | off by one in the blue channel |
| `#F6F470` yellow | `#f7f471` | off by one in red and blue |
| `#D7263D` red | not present | see below |

The two one-digit deltas are sub-perceptual — a single step in one channel out of 255 —
and §1 is the spec this phase was written against, so the shipped values are §1's. They
are recorded here because "close enough" is a judgement somebody should be able to
re-make, not one that should be invisible.

The red is a real difference and probably not one. The PDF's reds are `#f44336` and
`#c62828`, which arrive alongside `#faa700`, `#7cb342` and `#ffca28` — a Material palette,
almost certainly an example chart page rather than the brand's own "decline / risk"
swatch. §1's `#D7263D` was kept.

---

## 1. The translation

### Colour is meaning

| token | hex | what it does in the product |
| --- | --- | --- |
| `--kiria-blue` | `#004AAD` | structure — primary buttons, **active nav**, focus ring |
| `--teal` | `#0065A6` | interaction — links, interactive text |
| `--yellow` | `#F6F470` | **the citation highlight, and nothing else** (client app) / the alert-severity scale (staff apps) |
| `--red` | `#D7263D` | destructive actions and errors only |
| `--ink` / `--paper-gray` | `#010104` / `#F4F6FA` | text, and both ends of the neutral ramp |
| `--light-blue` | `#6BB9F0` | generated, and used nowhere — it is 2:1 on white and dark mode is not wired |
| `--cobalt` | `#3432CC` | generated, reserved for the gradient §2 does not ask for yet |

**The client/staff split on yellow is the load-bearing decision.** §1 says yellow is the
citation and no other component; §2 says the admin app may use it for alert severity. So
`compass-ai` has `citation.*` and no `warn.*`, and the two staff apps have `warn.*` and
no `citation.*`. In the client app yellow means *this is the passage your answer came
from*, and there must be exactly one meaning for it on a surface a client sees.

**There is no green.** The palette has none, so "indexed / succeeded" and "still
preparing" both land on teal (`ok.*`). Where an operator needs those two apart at a
glance, the staff apps separate them with yellow. The client app does not, and its
"Preparing" is muted grey — a transient absence rather than a state worth colouring.

### Ramps are generated, not eyeballed

`scripts/generate-kiria-tokens.mjs` → `src/theme/kiria-tokens.ts`, written byte-identical
into all three apps, brand hex at the 600 step.

The first version mixed toward white and black in linear light and produced two defects
worth recording, because both look plausible until you put them on screen: the tints went
grey and drifted purple (`blue.400` came out `#99a3cc`, a lavender-grey), and `ink.900`
landed at `#424344` — a mid-grey that body text would have been set in. Linear light is
how photons add, not how a ramp is read.

The ladder is built in **OKLCH** instead: lightness moves, hue is held exactly, chroma
tapers toward white and is bisected back into gamut rather than clipped (clipping shifts
hue — a blue that runs out of gamut comes back purple). The ladder is relative to each
brand colour's own lightness, which is what lets the brand hex sit at 600 in every ramp:
yellow is far lighter than blue, and a fixed table of L values could honour the 600 rule
for one or the other, never both.

Measured, and §1's own figures came back accurate to two significant figures:

```
blue    600 #004aad  8.13:1     teal   600 #0065a6  6.15:1
cobalt  600 #3432cc  8.49:1     sky    600 #6bb9f0  2.14:1
red     600 #d7263d  4.96:1     yellow 600 #f6f470  1.16:1
ink on yellow: 17.96:1   ← the highlighter's whole justification
```

### Typography

The register is applied — column headings and section labels at 800/uppercase/tracked
11px, panel titles at 700 sentence case, body unchanged — and the face is now Nunito
Sans, self-hosted. See §5 for how it is built and why it is one variable file.

---

## 2. What the review found

§6 is right that "a branding phase whose only evidence is 'typecheck passed' has not been
reviewed". Everything below was found by the contrast test or by opening the screenshots
and looking at them. None of it was found by typecheck, and all of it was shipping.

**1. The rebrand did not reach the screen.** The first Insights capture showed a grey
active nav item on a white rail — a rebrand that replaced every ramp and changed nothing
anybody looks at. Cause: the rails use `bg.emphasized`, a Chakra *default* semantic token
that no theme here has ever defined, so the brand had nothing to say about the one token
the most-looked-at element used. §2's "keep the semantic-token structure exactly as it is,
so no component changes" holds only for the tokens the theme actually owns; these were the
gap. `bg.subtle` and `bg.emphasized` are now ours, and the active nav is brand blue with a
left marker, which is what §1 lists beside "primary buttons" and "focus ring".

**2. Input outlines were invisible, and had been since before the rebrand.** The contrast
test's first run failed `border.default` at 1.28:1 on white. Half of that was the test
being stricter than WCAG — a decorative card hairline is exempt under 1.4.11 — but the
same token also outlined every text input and select, and *that* is a control boundary
that needs 3:1. Split into `border.default` (hairline, exempt) and `border.strong`
(controls, held to 3:1). The slate theme had the same defect.

**3. White button labels fail in dark mode.** `accent.solid` steps up to `blue.400` on a
near-black ground, and white on it is 3.05:1. The pre-brand primitives hard-coded `white`,
which is correct in light mode and invisible to anyone developing in light mode. Now
`accent.contrast`, which darkens as the fill lightens.

**4. Yellow was on a button and a badge — the two things §1 names.** The client app's auth
modal had `colorPalette="yellow"` on its refresh button and the chat had a yellow "Page N"
badge on citation cards. The first yellow audit missed both: it looked for ramp steps and
hexes, and Chakra has a third way to name a colour. Widened, and both are blue now.

Three more from the asset pass, all in image processing I wrote and all caught by looking
at the output:

**6. The downscaled wordmark came back as a white silhouette** with its subtitle gone.
The area-averaging downsampler premultiplies alpha — correctly, or the transparent
pixels' arbitrary RGB bleeds a dark fringe into every edge. The un-premultiply on the way
out is `255 / a`, where `r` and `a` are sums over the same n pixels so n cancels. I wrote
`n / (a / 255)`, every channel came out n times too large, everything clamped to 255. It
looked exactly like an alpha bug and was arithmetic.

**7. The tagline crop cut through the letterforms.** Scanning down for the first blank row
finds the gap inside the K — the KIRIA letters have detached strokes across their tops —
so the "compact lockup" came out as a 480×44 strip at aspect 10.9. Measuring up from the
bottom instead makes the last ink block unambiguously the tagline. The function now also
refuses any cut that would keep less than half the mark, because a silently mangled logo
is worse than an untrimmed one.

**8. The 73 KB font tripped my own size warning.** The threshold was 60 KB, set before I
had counted how many weights the apps use. Five weights makes one variable file the right
answer and 73 KB the right size; the threshold was raised to 90 KB *and given the
measurement in its message*, so the next person to see it fire knows whether it means
anything.

And one that is not a defect but changes the evidence:

**5. Dark mode does not exist.** §7.4 opens with "the apps support it". They do not. Chakra
v3 activates `_dark` from a class a colour-mode provider puts on the root, and no app here
has one — `next-themes` is a dependency of `compass-ai` and is imported nowhere. Every
`_dark` value in every theme and every component has been dead code since it was written.
The screenshot review found it: the "dark" captures came back pixel-identical to the light
ones. See "What is blocked".

---

## 3. What is asserted

`apps/compass-ai/backend/tests/brand.test.ts`, run by `npm test` in that app. It reads all
three apps, the same way `drift.test.ts` does, because the platform shares no code between
them and the brand therefore exists as three copies.

- **Every foreground/background semantic pair, in both colour modes**, at ≥4.5:1 for text
  and ≥3:1 for controls — computed from the token values, not from hexes copied into the
  test. The semantic maps are exported for exactly this reason: a test with the hexes
  inlined passes forever after somebody changes a token.
- **§1's own contrast claims**, so a moved brand hex fails even when every derived pair
  still passes.
- **The yellow audit** — no component may reach for `yellow.N`, `#F6F470` or
  `colorPalette="yellow"`; only `citation.*` and `warn.*`.
- **The three token copies are byte-identical**, and the two staff themes are too.

Both guards were checked by breaking them on purpose: `fg.muted` moved one step reported
three failures naming the screens, and a yellow outline planted in `PdfPage.tsx` was
reported with its line number.

**Contrast changes the design made:** `fg.muted` is `ink.700` rather than `ink.600`
(4.10:1 on a selected row was not enough), and `warn.border` is `yellow.800` rather than
`700` (1.90:1 — a panel edge that marks something needing attention has to be findable).

---

## 4. The screenshots

`artifacts/brand/`, captured by `tests/e2e/specs/compass-insights/brand-review.spec.ts`
at 1440 and 1024, and **actually looked at** — that is how findings 1 and 5 above surfaced,
and how the §5 problem below did.

Two of the captures were worthless before they were useful, which is worth recording. The
first caught a loading spinner because there was no wait. The second *still* caught it,
because the wait looked for `Loading...` and the component renders `Loading…` with a real
ellipsis — so the locator matched nothing, reported zero, and the suite went green about a
screenshot of a spinner.

**§6 asks for "light and dark". Only light is captured**, because dark mode is not wired
and capturing both produced two byte-identical files under two names — evidence that says
something false, which is worse than no evidence. The dark-ground assertion still runs on
every capture, so a provider added later trips it rather than silently resuming a claim
the suite could not previously support.

**§5, from looking at the result:** the Overview had three stat numbers at identical size,
weight and colour — the shape §5 calls generic, "nothing tells the eye where to go". That
finding, and the two it led to on the admin screens, are in §4b.

**The reading view and the chat-with-citations captures are missing, and cannot be
automated.** Both need a portal-bound session, which Gate cannot mint — the same blocker
that skips ~24 client-app e2e tests and has been recorded since Phase 7. So **the citation
highlight is the one part of this rebrand no automated capture can show, and it is the part
that matters most.** It needs somebody to open a client portal, ask a question, click a
citation, and look at the yellow swipe on the page. Nothing in this phase substitutes for
that.

---

## 4b. §5 — one emphasis per view

> The app equivalent [of generic] is a screen where every panel has the same border, the
> same radius, the same weight, and nothing tells the eye where to go.

Applied per screen, and it needed a shared primitive rather than styling applied in place:
the rule is about **scarcity**, and a rule about scarcity is the kind ad-hoc styling breaks
quietly, one screen at a time, until every number is emphasised and none of them is. So
`Stat` lives in the shared `primitives.tsx` with a `primary` flag, named for *importance on
this screen* rather than for its appearance — calling it `large` is how a second one gets
added.

`primary` and `tone` are deliberately separate. Emphasis says **look here**; tone says
**what kind of thing this is**. A headline number that needs attention is both, and
collapsing them would force a choice between "this is the number" and "this number is a
problem", which are not alternatives.

| screen | the one number | before |
| --- | --- | --- |
| Insights Overview | the answer-gap rate | three stat numbers at identical size, weight and colour |
| Admin Indexing | documents unreachable by a question | one of five equal queue counts |
| Admin Usage | the month's spend | a clause inside a muted subtitle, smaller than the table under it |

Indexing's headline is emphasised **whatever its value**, including zero. "Zero
unreachable" is the reassurance the screen exists to give, and a number that only appears
when it is bad teaches people not to look.

In the client chat, §5 says "the answer and its citations carry the colour, the input and
controls stay quiet". The send button was a solid blue fill for about an hour — the loudest
thing in the panel, sitting beside the answer it is supposed to defer to. It is outlined in
the accent now.

**Two more defects the re-review caught**, both only visible in a screenshot:

- **Hover erased the active nav state.** After clicking a rail item the cursor stays on it,
  so `_hover` overrode the blue and the selected screen rendered as an ordinary hovered
  one. That is how the first Usage capture came back with a grey nav item on a screen that
  was, in fact, selected. Hover now preserves the active tint.
- **The Usage headline had no bottom padding** and sat flush against the table header below
  it, so the new emphasis read as part of the table. Padding plus a rule.

The screens with no single headline number — Portals, Libraries, Alerts, Audit, Settings —
were left alone. §5 says "the one number that matters on each screen", not that every
screen must have one, and inventing an emphasis for a list is the same failure in the
other direction.

---

## 5. What is blocked, and why

| | status |
| --- | --- |
| **Nunito Sans** | **shipped** — self-hosted, subset, one variable file |
| **Logos / wordmark** | **shipped** — compact lockup + a favicon from the brand's own K |
| **Portal shell (§3)** | **out of scope, confirmed** — no CNAME domain |
| **Dark mode** | **decided: not doing it** — palette derived and tested, provider deliberately not wired |
| **Product name (§7.2)** | **your call** — titles left as they were |
| **SVG wordmark (§7.1)** | **still worth asking for** — the assets are raster only |

**Nunito Sans — shipped.** `scripts/build-brand-font.mjs` subsets the variable TTF to
latin plus the punctuation the UI actually emits, keeps only the `wght` axis, and writes
one 73 KB woff2 into each app. Measured before choosing: the apps use **five** distinct
weights (400 body, 500 ×26, 600 ×15, 700 ×3, 800 ×9), so five static cuts would have been
~190 KB and five requests. `@font-face` sits in `globals.css` because it must be parsed
before React mounts; `font-display: swap` and a `crossorigin` preload per §1.

The accented Latin-1 range is in the subset and is not optional — the org writes to
clients in Spanish and production client names already carry accents. It costs 22 KB of
the 73.

**Logos — shipped, and the review changed which lockup.** `scripts/build-brand-logos.mjs`
trims each source to its own ink, drops the tagline, downsamples and writes
`wordmark.png`, `wordmark-white.png` and `favicon.png` into every app.

Dropping the tagline was not a preference. The full lockup is 2.23:1, so in the 22px rail
slot "ADVISORY PARTNERS" renders about three pixels tall — not soft, illegible, a grey
smudge under the name. §7.1 predicted softness from a raster wordmark; the actual problem
was that the *primary* lockup is the wrong lockup at product scale. The compact one —
KIRIA plus the pulse rule, 2.73:1 — is legible at every size the apps use.

The favicon is the brand's own **K**, cropped from the wordmark by measurement and set
white on `--kiria-blue`. It replaces the mark I had drawn in the first pass. The wordmark
at 2.2:1 is an illegible smear at 16px, so a letterform is the only honest square mark
available.

**§7.1 stands.** These are raster. The mark is rendered at ~60px from a 480px source, so
it is sharp enough that nobody will file a bug, and it is still not a vector — every
future surface will want one.

The alert email keeps its **type-set** wordmark rather than the image, and that is the
right answer rather than a leftover: most mail clients block remote images by default, so
an image wordmark is a broken-image icon at the top of an alert the first time anyone
sees it.

**Portal shell.** §3.1 said to confirm the domain before scoping the work. Confirmed
against the platform rather than assumed — `listPortals` returns all three portals on
`.p.nimbusweb.me`, and `getPortalStyleContract` states it outright: *"Custom CSS only
renders on portals served from a custom CNAME domain."* So §3 is genuinely out of scope,
and nothing was written and left untested to pretend otherwise. The brand is carried by the
app alone until a CNAME exists.

**Dark mode — decided, and the decision is no.** The palette is derived as §7.4 asks and
every dark pair is contrast-tested, but the provider is deliberately not wired.

Beyond the risk of making a large amount of never-rendered UI live at once, there is a
reason specific to this product that only surfaced while investigating: **every reader of
the client app is inside a portal iframe** (`export.ts` says so in as many words), and the
portal chrome cannot be styled — §3 established there is no CNAME. An OS-following dark
mode there would put a near-black app inside a white portal frame for every client. That
is worse than light-only, so light-only is the ground, which is §7.4's second option taken
deliberately rather than by default.

The `_dark` values stay in place, dormant. Removing them would be a large diff across
three apps for no behavioural change, and they are the derivation somebody would otherwise
have to redo. The e2e spec asserts the current state and fails the moment a provider is
added, so the decision cannot be reversed silently.

**Also worth a decision, from §7.2:** the client app's tab still says "Compass AI", the
internal name. In a client portal it may want to be "Compass", or KIRIA with no product
name at all. The two staff apps said `App` — a scaffold leftover — and now say "Compass
Admin" and "Compass Insights".

**§7.5:** the headshot-and-follow footer and the contact strip were not carried into the
app. Confirming there is no brand requirement being dropped needs the brand system, which
is not here.

---

## 6. Files

**Generated:** `scripts/generate-kiria-tokens.mjs` → `src/theme/kiria-tokens.ts` ×3.

**Themes:** `apps/*/src/theme.ts` — semantic layer per app, exported for the contrast test.
The two staff themes are byte-identical and held so.

**Stylesheets:** all three `globals.css`. The staff apps' were the scaffold's full Tailwind
sheet — `@import "tailwindcss"` plus a shadcn oklch palette painting `body` — a second
design system's variables setting the ground under Chakra's, in colours belonging to
neither KIRIA nor the theme. Deleting it needed `AuthExpiredModal` rewritten in Chakra
first, which was the last Tailwind in the admin app and, being the screen a person sees
when something has gone wrong, the one screen with no brand on it at all.

**Other client-visible surfaces:** the alert email is now a branded template — blue header
bar, type-set wordmark, ink body, severity in the bar where the eye already is. A true
plain-text alternative is not possible: `sendOrgEmail` takes one `body` string, not a
multipart pair. What §4 actually asks for is met the other way — every piece of meaning is
in text inside a semantic element, so stripping every style still reads correctly, and
nothing is carried by colour or layout alone. The client empty state now distinguishes
"nothing shared yet" (carries the mark, says a person is preparing it) from "nothing open"
(an instruction, left plain).

**Charts (§4):** none exist yet. The Insights weekly series is deliberately a table — "with
seven accounts and a handful of weeks, a line chart is a decoration around four numbers".
The `dataviz` palette substitution applies when that becomes a chart.

---

## 7. Verification

- brand test: **PASS** — every semantic pair in both modes, brand hexes at 600, yellow only
  through the semantic layer, three token copies identical, and the four brand assets
  present and byte-identical in every app
- invariants: **PASS** (10 guards, unchanged from 8D)
- drift: **PASS** — copied helpers byte-identical, no pipeline code in Insights
- lint **clean**, typecheck **0 errors** across all three apps
- e2e: admin **30 passed / 1 skipped**, insights **23 / 1**, client **25 / 24 skipped**
  (the portal-bound sessions), brand captures **9 passed** — **0 failures**
- the font-blocked run is **no longer vacuous**: it aborts a real woff2 and the layout
  holds, so the system fallback's metrics are close enough not to need a `size-adjust`
- deployed: compass-ai, compass-admin, compass-insights all green
- e2e fixture residue cleaned from production after each run (12 libraries in total)

No schema change. No migration. Phase 9 touches no data.

---

## 8. Two production alerts, neither from this phase

Noticed while reviewing a screenshot — the admin rail showed the Alerts badge go from 1
to 2 — and worth writing down rather than leaving for somebody to find.

- **`PORTAL_MISSING`**, error, 8 occurrences. FuseBase no longer lists the portal
  "Compass Client B". The reconcile job is doing its job; somebody has to decide what
  happened to that portal.
- **`TENANCY_PROBE`**, **critical**, 11 occurrences. A request carried `clientId` in the
  query string to `GET /api/documents`. This is **the e2e suite**:
  `admin-smoke.spec.ts:177` sends exactly that, on purpose, to prove the tenancy guard
  rejects it. The guard works — and it raises a critical alert every time the suite runs.

  That second one is a real problem even though nothing is broken. A critical alert that
  fires on every test run is how people learn to ignore critical alerts, which is the
  same argument 8D made for not sending flags to an inbox. Fixing it is a design decision
  — the probe could carry a header the alert path recognises, or the suite could clear
  what it raises — so it is left here rather than guessed at.
