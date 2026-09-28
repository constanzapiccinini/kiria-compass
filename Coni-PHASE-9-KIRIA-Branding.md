# PHASE 9 — KIRIA branding

**Apply the KIRIA visual system to Compass AI, Compass Admin, and the portal shell around them.**

Author: Coni · Date: 2026-09-09 · Apps: `apps/compass-ai`, `apps/compass-admin` (and `compass-insights` when Phase 8 builds it)

---

## 0. Where the brand comes from

The authority is `references/brand-system.md` in the `fanny-neha-linkedin-graphics` skill, with the assets beside it: `assets/fonts/NunitoSans.ttf`, `assets/kiria.css`, `logo_white.png`, `logo_light.png`, `logo_dark.png`.

**Do not import `kiria.css` into either app.** It is written for a 1080×1350 social canvas — 80px uppercase headlines, 150px hero numbers, a fixed 150px footer with a headshot. Dropping it into a document-reading UI produces a poster, not a product. This phase *translates* the system; §1 is that translation, and it is the part to get right.

Today both apps ship a generic slate-and-amber theme (`src/theme.ts`) that has nothing to do with KIRIA. Nothing about the current look is load-bearing except one idea worth keeping: *the accent marks the one thing that carries meaning — a citation*. That idea survives, in KIRIA's colours.

---

## 1. The translation

The brand's central rule — **colour is meaning, not decoration** — transfers to a product UI unchanged, and it happens to fit this product exactly.

| Brand token | Hex | In the graphics system | In the app |
|---|---|---|---|
| `--ink` | `#010104` | primary text, takeaway bar | body text on light; the dark-mode ground |
| `--kiria-blue` | `#004AAD` | baseline bars, emphasis | primary buttons, active nav, focus ring, structure |
| `--teal` | `#0065A6` | workhorse accent, stat numbers | links, interactive text, selected states |
| `--light-blue` | `#6BB9F0` | eyebrows on dark | accents **on dark only** — never text on white |
| `--cobalt` | `#3432CC` | gradient end, insight | the header gradient's far end; nothing else |
| `--yellow` | `#F6F470` | the one word that matters | **the citation highlight, and nothing else** |
| `--red` | `#D7263D` | decline, risk | destructive actions and errors only |
| `--paper` / `--paper-gray` | `#FFFFFF` / `#F4F6FA` | body backgrounds | surface / canvas |

**Yellow is the whole idea.** KIRIA's signature device is a highlighter swipe over the phrase that carries the insight. In this app the phrase that carries the insight is the cited paragraph in the PDF and the passage an answer is grounded in. So the highlighter *is* the citation highlight — the brand device and the product's core interaction are the same gesture. Yellow appears there and in no other component: not on buttons, not on badges, not on the chat pill.

Concretely, replace the amber citation treatment in `globals.css` (`@keyframes compass-pulse`, currently `rgba(224, 140, 12, …)`) with the yellow highlight plus a `--kiria-blue` pulse ring. The highlight overlay sits on a white page canvas — use `mix-blend-mode: multiply` or an alpha around 0.35 so the words underneath stay readable; a flat opaque swatch over rendered text is unreadable and will be the first thing anyone notices.

### Contrast — check before adopting

Approximate WCAG contrast on white:

- `#004AAD` ≈ **8:1** — safe for text, buttons, icons.
- `#0065A6` ≈ **6:1** — safe for text and links.
- `#3432CC` ≈ **8.5:1** — safe, but reserved for the gradient.
- `#6BB9F0` ≈ **2:1** — **fails**. Decorative or dark-ground only. Never a label, never a link.
- `#F6F470` ≈ **1.2:1** as text — unusable. As a *background* under `#010104` it is ≈ **18:1** — excellent. That asymmetry is exactly why it is a highlighter and not a text colour.

The theme currently uses `amber.600` for the accent because that was the contrast-safe step. Swapping brand hexes in naively without re-checking is how a rebrand quietly breaks legibility.

### Typography

Nunito Sans, self-hosted. The graphics register — uppercase, 800 weight, heavy tracking — is right for **small labels only**: section headers, table column headings, the eyebrow above a panel title. It is wrong for document names, chat text, folder labels and anything a person reads at length.

| App role | Treatment |
|---|---|
| Section label / column heading | Nunito Sans 800, uppercase, ~11–12px, tracked |
| Panel title | 700, 15–16px, sentence case |
| Body, chat, document names | 400, 14–15px, sentence case, normal tracking |
| Numbers in a stat tile | 800, brand blue or teal — yellow **only** if the number is the single most important thing on screen |

Emphasis is colour, never italics. `<strong>` in an answer pops to `--kiria-blue`.

**Fonts must be self-hosted** — no Google Fonts, no CDN. Convert `NunitoSans.ttf` to woff2, subset to latin, drop it in `public/fonts/`, declare `@font-face` with `font-display: swap`, and preload the one weight above the fold. A blocked webfont on a client's network must degrade to the system stack, not to a blank screen.

---

## 2. Files to change

**`apps/compass-ai/src/theme.ts`** — replace the `slate` and `amber` scales with a KIRIA-derived set. Keep the semantic-token structure exactly as it is (`bg.canvas`, `bg.surface`, `bg.raised`, `fg.default`, `fg.muted`, `border.default`, `accent.*`) so no component changes; only the values move. Add `citation.*` semantic tokens so the highlighter has a name of its own rather than borrowing the accent.

