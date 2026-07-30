-- Up Migration
--
-- Row-level security. Read all three notes before changing any policy below.
--
-- NOTE 1 — PostgreSQL evaluates access as:
--     (OR of PERMISSIVE policies) AND (AND of RESTRICTIVE policies)
--   An empty PERMISSIVE set makes that expression FALSE, so a table carrying ONLY
--   restrictive policies returns ZERO rows — a total blackout, not isolation. Verified
--   experimentally against PostgreSQL 16 before writing this migration. Hence:
--     org_isolation    PERMISSIVE, and the ONLY permissive policy on every table.
--     client_narrowing RESTRICTIVE, therefore AND-ed on top.
--
-- NOTE 2 — a transaction-local GUC does NOT revert to NULL.
--   set_config('app.current_org_id', ..., true) reverts on COMMIT/ROLLBACK to the custom
--   GUC's previous value, which for a never-session-set custom GUC is the EMPTY STRING,
--   not NULL. Verified experimentally. So a pooled connection that has served one tenant
--   query and is then reused without a GUC sees '', and `''::uuid` RAISES
--   "invalid input syntax for type uuid" rather than yielding NULL.
--
--   That is why every policy goes through app_current_org() / app_current_client(),
--   which NULLIF the empty string away. Without them an untenanted query on a recycled
--   connection produces a runtime error instead of an empty result — and routing through
--   helpers means the fix cannot be forgotten on one table out of fifteen.
--
-- NOTE 3 — FORCE ROW LEVEL SECURITY is applied to every table, because by default the
--   table OWNER bypasses policies entirely. Developers test isolation while connected as
--   the owner, see policies "working" because they happen to filter correctly, and never
--   notice the bypass. Acceptance test A4 asserts this against the owner directly.
--
-- Net effect: a missing tenant GUC yields zero rows and rejects every write. Fail closed.

CREATE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  -- SECURITY INVOKER (the default) on purpose: it must read the CALLER's GUC.
  AS $fn$ SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid $fn$;

COMMENT ON FUNCTION app_current_org() IS
  'Current tenant org id from the app.current_org_id GUC, or NULL when unset. The NULLIF '
  'handles the empty string a transaction-local GUC reverts to, which would otherwise '
  'raise on the ::uuid cast.';

CREATE FUNCTION app_current_client() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  AS $fn$ SELECT NULLIF(current_setting('app.current_client_id', true), '')::uuid $fn$;

COMMENT ON FUNCTION app_current_client() IS
  'Optional client narrowing from the app.current_client_id GUC, or NULL when unset.';

GRANT EXECUTE ON FUNCTION app_current_org() TO deepsight_app, deepsight_readonly;
GRANT EXECUTE ON FUNCTION app_current_client() TO deepsight_app, deepsight_readonly;

DO $do$
DECLARE
  t text;
  -- Tables isolated by org_id.
  tenant_tables text[] := ARRAY[
    'clients', 'sites', 'guards', 'users', 'guard_enrollments',
    'shift_attendance', 'patrol_checkpoints', 'patrol_scans', 'alarm_sources',
    'alarm_events', 'alarm_closures', 'incident_media',
    'report_runs', 'report_delivery_log'
  ];
  -- Of those, the ones carrying client_id and therefore narrowable. `guards` and `users`
  -- are absent deliberately: a guard belongs to the operator rather than to one client,
  -- and user visibility is an RBAC concern rather than a row-filter one.
  client_scoped_tables text[] := ARRAY[
    'sites', 'guard_enrollments', 'shift_attendance', 'patrol_checkpoints',
    'patrol_scans', 'alarm_sources', 'alarm_events', 'alarm_closures',
    'incident_media', 'report_runs', 'report_delivery_log'
  ];
BEGIN
  -- organizations is the tenant root: scoped by its own id, not by an org_id column.
  EXECUTE 'ALTER TABLE organizations ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE organizations FORCE ROW LEVEL SECURITY';
  EXECUTE $fmt$
    CREATE POLICY org_isolation ON organizations AS PERMISSIVE FOR ALL
      USING      (id = app_current_org())
      WITH CHECK (id = app_current_org())
  $fmt$;

  FOREACH t IN ARRAY tenant_tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($fmt$
      CREATE POLICY org_isolation ON %I AS PERMISSIVE FOR ALL
        USING      (org_id = app_current_org())
        WITH CHECK (org_id = app_current_org())
    $fmt$, t);
  END LOOP;

  FOREACH t IN ARRAY client_scoped_tables
  LOOP
    EXECUTE format($fmt$
      CREATE POLICY client_narrowing ON %I AS RESTRICTIVE FOR ALL
        USING      (app_current_client() IS NULL OR client_id = app_current_client())
        WITH CHECK (app_current_client() IS NULL OR client_id = app_current_client())
    $fmt$, t);
  END LOOP;

  -- `clients` narrows on its own primary key rather than on a client_id column.
  EXECUTE $fmt$
    CREATE POLICY client_narrowing ON clients AS RESTRICTIVE FOR ALL
      USING      (app_current_client() IS NULL OR id = app_current_client())
      WITH CHECK (app_current_client() IS NULL OR id = app_current_client())
  $fmt$;
END
$do$;

-- Down Migration
DO $do$
DECLARE
  t text;
  all_tables text[] := ARRAY[
    'organizations', 'clients', 'sites', 'guards', 'users', 'guard_enrollments',
    'shift_attendance', 'patrol_checkpoints', 'patrol_scans', 'alarm_sources',
    'alarm_events', 'alarm_closures', 'incident_media',
    'report_runs', 'report_delivery_log'
  ];
BEGIN
  FOREACH t IN ARRAY all_tables
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS client_narrowing ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$do$;

DROP FUNCTION IF EXISTS app_current_client();
DROP FUNCTION IF EXISTS app_current_org();
