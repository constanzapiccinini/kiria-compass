# Compass AI — Phase 2 handoff

Viewer + chat plugin. Builds on [PHASE-1.md](./PHASE-1.md), which remains the record
of the data model, RAG core and platform decisions.

## What Phase 2 adds

| Capability | Where |
| --- | --- |
| Scrollable PDF viewer with lazy page rendering | [src/components/PdfViewer.tsx](src/components/PdfViewer.tsx), [PdfPage.tsx](src/components/PdfPage.tsx) |
| Page thumbnail rail | [src/components/PdfThumbnail.tsx](src/components/PdfThumbnail.tsx) |
| Floating, draggable, resizable chat widget | [src/components/ChatWidget.tsx](src/components/ChatWidget.tsx) |
| Clickable citations → page jump + paragraph highlight | [ChatPanel.tsx](src/components/ChatPanel.tsx) + [PdfViewer.tsx](src/components/PdfViewer.tsx) |
| Multi-document scope selector inside the widget | [ChatPanel.tsx](src/components/ChatPanel.tsx) |
| Copy / export answers and transcripts | [src/lib/export.ts](src/lib/export.ts) |
| Chat session restore across reloads | [src/App.tsx](src/App.tsx) |
| PDF byte proxy with role enforcement | `GET /api/documents/{id}/file` |

## Decisions worth knowing

### The browser never receives the file service URL

Phase 1 returned `readUrl` in the document list. That URL is **public** — anyone
holding the link could read the PDF regardless of workspace role. Phase 2 removes it
from every API response and adds `GET /api/documents/{documentId}/file`, which
re-checks the caller's workspace role and streams the bytes. This also removes any
dependence on the file service's CORS policy, since PDF.js now loads a same-origin
URL.

### Pages render lazily, with a correctly-shaped placeholder

An `IntersectionObserver` with an 800px root margin renders a page when it is about
one screen away. The placeholder is sized from the page's real viewport first, so
scroll position never jumps as pages finish rasterizing. Rendering uses
`devicePixelRatio` (capped at 2) so text stays crisp without quadrupling memory on
high-DPI displays.

Thumbnails render lazily on the same principle; a 400-page document would otherwise
rasterize 400 previews on open.

### Highlights are stored normalized, so they survive zoom

