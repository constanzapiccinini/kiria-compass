# PHASE 7 — The document fits on the screen

**Change specification — client app layout, chat panel, and two removals.**

Author: Coni · Date: 2026-09-08 · App: `apps/compass-ai` · Reported by users: *"the chat is full width, content is cut off, and I only see the whole document if I close both sidebars."*

---

## 0. Read first

`CLAUDE.md`, `AGENTS.md`, `app-ui-design`, `app-e2e-tests`. This phase touches the client SPA only — no migration, no Gate call, no pipeline change. The two removals reach into the admin app and the backend, and each has a matching column left in place for the 6B prune.

Independent of Phase 6; can ship before, after, or alongside it.

---

## 1. Why the document does not fit — the arithmetic

Nothing here is mysterious. Add up what the current layout demands horizontally:

| Element | Width |
|---|---|
| Document sidebar (`DocumentSidebar`, `DEFAULT_WIDTH`) | 288 px (240–420) |
| PDF thumbnail rail (`PdfViewer`) | 132 px |
| Viewer padding (`p="4"`, both sides) | 32 px |
| A page at the hard-coded `scale = 1.1` — US Letter 612pt, A4 595pt | ~655–673 px |
| Floating chat panel, `position: fixed`, over the viewer | 400 px + 16 margin |
| **Total before a single pixel is spare** | **~1541 px** |

A portal brick iframe is rarely that wide. Below it, the page is clipped by its scroll container or hidden behind the chat — and closing the sidebars is exactly the 288 + 132 px that buys it back. The bug report is arithmetically correct.

Three root causes, each fixed below:

1. **`const [scale, setScale] = useState(1.1)`** — the viewer never fits the page to the space it has. It renders at a fixed zoom and lets the container clip.
2. **The chat is an overlay, not a participant in the layout.** `position: fixed` means the viewer does not know it exists and cannot shrink for it.
3. **The width clamp is `min(width, viewportWidth − 2·MARGIN)`.** In a narrow embed that resolves to nearly the whole viewport — which is what "full-width chat" is.

---

## 2. The viewer fits to width

In `PdfViewer.tsx`:

- Add `fitMode: 'width' | 'manual'`, defaulting to `'width'`.
- Measure the **scroll container** with a `ResizeObserver`, not `window.resize`. This matters: collapsing the sidebar or docking the chat changes the container and fires no window event, which is precisely why the current layout only recovers when something is closed and the user scrolls.
- Compute `scale = (containerWidth − horizontalPadding) / widestPageWidth`, where `widestPageWidth` comes from `page.getViewport({ scale: 1 }).width` across the document's pages — the **widest**, not page 1. A document with one landscape page must not push every other page off-screen.
- Clamp to the existing `MIN_SCALE` / `MAX_SCALE`, and round to 2 decimals so a one-pixel container change does not trigger a re-render storm.
- The zoom buttons switch `fitMode` to `'manual'`. Add a **Fit** control that returns to `'width'` and shows as active while it is. Persist the mode per portal in `localStorage`, best-effort in try/catch, exactly like the sidebar's width — a private window must degrade to fit-to-width, never to a blank viewer.
- Keep the device-pixel-ratio multiplication in `PdfPage`'s render (`scale * ratio`); only the CSS scale changes.

Result: opening the sidebar, docking the chat, or resizing the browser re-fits the page instead of clipping it.

## 3. The chat docks instead of covering

`ChatWidget` becomes responsive rather than always-floating:

- **≥ 1024 px:** when expanded, the panel is a **column in the layout row** — `Flex flex="1"` viewer, then the chat with `flexShrink={0}`, width clamped to `clamp(320px, 32%, 480px)` and resizable within that range by dragging its left edge. It reserves space, so the viewer's ResizeObserver re-fits the page. Collapsed, it stays the bottom-right pill it is now.
- **< 1024 px:** it stays an overlay, but as a **bottom sheet** — full width, ~60% height, so it never sits on top of the text being read. `Escape` and the pill close it.
- **Drag-to-move is removed.** A docked panel has nowhere to go, and the geometry it persisted (`right`/`bottom`) is what produced the off-screen and full-width states this phase exists to fix. Delete the drag handlers, the clamping code and the stored `right`/`bottom`; keep only the width. **This deliberately reverses the "draggable within safe bounds" requirement in the original Phase 4 design** — record that in the phase doc so nobody restores it as a regression fix.
- Keep `Ctrl/Cmd+J` and the `role="dialog"` semantics. When docked it is no longer a dialog over content — use `aria-label` on a `<aside>`-shaped region instead, and do not trap focus, since the viewer beside it must stay reachable.

## 4. Height, and the iframe

