-- ---------------------------------------------------------------------------
-- 0007 — PostgreSQL row-level security on the org-keyed tables (§4.3, step 1)
--
-- What this does and, more importantly, what it does NOT do.
--
-- DOES: enables real, Postgres-enforced RLS on the seven tables that carry an
-- `org_id`, scoping every row to the organization on the calling token. The
-- store reports `bypassRls=false` and `superuser=false` for the runtime role
-- `isolated_pg_runtime`, so these policies actually filter — this is not the
-- degraded mode where policies exist and are ignored.
--
-- DOES NOT: give this app per-client row isolation. `documents`,
-- `document_chunks`, `chats`, `chat_messages`, `document_pages` and
-- `document_paragraphs` — the tables whose contents a cross-tenant read would
-- actually expose — carry no `org_id` at all; they are keyed by `client_id`, or
-- one level further down by `document_id`. Declaring them would need `org_id`
-- plus covering indexes added across ~15 tables and backfilled, which is a
-- separate migration and a separate seed step. Until that lands, client-level
-- tenancy remains enforced in application code (the verified portal context,
-- the `portal_visible_documents` view, and `loadOwnedDocument`'s single
-- resolution point), and **this app must not be described as row-level-secured**.
--
-- Why start here anyway: it is the whole of what Gate's RLS manifest currently
-- flags (15 warnings — these seven tables plus one missing index), it is
-- verifiable today, and it makes the declared posture in
-- `postgres/migrations/rls-manifest.json` true instead of aspirational.
--
-- ---------------------------------------------------------------------------
-- Why `app.org_id`, and why it is safe to switch on
--
-- Measured through the deployed backend's own service token before writing a
-- line of policy, because getting this wrong turns every read into zero rows —
-- a total outage on a live store holding a real client's documents:
--
--   app.org_id   = "u27b70"          <- present, and matches this org
--   app.client_id = "sfqksmtybcsejlru"  <- the PRODUCT id, not `clients.id`
--   app.user_id  = "3700332"         <- the deploying owner, not the visitor
--   app.portal_id = ""               <- empty; needs isolated_store.rls.delegate
--
-- So `app.org_id` is the only injected setting that is both present and means
-- what a policy would need it to mean. The other two are live traps: a policy
-- keyed on `app.client_id` would compare against a product id shared by sibling
-- apps, and one keyed on `app.user_id` would scope every row to whoever last
-- deployed.
--
-- `current_setting(..., true)` returns NULL when a setting is absent, and
-- `org_id = NULL` is NULL rather than true — so a caller arriving without org
-- context sees **nothing**. Fail-closed, deliberately.
--
-- The `app.rls_admin` branch is required by the platform contract: Studio and
-- support use a separate RLS-bypass read path that sets that setting, and a
-- table without this branch is invisible there. It cannot be forged from an app
-- token — `rls_admin` is a reserved setting Gate refuses to accept through
-- caller-supplied `rlsContext`.
--
-- RLS is ENABLE, not FORCE: FORCE would apply these policies to the table owner
-- too, and the owner is the role that runs migrations and platform checkpoints.
-- If Gate's manifest validation asks for FORCE later, that is a deliberate
-- follow-up once the owner paths are known to tolerate it — not something to
-- switch on blind in the same change.
-- ---------------------------------------------------------------------------

-- The one index Gate's manifest validation asked for. The other six org tables
-- already have an index covering org_id.
CREATE INDEX document_sources_org_idx ON public.document_sources (org_id);

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY clients_org_isolation ON public.clients
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              OR current_setting('app.rls_admin', true) = 'true');

-- ---------------------------------------------------------------------------
-- client_groups
-- ---------------------------------------------------------------------------
ALTER TABLE public.client_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_groups_org_isolation ON public.client_groups
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              OR current_setting('app.rls_admin', true) = 'true');

-- ---------------------------------------------------------------------------
-- portals
-- ---------------------------------------------------------------------------
ALTER TABLE public.portals ENABLE ROW LEVEL SECURITY;

CREATE POLICY portals_org_isolation ON public.portals
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              OR current_setting('app.rls_admin', true) = 'true');

-- ---------------------------------------------------------------------------
-- document_sources
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_sources_org_isolation ON public.document_sources
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              OR current_setting('app.rls_admin', true) = 'true');

-- ---------------------------------------------------------------------------
-- system_alerts
-- ---------------------------------------------------------------------------
ALTER TABLE public.system_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY system_alerts_org_isolation ON public.system_alerts
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              OR current_setting('app.rls_admin', true) = 'true');

-- ---------------------------------------------------------------------------
-- audit_logs
--
-- Append-only in practice: nothing updates or deletes an audit row, and a
-- policy that permitted it would be the wrong signal to whoever reads this next.
-- Split into two policies so that intent is enforced rather than commented.
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_org_read ON public.audit_logs
  FOR SELECT
  USING (org_id = current_setting('app.org_id', true)
         OR current_setting('app.rls_admin', true) = 'true');

CREATE POLICY audit_logs_org_append ON public.audit_logs
  FOR INSERT
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---------------------------------------------------------------------------
-- app_settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_settings_org_isolation ON public.app_settings
  FOR ALL
  USING (org_id = current_setting('app.org_id', true)
         OR current_setting('app.rls_admin', true) = 'true')
  WITH CHECK (org_id = current_setting('app.org_id', true)
              OR current_setting('app.rls_admin', true) = 'true');
