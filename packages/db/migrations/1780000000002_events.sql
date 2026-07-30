-- Up Migration
--
-- Append-only event tables. Attendance, patrol scans and alarm closures are immutable
-- events, never mutable rows: under last-write-wins state, two devices reporting
-- near-simultaneously silently destroy attendance history, and in a security product
-- where auditability is the sellable feature that is a product defect, not a
-- data-quality nit (architecture section 11.3).
--
-- client_event_id is a UUID minted ON THE DEVICE when the event is written locally.
-- It is what makes offline sync idempotent: the phone loses the response to a sync
-- POST, retries, and the second insert conflicts harmlessly. Without a device-generated
-- id there is no way to distinguish a retry from a genuine second scan at the same
-- checkpoint.

CREATE TABLE shift_attendance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations (id),
  client_id          uuid NOT NULL,
  site_id            uuid NOT NULL,
  guard_id           uuid NOT NULL,
  device_id          text NOT NULL,
  client_event_id    uuid NOT NULL,
  event_type         text NOT NULL CHECK (event_type IN ('sign_in', 'sign_out')),
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  gps_latitude       double precision,
  gps_longitude      double precision,
  -- Geofence failures are FLAGGED, never dropped (brief section 3).
  geofence_violation boolean NOT NULL DEFAULT false,
  geofence_distance_m double precision,
  -- Component B similarity score only. Never an image, never an embedding.
  face_match_score   double precision CHECK (face_match_score BETWEEN 0 AND 1),
  correlation_id     text NOT NULL,
  CONSTRAINT shift_attendance_device_event_key UNIQUE (device_id, client_event_id),
  CONSTRAINT shift_attendance_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT shift_attendance_site_fk
    FOREIGN KEY (org_id, site_id) REFERENCES sites (org_id, id),
  CONSTRAINT shift_attendance_guard_fk
    FOREIGN KEY (org_id, guard_id) REFERENCES guards (org_id, id)
);
CREATE INDEX shift_attendance_site_time_idx
  ON shift_attendance (org_id, site_id, occurred_at DESC);
CREATE INDEX shift_attendance_guard_time_idx
  ON shift_attendance (org_id, guard_id, occurred_at DESC);
CREATE INDEX shift_attendance_client_time_idx
  ON shift_attendance (org_id, client_id, occurred_at);

CREATE TABLE patrol_checkpoints (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id),
  client_id  uuid NOT NULL,
  site_id    uuid NOT NULL,
  label      text NOT NULL,
  nfc_tag_id text,
  qr_code    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patrol_checkpoints_org_id_key UNIQUE (org_id, id),
  CONSTRAINT patrol_checkpoints_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT patrol_checkpoints_site_fk
    FOREIGN KEY (org_id, site_id) REFERENCES sites (org_id, id),
  CONSTRAINT patrol_checkpoints_needs_identifier
    CHECK (nfc_tag_id IS NOT NULL OR qr_code IS NOT NULL)
);
CREATE INDEX patrol_checkpoints_site_idx ON patrol_checkpoints (org_id, site_id);

CREATE TABLE patrol_scans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations (id),
  client_id       uuid NOT NULL,
  site_id         uuid NOT NULL,
  checkpoint_id   uuid NOT NULL,
  guard_id        uuid NOT NULL,
  device_id       text NOT NULL,
  client_event_id uuid NOT NULL,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  gps_latitude    double precision,
  gps_longitude   double precision,
  scan_method     text NOT NULL CHECK (scan_method IN ('nfc', 'qr')),
  correlation_id  text NOT NULL,
  CONSTRAINT patrol_scans_device_event_key UNIQUE (device_id, client_event_id),
  CONSTRAINT patrol_scans_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT patrol_scans_site_fk FOREIGN KEY (org_id, site_id) REFERENCES sites (org_id, id),
  CONSTRAINT patrol_scans_checkpoint_fk
    FOREIGN KEY (org_id, checkpoint_id) REFERENCES patrol_checkpoints (org_id, id),
  CONSTRAINT patrol_scans_guard_fk FOREIGN KEY (org_id, guard_id) REFERENCES guards (org_id, id)
);
CREATE INDEX patrol_scans_site_time_idx ON patrol_scans (org_id, site_id, occurred_at DESC);
CREATE INDEX patrol_scans_client_time_idx ON patrol_scans (org_id, client_id, occurred_at);
CREATE INDEX patrol_scans_checkpoint_time_idx
  ON patrol_scans (org_id, checkpoint_id, occurred_at DESC);

CREATE TABLE alarm_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations (id),
  client_id    uuid NOT NULL,
  site_id      uuid NOT NULL,
  vendor       text NOT NULL CHECK (vendor IN ('guardtek', 'dahua', 'axxon')),
  external_ref text NOT NULL,
  -- Opaque, vendor-defined resume point. Persisted so polling survives redeploys
  -- instead of re-fetching all history or losing its place (architecture section 6.3).
  poll_cursor  text,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alarm_sources_org_id_key UNIQUE (org_id, id),
  CONSTRAINT alarm_sources_vendor_ref_key UNIQUE (vendor, external_ref),
  CONSTRAINT alarm_sources_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT alarm_sources_site_fk FOREIGN KEY (org_id, site_id) REFERENCES sites (org_id, id)
);
CREATE INDEX alarm_sources_org_vendor_idx ON alarm_sources (org_id, vendor) WHERE enabled;

