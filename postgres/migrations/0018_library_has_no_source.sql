-- ---------------------------------------------------------------------------
-- 0018 — a library document has no sync source
--
-- `portal_visible_documents` is a UNION ALL of two arms:
--
--   … JOIN documents d ON d.source_id  = b.source_id   -- synced by a source
--   … JOIN documents d ON d.library_id = b.source_id   -- owned by a library
--
-- 0014 introduced that shape with a comment asserting the arms are disjoint, because
-- "0013's XOR check means a document has either a client or a library, and a library
-- document is not synced by a source". **The first half is true and the second was an
-- assumption.** The XOR check constrains `client_id` against `library_id`; it says
-- nothing about `source_id`, and a document can carry both a `source_id` and a
-- `library_id` — at which point both arms match and the portal sees it twice.
--
-- That is not hypothetical: it is exactly what the §6.5 migration produced on its
-- first dev run. A document moved out of its tenant's `app_upload` source into a
-- private library kept the old `source_id`, and the portal's visible count went from
-- 1 to 2. The migration's own before/after check caught it, which is the only reason
-- it was not shipped.
--
-- The migration now clears `source_id` when it moves a document, and
-- `document-intake.ts` already writes NULL there for anything uploaded into a
-- library. This constraint is what makes those two facts a guarantee instead of a
-- convention — the arms of that view are disjoint because the database refuses the
-- row that would overlap them.
--
-- `source_id` remains the sync handle for a tenant-owned document, so the constraint
-- is one-directional: a library forbids a source, a source does not forbid a client.
-- ---------------------------------------------------------------------------

ALTER TABLE public.documents ADD CONSTRAINT documents_library_has_no_source_check
  CHECK (library_id IS NULL OR source_id IS NULL);

COMMENT ON CONSTRAINT documents_library_has_no_source_check ON public.documents IS
  'A library document is reached through its library, never through a sync source. '
  'Without this both arms of portal_visible_documents can match the same row and a '
  'portal sees the document twice.';
