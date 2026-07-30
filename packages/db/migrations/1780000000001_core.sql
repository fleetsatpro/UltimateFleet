-- Up Migration
--
-- Core tenancy structure. Under divergence D6 the isolation key is org_id, with
-- client_id as a scoping dimension beneath it: organizations -> clients -> sites.
-- A single-operator deployment is the degenerate case (one organizations row).
--
-- Every tenant table carries UNIQUE (org_id, id) and every tenant foreign key is
-- COMPOSITE on (org_id, <fk>). That is not redundancy. PostgreSQL evaluates foreign
-- key checks with row-level security bypassed, so a plain FK to clients(id) would
-- happily let one organization's site reference another organization's client — RLS
-- would never see it. The composite FK makes cross-tenant references structurally
-- impossible rather than merely filtered.

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations (id),
  name          text NOT NULL,
  contact_email text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clients_org_id_key UNIQUE (org_id, id),
  CONSTRAINT clients_org_name_key UNIQUE (org_id, name)
);

CREATE TABLE sites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations (id),
  client_id         uuid NOT NULL,
  name              text NOT NULL,
  latitude          double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude         double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  geofence_radius_m integer NOT NULL DEFAULT 100 CHECK (geofence_radius_m > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sites_org_id_key UNIQUE (org_id, id),
  CONSTRAINT sites_client_fk FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id)
);
CREATE INDEX sites_org_client_idx ON sites (org_id, client_id, name);

CREATE TABLE guards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations (id),
  full_name     text NOT NULL,
  employee_code text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guards_org_id_key UNIQUE (org_id, id),
  CONSTRAINT guards_org_employee_code_key UNIQUE (org_id, employee_code)
);
-- Deliberately NOT client-scoped: a guard belongs to the operator and may work any
-- of its clients' sites, so the client-narrowing policy does not apply here.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations (id),
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'supervisor', 'report_viewer')),
  -- Non-null only for report_viewer, whose queries run under withOrgClient().
  client_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_org_id_key UNIQUE (org_id, id),
  CONSTRAINT users_report_viewer_needs_client
    CHECK (role <> 'report_viewer' OR client_id IS NOT NULL),
  CONSTRAINT users_client_fk FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id)
);
-- Login identity is global, so the uniqueness must be too: two organizations cannot
-- both own the same email or authentication becomes ambiguous.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_org_role_idx ON users (org_id, role);

CREATE TABLE guard_enrollments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations (id),
  client_id        uuid NOT NULL,
  guard_id         uuid NOT NULL,
  device_id        text NOT NULL,
  -- The ONLY binary column permitted in the system (divergence D5): a fixed-size,
  -- non-reversible face embedding, ~2 KB. Nullable so right-to-erasure is a column
  -- update rather than a row delete, which is what lets erasure and a permanent
  -- audit trail coexist (architecture section 11.4). No raw face image, ever.
  embedding_vector bytea,
  face_match_sdk   text,
  sdk_version      text,
  enrolled_at      timestamptz NOT NULL DEFAULT now(),
  enrolled_by      uuid NOT NULL,
  revoked_at       timestamptz,
  erased_at        timestamptz,
  CONSTRAINT guard_enrollments_org_id_key UNIQUE (org_id, id),
  CONSTRAINT guard_enrollments_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT guard_enrollments_guard_fk
    FOREIGN KEY (org_id, guard_id) REFERENCES guards (org_id, id),
  CONSTRAINT guard_enrollments_enrolled_by_fk
    FOREIGN KEY (org_id, enrolled_by) REFERENCES users (org_id, id),
  -- An erased embedding must actually be gone.
  CONSTRAINT guard_enrollments_erased_implies_null
    CHECK (erased_at IS NULL OR embedding_vector IS NULL)
);

-- At most one ACTIVE enrollment per guard, and one active guard per device. Enforced
-- in the database rather than in application code, because an application-level check
-- races: two supervisors enrolling simultaneously would both pass a SELECT-then-INSERT.
CREATE UNIQUE INDEX guard_enrollments_active_guard_idx
  ON guard_enrollments (guard_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX guard_enrollments_active_device_idx
  ON guard_enrollments (device_id) WHERE revoked_at IS NULL;
CREATE INDEX guard_enrollments_org_guard_idx ON guard_enrollments (org_id, guard_id);

-- Down Migration
DROP TABLE guard_enrollments;
DROP TABLE users;
DROP TABLE guards;
DROP TABLE sites;
DROP TABLE clients;
DROP TABLE organizations;
