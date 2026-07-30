import type { TenantTransaction } from '../tenant.js';

/**
 * Guard mobile sync persistence: the append-only event tables the device pushes into.
 *
 * Every insert is idempotent on `(device_id, client_event_id)` — the id the DEVICE mints when it
 * writes the event locally, offline. That is what makes sync safe to retry: the phone loses the
 * response to a push, retries, and the second insert conflicts harmlessly (ON CONFLICT DO
 * NOTHING). The return value distinguishes a real insert from a duplicate, so the endpoint can
 * report exact counts. Nothing here updates or deletes — these are events, not mutable rows.
 */

export interface AttendanceInput {
  readonly clientEventId: string;
  readonly siteId: string;
  readonly clientId: string;
  readonly eventType: 'sign_in' | 'sign_out';
  readonly occurredAt: Date;
  readonly gpsLatitude: number | null;
  readonly gpsLongitude: number | null;
  readonly geofenceViolation: boolean;
  readonly geofenceDistanceM: number | null;
  readonly correlationId: string;
}

export async function insertAttendanceEvent(
  tx: TenantTransaction,
  params: { readonly orgId: string; readonly guardId: string; readonly deviceId: string } & {
    readonly event: AttendanceInput;
  },
): Promise<boolean> {
  const e = params.event;
  const result = await tx.query(
    `INSERT INTO shift_attendance
       (org_id, client_id, site_id, guard_id, device_id, client_event_id, event_type,
        occurred_at, gps_latitude, gps_longitude, geofence_violation, geofence_distance_m,
        correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (device_id, client_event_id) DO NOTHING`,
    [
      params.orgId,
      e.clientId,
      e.siteId,
      params.guardId,
      params.deviceId,
      e.clientEventId,
      e.eventType,
      e.occurredAt,
      e.gpsLatitude,
      e.gpsLongitude,
      e.geofenceViolation,
      e.geofenceDistanceM,
      e.correlationId,
    ],
  );
  return result.rowCount === 1;
}

export interface PatrolInput {
  readonly clientEventId: string;
  readonly siteId: string;
  readonly clientId: string;
  readonly checkpointId: string;
  readonly occurredAt: Date;
  readonly scanMethod: 'nfc' | 'qr';
  readonly gpsLatitude: number | null;
  readonly gpsLongitude: number | null;
  readonly correlationId: string;
}

export async function insertPatrolScan(
  tx: TenantTransaction,
  params: { readonly orgId: string; readonly guardId: string; readonly deviceId: string } & {
    readonly event: PatrolInput;
  },
): Promise<boolean> {
  const e = params.event;
  const result = await tx.query(
    `INSERT INTO patrol_scans
       (org_id, client_id, site_id, checkpoint_id, guard_id, device_id, client_event_id,
        occurred_at, gps_latitude, gps_longitude, scan_method, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (device_id, client_event_id) DO NOTHING`,
    [
      params.orgId,
      e.clientId,
      e.siteId,
      e.checkpointId,
      params.guardId,
      params.deviceId,
      e.clientEventId,
      e.occurredAt,
      e.gpsLatitude,
      e.gpsLongitude,
      e.scanMethod,
      e.correlationId,
    ],
  );
  return result.rowCount === 1;
}

export interface ClosureInput {
  readonly clientEventId: string;
  readonly alarmEventId: string;
  readonly clientId: string;
  readonly occurredAt: Date;
  readonly notes: string | null;
  readonly correlationId: string;
}

export async function insertAlarmClosure(
  tx: TenantTransaction,
  params: { readonly orgId: string; readonly guardId: string; readonly deviceId: string } & {
    readonly event: ClosureInput;
  },
): Promise<boolean> {
  const e = params.event;
  // The device-originated closure carries both device fields (the alarm_closures_device_pair
  // CHECK requires both or neither). Idempotency is the partial unique index on those two.
  const result = await tx.query(
    `INSERT INTO alarm_closures
       (org_id, client_id, alarm_event_id, guard_id, device_id, client_event_id,
        notes, occurred_at, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (device_id, client_event_id) WHERE device_id IS NOT NULL DO NOTHING`,
    [
      params.orgId,
      e.clientId,
      e.alarmEventId,
      params.guardId,
      params.deviceId,
      e.clientEventId,
      e.notes,
      e.occurredAt,
      e.correlationId,
    ],
  );
  return result.rowCount === 1;
}

/** Loads a site's geofence parameters so the server can compute violations authoritatively. */
export interface SiteGeofence {
  readonly client_id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly geofence_radius_m: number;
}

export async function findSiteGeofence(
  tx: TenantTransaction,
  siteId: string,
): Promise<SiteGeofence | null> {
  const result = await tx.query<SiteGeofence>(
    `SELECT client_id, latitude, longitude, geofence_radius_m FROM sites WHERE id = $1`,
    [siteId],
  );
  return result.rows[0] ?? null;
}
