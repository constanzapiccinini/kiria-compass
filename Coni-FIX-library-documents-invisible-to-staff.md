# FIX — library documents are invisible to staff inside a portal

**Reported:** the documents uploaded into a library do not appear in the portal.
**Status:** reproduced against production, root cause identified, not a data or sync problem.
**Scope:** one file — `apps/compass-ai/backend/src/routes/documents.ts`.

---

## What production actually says

Read-only diagnosis (`scripts/Coni-diagnose-library-visibility.mjs`, prod):

```
library "New library test"        1 document, indexed, 148 chunks, ticked to 1 portal
document  Mayo Clinic_KIRIA_3.8.2026.pdf   status=indexed  chunk_count=148  error=null
tick      New library test → client-a-portal (active)
portal    client-a-portal   visible_docs = 1
```

So the ingest worked, the tick worked, and `portal_visible_documents` — the view that
answers "what may this portal see" — **returns the document**. Nothing is out of sync.

The two views, counted for that portal:

| Query | Rows |
|---|---|
| `portal_documents_admin WHERE portal_id = …` (resolves libraries) | **1** |
| `documents WHERE client_id = <that portal's tenant>` | **0** |

## Root cause

`GET /api/documents` and the shared `loadDocument()` helper both branch on the actor:

```ts
const rows = isClientActor(context)
  ? /* JOIN public.portal_visible_documents v ON v.document_id = d.id  WHERE v.portal_id = $1 */
  : /* SELECT … FROM documents WHERE client_id = $1 AND status <> 'deleted' */
```

The **client** branch goes through the view and sees library documents. The **employee**
branch filters on `client_id`, and a library document has `client_id IS NULL` by
construction (`0013`'s XOR check: a row belongs to a tenant *or* to a library, never
both). So a library document can never satisfy it.

The comment above that branch explains an intent from Phase 4A — "an employee sees
everything belonging to the client, including rows still processing or failed" — written
before libraries existed. 5B introduced a second kind of ownership and this predicate was
not revisited.

**Why it looks like a sync failure from the outside:** staff open a client portal and the
sidebar is empty, while the chat can still cite the document, because retrieval
(`lib/rag.ts`, `routes/chat.ts`) always goes through `portal_visible_documents` and was
never actor-dependent. A client user would have seen the document all along.

## The fix

Both employee branches resolve through `portal_documents_admin`, keeping the property
that made them different in the first place — staff see rows that are still processing,
failed, or orphaned, which the client-facing view filters out.

Do **not** simply swap the predicate: a document owned by this portal's tenant whose
source lost its binding has no row in the admin view either, and today staff can still
see it. Keep both reachable:

```sql
-- list
SELECT <columns>
  FROM documents d
 WHERE d.deleted_at IS NULL
   AND d.status <> 'deleted'
   AND ( d.client_id = $1                                        -- this portal's own tenant
      OR EXISTS (SELECT 1 FROM public.portal_documents_admin a   -- + anything the portal is ticked for
                  WHERE a.document_id = d.id AND a.portal_id = $2) )
 ORDER BY d.created_at DESC
```

and the same `OR EXISTS` shape in `loadDocument()`, which is what makes opening the PDF
and fetching its pages work rather than 404.

Points to get right:

- `portal_documents_admin` is a `UNION ALL` over two disjoint sets (the XOR check
  guarantees a row is either source-owned or library-owned), so no `DISTINCT` is needed —
  but confirm that on a portal ticked for both a table source and a library before
  shipping.
- Check the plan. `EXISTS` against a view that itself unions two joins is the kind of
  predicate that turns a list route into a sequential scan once a library has a few
  thousand documents.
- `auditCrossTenantMiss` must keep firing on a genuine cross-portal id and **not** on a
  library document a portal simply is not ticked for — that is an ordinary 404, not a
  tenancy probe, and mislabelling it puts a critical alert in the inbox on every miss.

## The test that would have caught it

Every library assertion so far was made either directly against the database
(`verify-library-rls.mjs`, `libraries.spec.ts`) or as a client. Nothing asserted what
**staff** see through the portal, which is the only view a person at KIRIA actually looks
at.

Add to `specs/compass-admin/libraries.spec.ts` (it already has an admin session, so it
runs — no portal-bound session needed):

1. Create a library, upload one PDF, wait for `indexed`, tick portal A.
2. As staff, `GET /api/documents` on the **client app** for portal A → the document is in
   the list.
3. `GET /api/documents/:id` and `/pages` → 200, not 404.
4. Untick → it leaves the staff list too.

## Two things that are not this bug

- **Only `client-a-portal` is ticked.** `Compass Client B` and `kiria-template` are
  `status = 'paused'` and have no library ticks at all, and a paused portal is filtered
  out of both views by design. If a real client portal is meant to show these files, tick
  it and make sure it is active.
- **`TENANCY_PROBE` is open with 84 occurrences.** That is the tenancy e2e suite doing its
  job — it probes `?clientId=` on purpose, and the refusal is correct behaviour. Resolve
  the alert, or read the `cause`, which names the route. It is not related to the missing
  documents.
