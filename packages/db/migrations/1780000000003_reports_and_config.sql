-- Up Migration
--
-- report_runs and report_delivery_log are deliberately separate tables. A failed
-- email delivery must never obscure a successful compilation, so a report run's
-- outcome and each individual delivery attempt are recorded independently
-- (brief section 3, "Report Compilation").

CREATE TABLE report_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations (id),
  client_id      uuid NOT NULL,
  period_start   timestamptz NOT NULL,
  period_end     timestamptz NOT NULL,
  status         text NOT NULL CHECK (status IN (
                   'pending', 'running', 'complete', 'partial', 'stale_data', 'failed')),
  -- Structured error detail on EVERY outcome, not just failures — a partial report
  -- needs to say which source was incomplete and why.
  error_detail   jsonb,
  r2_object_key  text,
  started_at     timestamptz,
  completed_at   timestamptz,
  correlation_id text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_runs_org_id_key UNIQUE (org_id, id),
  CONSTRAINT report_runs_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT report_runs_period_ordered CHECK (period_end > period_start)
);
CREATE INDEX report_runs_client_period_idx
  ON report_runs (org_id, client_id, period_start DESC);
-- Not tenant-scoped: this is DeepSight's own cross-operator queue-health view.
CREATE INDEX report_runs_status_idx ON report_runs (status, created_at);

CREATE TABLE report_delivery_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations (id),
  client_id       uuid NOT NULL,
  report_run_id   uuid NOT NULL,
  recipient_email text NOT NULL,
  delivered_at    timestamptz,
  delivery_status text NOT NULL CHECK (delivery_status IN ('sent', 'failed', 'bounced')),
  error_detail    jsonb,
  r2_archive_key  text,
  correlation_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_delivery_log_run_fk
    FOREIGN KEY (org_id, report_run_id) REFERENCES report_runs (org_id, id),
  CONSTRAINT report_delivery_log_client_fk
    FOREIGN KEY (org_id, client_id) REFERENCES clients (org_id, id),
  CONSTRAINT report_delivery_log_sent_has_timestamp
    CHECK (delivery_status <> 'sent' OR delivered_at IS NOT NULL)
);
-- One row per ATTEMPT, append-only: a retry adds a row, it never updates the first.
CREATE INDEX report_delivery_log_run_idx ON report_delivery_log (report_run_id);
CREATE INDEX report_delivery_log_status_idx
  ON report_delivery_log (delivery_status, created_at DESC);

-- Global configuration, NOT tenant-scoped and deliberately without RLS: the numeric
-- vendor-code to normalized-type mapping is the same for every operator. Built as a
-- table rather than hardcoded logic so new vendor codes can be added without a
-- redeploy (brief section 3, "Dahua DSS"). Registered in GLOBAL_TABLES in the
-- schema guard, which is what stops it tripping the "tenant table without RLS" rule.
CREATE TABLE alarm_event_type_mappings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor            text NOT NULL CHECK (vendor IN ('guardtek', 'dahua', 'axxon')),
  vendor_code       text NOT NULL,
  normalized_type   text NOT NULL CHECK (normalized_type IN (
                      'intrusion', 'motion', 'door_forced', 'door_open',
                      'fire', 'panic', 'tamper', 'connection_loss', 'unknown')),
  severity_override text CHECK (severity_override IN ('low', 'medium', 'high', 'critical')),
  description       text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alarm_event_type_mappings_vendor_code_key UNIQUE (vendor, vendor_code)
);

-- Down Migration
DROP TABLE alarm_event_type_mappings;
DROP TABLE report_delivery_log;
DROP TABLE report_runs;
