# Demo walkthrough — the client path, end to end

**Run this once before the demo, on `client-a-portal`.** It takes about ten minutes.

## Why this is manual, and why it matters more than usual

Everything in this runbook is covered by e2e specs that **skip**. Twenty-four of them:
the chat widget, citations, the PDF viewer, grounded answers, upload visibility,
cross-portal isolation. They skip for a real reason — Gate only returns a portal-bound
session when the session was minted through the portal launcher, and a magic-link
sign-in never is. That is the tenancy property working, not a gap to route around
(`tests/e2e/helpers/portal.ts` has the full explanation).

The consequence is specific and worth saying plainly: **the demo path is the least
automatically verified path in the product.** A human opening a portal does get the
session the tests cannot mint, so it works — but the demo will be the first full
exercise of it since Phase 7, and this runbook exists so that the first exercise is not
in front of a client.

---

## What the demo has to work with

| | |
| --- | --- |
| Portal | `client-a-portal` |
| Client | CLIENTE B |
| Document | `Mayo Clinic_KIRIA_3.8.2026.pdf` — 96 pages, 148 indexed passages |
| Library | (renamed for the demo — see step 0) |

That is the only portal with visible content. `client-b-portal` shows an empty state,
`kiria-template` is paused, and the fourth was removed as part of the demo prep.

---

## 0. Before you open anything

- [ ] Open **Compass Admin → Alerts**. Expect a yellow banner: *"Alert delivery is
      paused"*. If the rail shows a red badge, the pause did not take — stop and say so.
- [ ] **Libraries**: the list should be short and legible. No `e2e-…`, no `nuevo`, no
      `New library test`.
- [ ] **Indexing**: the headline number is *unreachable by a question*. It must read
      **0**. Anything else means a document a client can open but cannot get an answer
      out of, which is the worst thing to discover live.

---

## 1. The portal opens

- [ ] Open `client-a-portal` as a portal member — through the portal, not through
      `compass-ai.thefusebase.app` directly. The direct host will not give you a
      portal-bound session and the app will not resolve a client.
- [ ] The KIRIA wordmark is in the header, and the type is Nunito Sans (rounder, more
      humanist than the system font — if you are unsure, it did not load).
- [ ] The document rail lists **one** document.

**If the app says it cannot resolve a portal:** you are on the app host rather than
inside the portal. That is the single most likely way this demo goes wrong.

---

## 2. The document renders

- [ ] Click the document. The PDF renders; page count reads **96**.
- [ ] Thumbnails appear in the rail.
- [ ] Click a thumbnail well down the document — the viewer jumps to it.
- [ ] Resize the window narrower. The page scales to fit rather than clipping.
- [ ] **Hyperlinks inside the PDF work.** Hover one — it tints teal and the status
      bar shows the URL — and click it. It must open in a **new tab**, never replace the
      portal. A link that does nothing means the annotation layer sized itself to zero,
      which is silent: nothing appears in the console.

Before the demo you can check the last two without a portal at all:

    node scripts/probe-client-render.mjs apps/compass-ai/dist <a-pdf-with-links> out.png

That renders the built app against a stubbed session and reports whether the tree
mounted and whether the PDF's anchors are present, clickable and targeted at a new tab.

---

## 3. The answer is grounded — the part worth demoing

Open the chat (bottom-right widget, or `Ctrl+J`).

- [ ] Ask something the document genuinely answers. Something specific and factual
      beats something broad — the retrieval is in `precision` mode, so a narrow
      question produces a tighter answer with cleaner citations.
- [ ] The answer arrives with **citations underneath**, each naming a page.
- [ ] **Click a citation.** This is the demo. The viewer should jump to that page and
      the cited paragraph should be highlighted in KIRIA yellow with a blue pulse ring,
      twice, then settle.
- [ ] Confirm by eye that the highlighted paragraph actually supports the sentence it
      was cited for. If it does not, say so — a citation that points at the wrong
      paragraph is worse than no citation, and it is better found now.

---

## 4. The refusal — demo this too

- [ ] Ask something the document cannot possibly answer ("what is our pricing in
      Brazil?").
- [ ] The answer must be an explicit refusal with **no citations** — not a plausible
      invention.

This is the more persuasive half of the demo for a pharmaceutical audience, and it is
the behaviour most likely to be doubted. Show it deliberately rather than hoping the
question comes up.

---

## 5. Leave it clean

- [ ] The demo conversation is now in the client's history. Decide before the demo
      whether that matters; if it does, delete the chat afterwards from the portal.
- [ ] Nothing else to undo. Nothing in this runbook writes to the library or the index.

---

## If something fails

Record **which step**, and what you saw rather than what you concluded. The steps map
onto different subsystems and the step number is most of the diagnosis:

| step | subsystem |
| --- | --- |
| 1 | portal context resolution (`lib/portal.ts`) |
| 2 | the PDF byte proxy and the viewer |
| 3 | retrieval → generation → citation resolution |
| 4 | grounding refusal |

For 3 and 4, `Compass Admin → Usage` will show whether the model call happened at all,
which separates "the model answered badly" from "the call never went out".