`App.tsx` uses `h="100vh"` in four places. Inside a portal brick, and on mobile browsers with retracting toolbars, `100vh` is the classic source of a cut-off bottom row — the input box sitting just below the fold.

- Use `100dvh` with a `100vh` fallback for the app shell, and `h="100%"` for children of a sized parent.
- Give the shell a `minH` around 480 px so a short brick produces a scrollbar rather than a squashed, unusable layout.
- Verify against the real brick with `fromFrame=true`: check whether the platform's resize helper is sizing the iframe to content. If it is, a `100dvh` shell inside an auto-sizing iframe is a feedback loop — pin the shell height and let the inner panes scroll.

## 5. Remove Economy mode

Precision becomes the only behaviour.

**Client SPA:** delete the mode toggle in `ChatPanel.tsx` (the `['precision','economy']` block), the `retrievalMode` state and prop chain in `App.tsx`, and the `retrievalMode` argument from `createChat` / `ask` in `lib/client.ts`. Remove the `RetrievalMode` type.

**Client backend:** `lib/settings.ts` — `toRetrievalMode` always returns `'precision'`; the `retrievalMode` key in the settings patch is rejected, not silently dropped (`400`, per the validation bug 5C exposed). `lib/config.ts` — delete the `economy` entry from the retrieval profiles. `routes/chat.ts` — ignore any `retrievalMode` in the body.

**Admin app:** remove the mode control from `SettingsScreen.tsx` and its handler, and update `specs/compass-admin/settings.spec.ts`, which currently asserts on `retrievalMode="whatever" → 400`.

**Database:** leave `client_settings.retrieval_mode` and `chats.retrieval_mode` in place with their `'precision'` default; they join the 6B prune list. Add a one-line `UPDATE … SET retrieval_mode = 'precision' WHERE retrieval_mode = 'economy'` to the prune script so no stored row contradicts the code.

Check `app_settings.defaults` and the Settings screen's "which layer did this come from" display — a removed key must not render as an empty row.

## 6. Remove "Download conversation"

Delete the conversation download button in `ChatPanel.tsx` and the per-answer **Download .md** menu item, then `downloadMarkdown` and `safeFilename` from `lib/export.ts` once nothing imports them. `copyToClipboard`, `answerToMarkdown`, `transcriptToMarkdown` and `toPlainText` all stay.

**Replace the button with "Copy conversation"** rather than leaving the capability with no equivalent — same `transcriptToMarkdown` output, into the clipboard. Say so on delivery so it can be vetoed; removing copy as well is one line.

Worth knowing: a script-driven `<a download>` is blocked in many embedded-iframe contexts anyway, so this button may already have been failing silently for portal users.

## 7. While in here

- The **sidebar collapse must re-fit the viewer** — that is the ResizeObserver in §2, and it is the single change that answers the actual complaint. Assert it.
- The header row (`App.tsx` 440–494) uses `HStack minW="0"` with ellipsis. Confirm the document name truncates rather than pushing the controls off the row at 1024 px and below.
- The thumbnail rail is a fixed 132 px. Below about 900 px total width it should hide, with a control to bring it back — 132 px is 15% of the screen for something rarely used on a small display.

## 8. Tests

Layout regressions are invisible to unit tests and to every assertion this project has. Add `specs/compass-ai/layout.spec.ts`, run at three viewports — **1440×900, 1280×800, 1024×768**:

1. Open a document. Assert the rendered page's `clientWidth` is **≤ the scroll container's `clientWidth`**, and that `document.documentElement.scrollWidth === clientWidth` (no horizontal page scroll).
2. Expand the chat. Assert the same again, and that the chat's bounding box **does not intersect** the page canvas's box — the direct assertion of "the chat covers the document".
3. Collapse the sidebar, assert the page re-fits (scale increased), expand it, assert it re-fits back.
4. At 1024 px: the chat panel is at most 480 px wide. Below the breakpoint it is a bottom sheet and the page is still fully visible above it.
5. No control in the chat header mentions Economy or Download.

These need a portal-bound session for the full client app; where that is not obtainable, run them against the same components with a stubbed session, as `fixtures.spec.ts` does. A layout test that skips is worth nothing here — this is the one class of bug that only a browser can catch.

## 9. Open items

1. **Copy conversation** as the replacement for the download — keep, or drop clipboard export entirely?
2. **Docking breakpoint** at 1024 px, and the 32% / 320–480 px chat width — worth checking against the actual brick width in a real client portal before fixing the numbers.
3. **Thumbnail rail** — hide below 900 px, or remove it entirely? It costs 132 px permanently and duplicates what the page indicator already tells the reader.
4. Whether the viewer should remember **fit vs manual zoom per document** rather than per portal.