Generate the tint/shade ramps from the brand hexes rather than eyeballing them, and keep the brand hex as the 600 step so the pure colour is what appears at full strength.

**`apps/compass-ai/src/globals.css`** — the pulse (above), the pre-paint background (`#0e1117` → the KIRIA dark ground), and `*::selection`.

**`apps/compass-admin/src/theme.ts`** — the same token file. The admin app is internal, so it stays quieter: brand blue for structure, teal for interaction, no gradient headers, and yellow reserved for the alert-severity scale rather than sprayed across the eight screens.

**`index.html`** in both apps — `<title>` (see open items), a proper favicon from the wordmark, `<meta name="theme-color">` in brand blue, and `<html lang>` kept as is.

**Logos** — copy `logo_light.png` and `logo_white.png` into `public/brand/` in each app. Header uses the light (blue) wordmark on light surfaces and the white one on dark, ~20–24px tall, swapped by the colour-mode token rather than by two `<img>` tags with CSS display toggles. **Request SVG versions** (open items): a PNG wordmark at 22px will look soft on a retina screen and there is no fixing that in CSS.

**One source of truth.** Put the tokens in a single generated `src/theme/kiria-tokens.ts`, copied verbatim into each app — apps share no code by platform design — with the byte-comparison drift test that `folders.ts` already established. Three apps drifting apart on brand hexes is the same failure mode as three copies of a helper, and it is more visible to clients.

---

## 3. The portal shell around the app

The app is a brick inside a FuseBase portal. A perfectly branded app inside a default-styled portal still reads as someone else's product, so the shell is part of this phase.

`updatePortalCustomCode` writes custom CSS against the documented hooks — `[data-portal="sidebar"]`, `[data-portal="page-card"]`, `[data-portal="footer"]`, `[data-portal="breadcrumbs"]`, `header.header`, `.sidebar-menu-item-active`. Gate nests the CSS under the portal root itself, so write plain relative selectors.

Two constraints to check **before** promising this:

1. **CNAME-domain portals only.** If KIRIA's client portals are still on `*.p.thefusebase.com`, portal custom CSS is not available and the brand has to be carried by the app alone plus whatever the portal customizer exposes. Confirm which domain the live portals use before scoping the work.
2. **Do not set daisyUI variables** (`--p`, `--b1`, `--bc`). The docs are explicit that overriding them re-brands nothing — the real surfaces are Tailwind hex utilities. Set visual properties directly on the hooks.

Keep the portal CSS short and structural: sidebar and header in the navy→cobalt gradient, active nav item in brand blue, links in teal, Nunito Sans if the portal will load it. Resist restyling every widget — portal CSS is unversioned and untested, and every extra selector is something that silently breaks on a platform update.

---

## 4. The other client-visible surfaces

- **Alert emails** (§10 of Phase 4) are staff-facing but go out under KIRIA's name: a simple branded HTML template — blue header bar, white wordmark, ink body — with a plain-text alternative that still reads correctly.
- **Empty and error states** in the client app are where a product feels cheap or considered. "No documents yet — your KIRIA team is preparing them" deserves the wordmark and real spacing, not a grey line of text.
- **Compass Insights** (Phase 8) inherits the same tokens, and its charts follow the `dataviz` skill with the KIRIA palette substituted: blue and teal for series, yellow for the one value that matters, red only for decline — the colour law applies to charts more strictly than anywhere else.

---

## 5. What "not generic" means here

The brand system warns against work that looks AI-generated, and identifies the cause: *repetition* — six identical rounded boxes in a grid. The app equivalent is a screen where every panel has the same border, the same radius, the same weight, and nothing tells the eye where to go.

So: one emphasis per view. In the reading view the document is the subject and everything else recedes. In the chat, the answer and its citations carry the colour, the input and controls stay quiet. In the admin, the one number that matters on each screen is the one in brand blue at 800 weight; the rest of the table is ink.

---

## 6. Tests and review

- **A contrast test** in the unit suite: every foreground/background semantic pair, asserted at ≥4.5:1 for text and ≥3:1 for UI borders and icons, computed from the token values. This is the only guard that survives someone adjusting a hex later, and it takes twenty lines.
- **Screenshot review, actually looked at.** Playwright captures of the reading view, the chat with an answer and citations, an empty state and the admin's Libraries screen, in light and dark, at 1440 and 1024 — attached to the phase doc. A branding phase whose only evidence is "typecheck passed" has not been reviewed.
- **A font-blocked run**: load the app with the woff2 blocked and confirm the fallback stack renders a usable layout with no shifted rows.
- **Yellow audit**: grep the built CSS for `#F6F470` / its token and confirm it appears only in citation components.

---

## 7. Open items

1. **SVG logo.** Do vector versions of the wordmark exist? If not, worth commissioning — every future surface needs one.
2. **What is this product called to a client?** "Compass AI" is the internal name. In a client portal it may want to be "Compass", or KIRIA's name with no product name at all. It sets the `<title>`, the header and the favicon, so it is worth deciding once.
3. **Portal domain** — CNAME or not (§3.1). Decides whether the portal shell is in scope.
4. **Dark mode.** The apps support it and the brand is defined light-first. Either derive a dark palette from `--ink` and the gradient deliberately, or drop dark mode and pick one ground — a half-derived dark theme is where brand colours end up as mud.
5. **The headshot-and-follow footer** from the social system has no place in the app, and the contact strip probably does not either. Confirm there is no brand requirement I am dropping.
