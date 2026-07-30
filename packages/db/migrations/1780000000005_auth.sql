-- Up Migration
--
-- Phase 7 authentication state. Three principles hold across every table here:
--
--   1. No secret is ever stored in plaintext. Enrollment tokens and refresh tokens are
--      stored ONLY as SHA-256 hashes; the plaintext is returned to the caller once, at
--      generation, and never persisted. A database leak therefore yields no usable token.
--   2. Refresh tokens rotate as FAMILIES. Every device holds a chain of single-use refresh
--      tokens sharing a family_id; presenting a consumed token (a replay) revokes the whole
--      family, forcing re-provisioning. This is the standard defence against refresh-token
--      theft, and acceptance criterion 3 asserts it.
--   3. These are tenant tables: org_id + FORCE RLS + a permissive org policy, so the schema
--      guard treats them like every other tenant table and a cross-operator leak is
--      impossible by construction.

CREATE TABLE enrollment_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations (id),
  client_id    uuid NOT NULL,
  guard_id     uuid NOT NULL,
  device_label text,
  -- SHA-256 of the single-use token. The plaintext is returned once and never stored, so a
  -- dump of this table cannot be redeemed.
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_tokens_org_id_key UNIQUE (org_id, id),
  CONSTRAINT enrollment_tokens_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT enrollment_tokens_guard_fk
    FOREIGN KEY (org_id, guard_id) REFERENCES guards (org_id, id),
  CONSTRAINT enrollment_tokens_creator_fk
    FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id)
);
-- The redemption path looks up by hash; partial index keeps only the still-redeemable rows.
CREATE INDEX enrollment_tokens_open_idx
  ON enrollment_tokens (token_hash) WHERE consumed_at IS NULL;

CREATE TABLE refresh_families (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations (id),
  client_id     uuid NOT NULL,
  guard_id      uuid NOT NULL,
  -- The device enrollment this family authenticates. Revoking the enrollment (revoked_at)
  -- must fail the next refresh — the refresh path joins to it (acceptance criterion 2).
  enrollment_id uuid NOT NULL,
  device_id     text NOT NULL,
  -- Set when a replay is detected or the enrollment is revoked; kills the whole chain.
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_families_org_id_key UNIQUE (org_id, id),
  CONSTRAINT refresh_families_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT refresh_families_guard_fk
    FOREIGN KEY (org_id, guard_id) REFERENCES guards (org_id, id),
  CONSTRAINT refresh_families_enrollment_fk
    FOREIGN KEY (org_id, enrollment_id) REFERENCES guard_enrollments (org_id, id)
);
CREATE INDEX refresh_families_enrollment_idx ON refresh_families (org_id, enrollment_id);

CREATE TABLE device_refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations (id),
  client_id   uuid NOT NULL,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- Set the moment a token is rotated. A second presentation of a consumed token is the
  -- replay that revokes the family.
  consumed_at timestamptz,
  CONSTRAINT device_refresh_tokens_org_id_key UNIQUE (org_id, id),
  CONSTRAINT device_refresh_tokens_family_fk
    FOREIGN KEY (org_id, family_id) REFERENCES refresh_families (org_id, id)
);
CREATE INDEX device_refresh_tokens_family_idx ON device_refresh_tokens (org_id, family_id);

-- RLS for the three new tenant tables: one permissive org policy (the ONLY permissive policy,
-- so the table is not a total blackout) plus a restrictive client-narrowing policy, matching
-- the pattern established in 0004 and enforced by the schema guard.
DO $do$
DECLARE
  t text;
  auth_tables text[] := ARRAY['enrollment_tokens', 'refresh_families', 'device_refresh_tokens'];
BEGIN
  FOREACH t IN ARRAY auth_tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($fmt$
      CREATE POLICY org_isolation ON %I AS PERMISSIVE FOR ALL
        USING      (org_id = app_current_org())
        WITH CHECK (org_id = app_current_org())
    $fmt$, t);
    EXECUTE format($fmt$
      CREATE POLICY client_narrowing ON %I AS RESTRICTIVE FOR ALL
        USING      (app_current_client() IS NULL OR client_id = app_current_client())
        WITH CHECK (app_current_client() IS NULL OR client_id = app_current_client())
    $fmt$, t);
  END LOOP;
END
$do$;

-- Authentication lookup by globally-unique email. Login must read a user BEFORE its org is
-- known, which the app role's RLS forbids (correctly). This SECURITY DEFINER function runs as
-- deepsight_auth (BYPASSRLS), reachable only via EXECUTE, returning exactly the login fields
-- for one email. search_path is pinned so the definer's rights cannot be hijacked.
CREATE FUNCTION auth_lookup_user(p_email text)
  RETURNS TABLE (id uuid, org_id uuid, role text, client_id uuid, password_hash text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
    SELECT id, org_id, role, client_id, password_hash
      FROM users
     WHERE lower(email) = lower(p_email)
  $fn$;
ALTER FUNCTION auth_lookup_user(text) OWNER TO deepsight_auth;
REVOKE ALL ON FUNCTION auth_lookup_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user(text) TO deepsight_app;
-- BYPASSRLS lets deepsight_auth skip the row policies, but table-level SELECT is a separate
-- grant it still needs. Narrowed to exactly the login columns, so the definer role can read
-- nothing else on users even in principle.
GRANT SELECT (id, org_id, role, client_id, password_hash, email) ON users TO deepsight_auth;

-- Down Migration
DROP FUNCTION IF EXISTS auth_lookup_user(text);
DROP TABLE device_refresh_tokens;
DROP TABLE refresh_families;
DROP TABLE enrollment_tokens;
