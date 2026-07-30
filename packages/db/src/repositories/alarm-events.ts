import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import type { TenantTransaction } from '../tenant.js';

/**
 * Alarm event persistence.
 *
 * Ingestion is idempotent against (vendor, vendor_event_id) via ON CONFLICT DO NOTHING.
 * The return value matters as much as the write: `RETURNING internal_id` yields zero
 * rows on a duplicate, which is what lets the caller gate fan-out on ACTUAL INSERTION.
 * Without that gate a vendor redelivering one event fifty times would push fifty
 * dashboard notifications and enqueue fifty media fetches while correctly writing a
 * single row.
 */
export interface InsertAlarmEventResult {
  readonly inserted: boolean;
  readonly internalId: string;
}

export async function insertAlarmEvent(
  tx: TenantTransaction,
  event: NormalizedAlarmEvent,
): Promise<InsertAlarmEventResult> {
  const result = await tx.query<{ internal_id: string }>(
    `INSERT INTO alarm_events (
       internal_id, org_id, client_id, site_id, vendor, vendor_event_id, vendor_event_code,
       event_type, severity, occurred_at, received_at, raw_payload, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (vendor, vendor_event_id) DO NOTHING
     RETURNING internal_id`,
    [
      event.internal_id,
      event.org_id,
      event.client_id,
      event.site_id,
      event.vendor,
      event.vendor_event_id,
      event.vendor_event_code,
      event.event_type,
      event.severity,
      event.occurred_at,
      event.received_at,
      JSON.stringify(event.raw_payload),
      event.correlation_id,
    ],
  );

  return { inserted: result.rowCount === 1, internalId: event.internal_id };
}

export interface AlarmEventRow {
  readonly internal_id: string;
  readonly org_id: string;
  readonly client_id: string;
  readonly site_id: string;
  readonly vendor: string;
  readonly vendor_event_id: string;
  readonly event_type: string;
  readonly severity: string;
  readonly occurred_at: Date;
  readonly closed_at: Date | null;
}

/** Dashboard access path: served by the (org_id, site_id, occurred_at DESC) index. */
export async function listRecentEventsForSite(
  tx: TenantTransaction,
  siteId: string,
  limit: number,
): Promise<readonly AlarmEventRow[]> {
  const result = await tx.query<AlarmEventRow>(
    `SELECT internal_id, org_id, client_id, site_id, vendor, vendor_event_id,
            event_type, severity, occurred_at, closed_at
       FROM alarm_events
      WHERE site_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2`,
    [siteId, limit],
  );
  return result.rows;
}

/** Served by the partial index on (org_id, site_id, occurred_at DESC) WHERE closed_at IS NULL. */
export async function listOpenEvents(
  tx: TenantTransaction,
  limit: number,
): Promise<readonly AlarmEventRow[]> {
  const result = await tx.query<AlarmEventRow>(
    `SELECT internal_id, org_id, client_id, site_id, vendor, vendor_event_id,
            event_type, severity, occurred_at, closed_at
       FROM alarm_events
      WHERE closed_at IS NULL
      ORDER BY occurred_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function countAlarmEvents(tx: TenantTransaction): Promise<number> {
  const result = await tx.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM alarm_events',
  );
  return Number(result.rows[0]?.count ?? '0');
}
