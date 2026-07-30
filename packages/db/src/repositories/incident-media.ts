import type { TenantTransaction } from '../tenant.js';

/**
 * Incident media persistence — the ROW, never the bytes.
 *
 * `incident_media` records where an object lives in R2 (`r2_object_key`) and its lifecycle
 * status; the media itself is streamed to R2 and never touches PostgreSQL (the binary-column
 * rule, enforced by migration-lint). A row is born `pending` at ingestion, then the media
 * worker moves it to `stored` with a key or to `failed` with a structured reason. The
 * `stored` state is guarded by a CHECK constraint requiring the key, so a "stored" row with
 * no object is impossible at the schema level, not merely by convention.
 */

export interface MediaRefInput {
  readonly source_url: string;
  readonly kind: 'image' | 'video' | 'unknown';
  /** Vendor-stated expiry, or null. Drives fetch prioritisation (sooner expiry first). */
  readonly expires_at: Date | null;
}

export interface PendingMediaRow {
  readonly id: string;
  readonly source_url: string;
  readonly kind: string;
  readonly expires_at: Date | null;
}

/**
 * Inserts one pending row per media reference for a freshly persisted alarm event, returning
 * the rows (with their generated ids) in the SAME ORDER as the input.
 *
 * Called only after the parent alarm event actually inserted — the same gate that keeps
 * fan-out from firing on a duplicate keeps a redelivered event from spawning duplicate media
 * rows. An empty `refs` yields no rows and no query.
 */
export async function insertPendingMedia(
  tx: TenantTransaction,
  params: {
    readonly orgId: string;
    readonly clientId: string;
    readonly alarmEventId: string;
    readonly refs: readonly MediaRefInput[];
  },
): Promise<readonly PendingMediaRow[]> {
  if (params.refs.length === 0) return [];

  // One multi-row INSERT rather than N round trips. Ordinality is preserved by unnest'ing
  // parallel arrays, so the returned ids line up with the input refs for job enqueue.
  const result = await tx.query<PendingMediaRow>(
    `INSERT INTO incident_media (org_id, client_id, alarm_event_id, source_url, kind, expires_at)
     SELECT $1, $2, $3, u.source_url, u.kind, u.expires_at
       FROM unnest($4::text[], $5::text[], $6::timestamptz[])
         WITH ORDINALITY AS u(source_url, kind, expires_at, ord)
      ORDER BY u.ord
     RETURNING id, source_url, kind, expires_at`,
    [
      params.orgId,
      params.clientId,
      params.alarmEventId,
      params.refs.map((r) => r.source_url),
      params.refs.map((r) => r.kind),
      params.refs.map((r) => r.expires_at),
    ],
  );
  return result.rows;
}

/** Moves a row to `stored`, recording the R2 object key. */
export async function markMediaStored(
  tx: TenantTransaction,
  mediaId: string,
  r2ObjectKey: string,
): Promise<void> {
  await tx.query(
    `UPDATE incident_media
        SET status = 'stored', r2_object_key = $2, error_detail = NULL
      WHERE id = $1`,
    [mediaId, r2ObjectKey],
  );
}

/** Moves a row to `failed`, recording a structured reason for investigation. */
export async function markMediaFailed(
  tx: TenantTransaction,
  mediaId: string,
  errorDetail: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `UPDATE incident_media
        SET status = 'failed', error_detail = $2::jsonb
      WHERE id = $1`,
    [mediaId, JSON.stringify(errorDetail)],
  );
}

export interface IncidentMediaRow {
  readonly id: string;
  readonly org_id: string;
  readonly client_id: string;
  readonly alarm_event_id: string;
  readonly source_url: string;
  readonly kind: string;
  readonly r2_object_key: string | null;
  readonly status: string;
  readonly error_detail: unknown;
  readonly expires_at: Date | null;
}

export async function getIncidentMedia(
  tx: TenantTransaction,
  mediaId: string,
): Promise<IncidentMediaRow | null> {
  const result = await tx.query<IncidentMediaRow>(
    `SELECT id, org_id, client_id, alarm_event_id, source_url, kind,
            r2_object_key, status, error_detail, expires_at
       FROM incident_media
      WHERE id = $1`,
    [mediaId],
  );
  return result.rows[0] ?? null;
}

/**
 * Pending media ordered by expiry deadline (soonest first, NULLs last) — served by the
 * partial index `incident_media_pending_idx`. This is the recovery/backfill query for media
 * that was enqueued but whose job was lost; the live path prioritises via the queue itself.
 */
export async function listPendingMediaByExpiry(
  tx: TenantTransaction,
  limit: number,
): Promise<readonly IncidentMediaRow[]> {
  const result = await tx.query<IncidentMediaRow>(
    `SELECT id, org_id, client_id, alarm_event_id, source_url, kind,
            r2_object_key, status, error_detail, expires_at
       FROM incident_media
      WHERE status = 'pending'
      ORDER BY expires_at ASC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}
