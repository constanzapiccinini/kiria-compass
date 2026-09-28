# Phase 7 — The document fits on the screen

Shipped to production on 2026-09-08, alongside 6A. Client SPA only: no migration, no
Gate call, no pipeline change.

The bug report was *"the chat is full width, content is cut off, and I only see the
whole document if I close both sidebars."* It was arithmetically correct, and §7.1's
table is the whole diagnosis: at the old fixed zoom the layout demanded ~1541px before
a single pixel was spare, and a portal iframe is rarely that wide.

---

## 1. The three causes, and what each became

| cause | before | after |
| --- | --- | --- |
| the viewer never fitted | `useState(1.1)`, container left to clip | fit-to-width by default, measured with a `ResizeObserver` |
| the chat was an overlay | `position: fixed`, viewer unaware of it | a column in the layout row ≥1024px; a bottom sheet below |
| the width clamp | `min(width, viewport − 32)` → nearly full width in a narrow embed | `clamp(320, —, 480)`, and the panel reserves its space |

### Why the observer, not `window.resize`

This is the single change that answers the actual complaint. Collapsing the sidebar or
docking the chat changes the viewer's container and fires **no window event** — which
is exactly why the old layout only recovered when something was closed *and* the user
happened to scroll. Observing the element means opening the sidebar re-fits the page
instead of clipping it.

### Why the widest page, not page one

`widestPage()` takes the maximum across the document (capped at the first 20 pages —
a stated trade, not an oversight). Fitting to page 1 renders every portrait page
correctly and pushes a single landscape fold-out off the right edge, with nothing about
the viewer looking wrong. That is the kind of defect that surfaces months later as
"the app cut off my drawing".

---

## 2. The bug the tests found

`fitScale` rounded to two decimals. Rounding goes **up** half the time:

```
Number((992 / 595).toFixed(2)) = 1.67      595 × 1.67 = 993.65 px
                                            available =  992    px
```

Two pixels over, which is a horizontal scrollbar — on the exact layout this phase
exists to remove. It failed at **five of the nine** container widths tested, including
1024, 1280 and 1440. Truncating (`Math.floor(clamped * 100) / 100`) can only ever fit.

Verified in both directions: the guard was watched failing with the rounding restored,
and passing without it.

This is the argument for pulling the arithmetic into `src/lib/fit.ts` rather than
leaving it inline in the component. Inline, it was untestable, and this bug would have
shipped as "there's still a scrollbar sometimes".

---

## 3. Two removals

### Economy mode (§7.5)

Precision is the only retrieval behaviour. The toggle, the state, the prop chain and
the `economy` retrieval preset are gone.

`RetrievalMode` survives as a **one-member union**, deliberately: the columns
`client_settings.retrieval_mode` and `chats.retrieval_mode` are still there — 6B kept
them, since dropping them buys nothing and the values are now uniform — so a stored
`'economy'` is still readable and is **narrowed to precision on read**. That is what
makes the code and the data agree without a migration.

The two write paths refuse differently, and the asymmetry is intentional:

- **`updateClientSettings` / the admin settings routes: 400, naming the field.**
  Someone is stating an intent to change something, and being told "saved" when nothing
  was is the exact failure §5C found in these handlers.
- **`POST /api/chats` and `/ask`: ignored.** The mode was never the point of a chat
  request, and refusing the whole question because a stale cached bundle still sends a
  field that no longer changes anything would break asking a question.

**Done in 6B**, by `scripts/prune-6b-preflight.mjs` rather than the migration — Gate
rejects `UPDATE` inside a migration bundle, which are schema-only by contract. It
normalised one dev settings row and one prod chat row that still said `'economy'`, so
no stored row contradicts the code.

### Download conversation (§7.6)

Both download buttons are gone, along with `downloadMarkdown` and `safeFilename`.
**Replaced with "Copy conversation"** — the same `transcriptToMarkdown` output, into the
clipboard — rather than removing the capability outright. Say the word and dropping
clipboard export as well is one line (§9.1).

Worth knowing why this is not a real loss: a script-driven `<a download>` is blocked in
many embedded-iframe contexts, and every reader of this app is inside a portal iframe.
Those buttons may have been failing silently the whole time.

### Drag-to-move (§7.3)

**This reverses the "draggable within safe bounds" requirement of the Phase 4 design.**
Recorded here so nobody restores it as a regression fix. A docked panel has nowhere to
go, and the persisted `right`/`bottom` geometry is what produced the off-screen and
full-width states this phase exists to fix. Only the width persists now, and a stored
value outside the new 320–480 range is **discarded rather than clamped** — a stored 720
from the floating era is not a preference for 480, it is a value from a different
layout.

Docked, the panel is a labelled `<aside>` region rather than a `role="dialog"`, and
focus is deliberately **not** trapped: the viewer beside it has to stay reachable by
keyboard. As a bottom sheet it is over the content, so it keeps the dialog role there.
`Ctrl/Cmd+J` and `Escape` work in both.

---

## 4. Also in this pass