CREATE TABLE alarm_events (
  internal_id       uuid PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES organizations (id),
  client_id         uuid NOT NULL,
  site_id           uuid NOT NULL,
  vendor            text NOT NULL CHECK (vendor IN ('guardtek', 'dahua', 'axxon')),
  vendor_event_id   text NOT NULL,
  -- Retained so the unmapped-code alert can name the code a supervisor must map.
  vendor_event_code text,
  event_type        text NOT NULL CHECK (event_type IN (
                      'intrusion', 'motion', 'door_forced', 'door_open',
                      'fire', 'panic', 'tamper', 'connection_loss', 'unknown')),
  severity          text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- The audit artifact and adapter debugging source. NEVER dropped.
  raw_payload       jsonb NOT NULL,
  correlation_id    text NOT NULL,
  -- DERIVED from alarm_closures to serve the partial index below. Never the source
  -- of truth: the closure log is (architecture section 11.3).
  closed_at         timestamptz,
  -- The idempotency key. Deliberately excludes org_id and client_id: vendor event ids
  -- are unique per vendor, and including a tenant column would let a tenant-resolution
  -- bug insert the same vendor event twice under two tenants — the exact bug this
  -- constraint exists to catch.
  CONSTRAINT alarm_events_vendor_event_key UNIQUE (vendor, vendor_event_id),
  CONSTRAINT alarm_events_org_id_key UNIQUE (org_id, internal_id),
  CONSTRAINT alarm_events_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT alarm_events_site_fk FOREIGN KEY (org_id, site_id) REFERENCES sites (org_id, id)
);
CREATE INDEX alarm_events_site_time_idx ON alarm_events (org_id, site_id, occurred_at DESC);
CREATE INDEX alarm_events_client_time_idx ON alarm_events (org_id, client_id, occurred_at);
-- Partial: open alarms are a tiny fraction of a table that grows without bound, but
-- they are the hottest dashboard query. The index stays small and fully cached.
CREATE INDEX alarm_events_open_idx
  ON alarm_events (org_id, site_id, occurred_at DESC) WHERE closed_at IS NULL;
-- No GIN index on raw_payload: it is an audit artifact, not an operational query
-- target, and GIN on a column written on every ingestion adds material write
-- amplification to the hottest write path to serve queries we do not make.

CREATE TABLE alarm_closures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations (id),
  client_id         uuid NOT NULL,
  alarm_event_id    uuid NOT NULL,
  guard_id          uuid,
  closed_by_user_id uuid,
  device_id         text,
  client_event_id   uuid,
  notes             text,
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  correlation_id    text NOT NULL,
  CONSTRAINT alarm_closures_event_fk
    FOREIGN KEY (org_id, alarm_event_id) REFERENCES alarm_events (org_id, internal_id),
  CONSTRAINT alarm_closures_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT alarm_closures_guard_fk FOREIGN KEY (org_id, guard_id) REFERENCES guards (org_id, id),
  CONSTRAINT alarm_closures_user_fk
    FOREIGN KEY (org_id, closed_by_user_id) REFERENCES users (org_id, id),
  CONSTRAINT alarm_closures_needs_actor
    CHECK (guard_id IS NOT NULL OR closed_by_user_id IS NOT NULL),
  -- A device-originated closure carries both device fields or neither.
  CONSTRAINT alarm_closures_device_pair
    CHECK ((device_id IS NULL) = (client_event_id IS NULL))
);
CREATE UNIQUE INDEX alarm_closures_device_event_idx
  ON alarm_closures (device_id, client_event_id) WHERE device_id IS NOT NULL;
CREATE INDEX alarm_closures_event_idx ON alarm_closures (org_id, alarm_event_id);

CREATE TABLE incident_media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations (id),
  client_id      uuid NOT NULL,
  alarm_event_id uuid NOT NULL,
  source_url     text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('image', 'video', 'unknown')),
  -- The R2 object key. The bytes live in R2 and never in PostgreSQL.
  r2_object_key  text,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'stored', 'failed')),
  error_detail   jsonb,
  -- Vendor-stated expiry, when stated. Drives fetch prioritisation: a bare URL loses
  -- the deadline, so the pipeline cannot prioritise the one expiring in 60 seconds.
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_media_event_fk
    FOREIGN KEY (org_id, alarm_event_id) REFERENCES alarm_events (org_id, internal_id),
  CONSTRAINT incident_media_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT incident_media_stored_has_key
    CHECK (status <> 'stored' OR r2_object_key IS NOT NULL)
);
CREATE INDEX incident_media_event_idx ON incident_media (org_id, alarm_event_id);
CREATE INDEX incident_media_pending_idx
  ON incident_media (expires_at NULLS LAST) WHERE status = 'pending';

-- Down Migration
DROP TABLE incident_media;
DROP TABLE alarm_closures;
DROP TABLE alarm_events;
DROP TABLE alarm_sources;
DROP TABLE patrol_scans;
DROP TABLE patrol_checkpoints;
DROP TABLE shift_attendance;
