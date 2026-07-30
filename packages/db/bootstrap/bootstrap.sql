-- DeepSight database bootstrap — environment provisioning, run ONCE per database.
--
-- This is the only script requiring superuser, because only a superuser can CREATE ROLE.
-- It is deliberately NOT a migration: migrations run as deepsight_owner, which this
-- script creates. Running migrations as a superuser would defeat acceptance test A4,
-- because a superuser bypasses row-level security unconditionally — including FORCE RLS.
--
-- Role separation (architecture section 7.1):
--   deepsight_owner    owns the tables; used by migrations ONLY. Non-superuser, and
--                      critically NOT BYPASSRLS, so FORCE ROW LEVEL SECURITY applies
--                      to it and isolation can be asserted against the owner itself.
--   deepsight_app      every application query path. Owns nothing.
--   deepsight_readonly ad-hoc investigation.
--
-- Passwords here are placeholders for local/CI use. In every deployed environment
-- they come from Railway environment variables and are never committed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deepsight_owner') THEN
    CREATE ROLE deepsight_owner LOGIN PASSWORD 'owner_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deepsight_app') THEN
    CREATE ROLE deepsight_app LOGIN PASSWORD 'app_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deepsight_readonly') THEN
    CREATE ROLE deepsight_readonly LOGIN PASSWORD 'readonly_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- PostgreSQL 15+ no longer grants CREATE on the public schema to PUBLIC.
GRANT CREATE, USAGE ON SCHEMA public TO deepsight_owner;
GRANT USAGE ON SCHEMA public TO deepsight_app, deepsight_readonly;

-- Default privileges so tables created later by the owner are automatically usable
-- by the application role. Declared once here rather than repeated per migration,
-- which is how a table ends up silently unreadable by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE deepsight_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO deepsight_app;
ALTER DEFAULT PRIVILEGES FOR ROLE deepsight_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO deepsight_app;
ALTER DEFAULT PRIVILEGES FOR ROLE deepsight_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO deepsight_readonly;

-- Idempotent catch-up for anything created before the defaults were set.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO deepsight_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO deepsight_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO deepsight_readonly;