Paragraph bounding boxes are normalized 0..1 with a top-left origin (converted from
the PDF's bottom-left origin during ingestion — see Phase 1). The overlay is
positioned in percentages, so a highlight stays correct at any zoom level with no
recalculation.

Geometry is fetched **per page**, not per document, so jumping to a citation on page
380 does not download the whole document's paragraph set.

### Citation buttons are validated against the backend's citation list

The answer text contains `[Document, Page N]` labels. Rather than trusting a regex
match to be a real target, each label is resolved against the `citations` array the
backend returned. A label with no match renders as plain text instead of a button
that would jump nowhere. This keeps the Phase 1 guarantee — that a citation can only
point at a passage that was genuinely retrieved — intact through to the click.

### PDF.js assets are served from the app, not a CDN

`cmaps` and `standard_fonts` are loaded by PDF.js at runtime by URL, so Vite cannot
bundle them. [scripts/copy-pdfjs-assets.mjs](scripts/copy-pdfjs-assets.mjs) copies
them into `public/pdfjs/` from `prebuild`/`predev`. Without the cmaps, CJK and
custom-encoded PDFs render blank text; without the standard fonts, base-14 font
metrics are wrong. Serving them locally also keeps the app working under a strict CSP.

`public/pdfjs/` is generated and gitignored.

### The viewer is code-split

PDF.js is ~490 kB of the bundle. It is loaded with `React.lazy`, so the shell,
document list and chat paint immediately and the viewer arrives only for users who
open a document.

| Chunk | Size | Gzipped |
| --- | --- | --- |
| `index` (shell + Chakra + chat) | 557 kB | 160 kB |
| `PdfViewer` (PDF.js) | 491 kB | 147 kB |
| `pdf.worker` (separate, loaded by the worker) | 1,265 kB | — |

### Widget geometry is clamped, not just remembered

Position and size persist in `localStorage`, but are re-clamped into the viewport on
mount and on every window resize. A panel remembered from a wide monitor would
otherwise open off-screen on a laptop. Storage access is wrapped in `try/catch`, so
private browsing or blocked site data degrades to the default position rather than
failing.

## Two bugs found and fixed during verification

**The viewer refused to open documents that had not been indexed.** Auto-open only
considered `status === 'indexed'`, so a document whose indexing failed (or was still
running) could not be read at all — even though its bytes were stored and perfectly
readable. Reading a PDF does not require an index; only the chat's *search scope*
does. Fixed in `App.tsx`.

**The scope selector could read "1 of 0 selected".** The label counted all selected
ids against only the *ready* ones. It now counts only searchable selections, and
reports "No indexed documents" when nothing is searchable. Chat session restore also
drops restored scope entries that are no longer indexed.

## Verified in a real browser

Driven with Playwright against `fusebase dev start`, using two distinct seeded PDFs.
**22 of 22 checks passed.**

Viewer and shell:

- App shell renders; no console errors (Vite's HMR socket cannot traverse the CLI dev
  proxy — that is a dev-server artifact, excluded deliberately).
- Page 1 and page 2 both rasterize with real content — verified by **sampling canvas
  pixels**, not just asserting a canvas exists, so a blank render would fail.
- Page indicator tracks the visible page; thumbnail rail renders one entry per page.

Chat widget:

- Starts collapsed as a pill; `Ctrl+J` expands and collapses it.
- Previous conversation is restored on load.
- Drag moves the panel; geometry persists to `localStorage` and is restored exactly
  after a reload (x 924 → 924, y 284 → 284).

Citations — the core Phase 2 claim:

- An inline citation renders as a jump button.
- Clicking it scrolls the viewer to the cited page and draws the highlight overlay.
- **Cross-document routing:** clicking a `turbine.pdf` citation while `sample.pdf` is
  open switches the viewer to `turbine.pdf`, and the highlighted paragraph's text was
  asserted to be the turbine finding — not the reactor one. Clicking the other
  citation routes back. This is the check that would catch citations resolving to the
  wrong document in a multi-document session.

A screenshot confirmed the highlight lands exactly on the cited sentence.

Static checks: root `npm run lint`, root `npm run typecheck`, app build, and
`fusebase api validate` (27 operations) all clean. No `any` or broad casts.

Test fixtures (seeded chats, documents, workspaces) were removed afterwards; the
store is back to one workspace and zero documents.

## Still not verified — needs credentials

Unchanged from Phase 1: `OPENAI_API_KEY` has no value, so **no answer has ever been
generated by the real model**. Phase 2's citation path was verified using a seeded
assistant message whose citation payload matches exactly what the Phase 1 pipeline
produces, which exercises every UI code path — but the end-to-end
question → retrieval → answer → citation → jump chain still needs the key.

OCR likewise remains unconfigured (`ocrConfigured: false`).

## Known gaps and follow-ups

1. **Paragraph highlighting depends on ingestion having run.** Geometry lives in
   `document_paragraphs`, written during ingestion. A document that failed to index
   can be *read* but has no highlight boxes, so a citation into it could not draw one.
   In practice a citation can only exist for an indexed document, so this is
   consistent — worth remembering if reindexing semantics change.
2. **No text layer over the canvas.** Text is not selectable or searchable in the
   viewer, because pages render to canvas only. Adding PDF.js's text layer would
   enable select/copy and in-document search; it roughly doubles per-page DOM cost.
3. **The verification suite was temporary and has been deleted.** These scenarios —
   especially cross-document citation routing — are the product's core contract and
   deserve to be permanent regression tests. `fusebase scaffold --template e2e` plus
   the `app-e2e-tests` skill is the sanctioned way to make that environment-aware and
   CI-wired; it was left out of Phase 2 because it was not in scope.
4. **`files.write` remains in the browser token** (carried over from Phase 1). The
   store permissions are backend-only; this one cannot currently be moved.
5. **Chat history is a single session per workspace.** Restore picks the most recent
   chat. A chat list/switcher in the widget is a natural Phase 3 addition alongside
   multi-document sessions.
6. **The 500 kB chunk warning persists** for the shell chunk (Chakra UI). Splitting it
   further is possible but the shell is needed immediately, so it would not improve
   perceived load.

## Phase 3 readiness

Phase 3 is multi-document sessions and cost controls. Most of the groundwork exists:

- The chat's document scope is already a first-class, server-validated set
  (`PUT /api/chats/{id}/documents`), and citations already carry `documentId`, so
  per-document citation correctness is proven.
- Server-side caps (answer tokens, retrieved tokens, OCR pages, monthly budgets) were
  built and verified in Phase 1.
- What Phase 3 actually adds: the OpenAI **Batch API** for bulk embedding, and an
  indexing-status dashboard.