- **Heights** are `['100vh', '100dvh']` with `minH="480px"` (§7.4) — `100vh` in a
  portal brick, and on a mobile browser with a retracting toolbar, is the classic
  cut-off bottom row with the chat input just below the fold.
- **The thumbnail rail** hides below 900px, with a toolbar control to bring it back. It
  costs a permanent 132px, which is 15% of a 900px screen for something a reader rarely
  uses; narrowing it rather than hiding it would cost the same space and answer
  nothing. Removing it entirely is still on the table (§9.3).
- **Fit vs manual** is remembered per portal in `localStorage`, in try/catch. A private
  window degrades to fit-to-width, never to a blank viewer.
- **The document name was not truncating** (§7.7). The spec asks to *confirm* it does;
  it did not. The title carried `truncate`, but a flex item defaults to
  `min-width: auto` and will not shrink below its content's intrinsic width — so
  `text-overflow: ellipsis` never engaged and a long filename pushed the page and
  zoom controls off the right of the toolbar instead. `flex="1" minW="0"` fixes it.
  Note also that §7.7 places the document name in `App.tsx`'s header row; after §5C
  it is in the viewer's own toolbar, and the header carries no document name at all.

---

## 5. Tests, and the gap

### What runs

`apps/compass-ai/backend/tests/invariants.test.ts` gained two blocks:

- **The fit arithmetic**: the computed scale never asks for more width than the
  container has (nine container widths × four page sizes), the clamps hold at both
  ends, every degenerate input returns `null` rather than 0 or Infinity — each of which
  renders a blank viewer — and the widest page is tighter than the first.
- **The removals stay removed**: no `economy`, no `downloadMarkdown`, no "Download .md"
  anywhere in either SPA. Each was removed by deleting a control, which is a one-line
  change to undo by accident — and a restored toggle would now send a patch the backend
  400s, from a screen that looks perfectly fine.

`tests/e2e/specs/compass-ai/layout.spec.ts` runs at 1440×900, 1280×800 and 1024×768 and
asserts the shell never scrolls sideways (naming the widest offending element when it
does) and that it fills the viewport height without exceeding it. 4 passed against
production.

### The fixture helper broke, and the test for that caught it

`uploadPdf` was rewritten in §6A to resolve the portal's **private** library. On
production it threw: `is_private` promises one portal, and the §6.5 migration
correctly created a *shared* library for the tenant that owns two of them — so
`client-a-portal` has no private library at all.

`fixtures.spec.ts` is what went red, which is the entire reason that spec exists. The
tempting fix — fall back to any library the portal receives — is worse than the bug:
the one available there is ticked to **both** of that tenant's portals, so a fixture
document would be visible to the other one, and `portal-tenancy.spec.ts` asserting
that portal B cannot see portal A's document would be asserting something the fixture
had made false. A test that passes while proving nothing.

So the fixture owns its library: `e2e-fixture-<stamp>`, ticked to the one portal, and
`deleteDocument` now takes the library id and unticks and deletes it. That second
argument is the part that matters — without it, a real client is looking at a library
called `e2e-fixture-…`, which this suite has genuinely left on production more than
once.

### What does not, and why it is stated rather than skipped

§7.8's real assertions — the page fits its scroll container, the chat's box does not
intersect the page canvas, collapsing the sidebar re-fits the page — all need **a
document open in the viewer**, which needs a portal-bound session. Gate exposes no way
to mint one; that is the same wall roughly twenty-five specs in this suite hit.

The spec says a layout test that skips is worth nothing, and it is right. So rather
than a skipped spec that looks like coverage:

- the arithmetic behind all three is unit-tested, which found a real bug;
- the shell-overflow assertions run unconditionally and would catch a chat panel
  clamped to the viewport width or fixed widths that overrun;
- **the pixels remain unverified by machine.** Someone has to open a document in a real
  portal at 1024px and look. Until a portal-bound session is obtainable, that is the
  honest state of it.

The layout spec also passes against the *pre-Phase-7* build, which measures how weak it
is: without a document open, the shell alone does not exercise the three causes. It is
a floor, not a proof.

---

## 6. Open items

1. **Copy conversation** as the replacement for the download — keep, or drop clipboard
   export entirely? Kept for now; dropping it is one line.
2. **The numbers**: the 1024px docking breakpoint, and the 320–480px chat width. §9.2
   asks for these to be checked against a real client portal's brick width, which has
   not been done — they are reasonable defaults, not measured ones.
3. **The iframe check in §7.4 is blocked, not skipped.** Whether the platform's
   resize helper sizes the brick to content is still unverified, and if it does, a
   `100dvh` shell inside an auto-sizing iframe is a feedback loop and the shell height
   should be pinned instead. It was attempted: the app's own host serves no iframe and
   no resize helper, and the portal page renders its bricks client-side — 312KB of
   markup with zero `<iframe>` tags and no mention of the app — so the brick only
   exists after an authenticated portal session renders it. That is the same
   portal-bound-session wall as §7.8. One look by a person inside a real portal
   settles it in a minute; nothing here can.
4. **The thumbnail rail** — hidden below 900px, or removed entirely?
5. Whether the viewer should remember **fit vs manual per document** rather than per
   portal (§9.4). Per portal today.
