-- ---------------------------------------------------------------------------
-- 0011 — FORCE ROW LEVEL SECURITY on every RLS-enabled table
--
-- This was deferred across two earlier migrations with the note that one question
-- had to be answered first: FORCE applies policies to the table OWNER as well, and
-- the owner is the role that runs migrations and platform checkpoints. A checkpoint
-- that silently reads zero rows is a backup-shaped failure, which is worse than a
-- warn-level manifest finding — so it was not switched on by guesswork.
--
-- The question is now answered, from the database rather than by assumption:
--
--   tables are owned by  isolated_pg_migrator   rolbypassrls = TRUE
--   platform bypass role  isolated_pg_rls_bypass rolbypassrls = TRUE
--   app runtime role      isolated_pg_runtime    rolbypassrls = FALSE, not the owner
--
-- BYPASSRLS outranks FORCE: a role holding it is never subject to policies, forced
-- or not. So FORCE cannot affect migrations or pg_dump — both run as roles that
-- bypass — and the only role it could affect, isolated_pg_runtime, is already fully
-- subject under plain ENABLE because it does not own the tables.
--
-- Which makes this behaviourally a no-op today, and worth applying anyway for two
-- reasons: it removes 23 warn-level findings so that a real future warning is not
-- lost among them, and it is the correct posture if a table is ever re-owned or the
-- app is ever run as its owner — at which point the absence of FORCE would silently
-- disable every policy in this schema.
--
-- Verified after applying: reads still return rows, client scoping still filters in
-- both directions, and the full e2e suite still passes.
-- ---------------------------------------------------------------------------
ALTER TABLE public.alert_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.chat_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.chats FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_group_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_folders FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_paragraphs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.embedding_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ingest_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.portal_source_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.portals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.rag_traces FORCE ROW LEVEL SECURITY;
ALTER TABLE public.system_alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.usage_events FORCE ROW LEVEL SECURITY;
