import type { TenantTransaction } from '../tenant.js';

/**
 * Report delivery log persistence — one row per ATTEMPT, append-only.
 *
 * A retry never updates the first row; it inserts a second. That is the whole point of an audit
 * log: "we tried, it bounced, we retried, it sent" must be reconstructable, and an in-place update
 * would erase the bounce. Delivery status is kept entirely separate from `report_runs.status`, so a
 * successful COMPILATION whose DELIVERY failed reads as `complete` + `failed`, not as a lost report.
 */
export type DeliveryStatus = 'sent' | 'failed' | 'bounced';

export async function insertDeliveryAttempt(
  tx: TenantTransaction,
  params: {
    readonly orgId: string;
    readonly clientId: string;
    readonly reportRunId: string;
    readonly recipientEmail: string;
    readonly status: DeliveryStatus;
    readonly deliveredAt: Date | null;
    readonly errorDetail: Record<string, unknown> | null;
    readonly r2ArchiveKey: string | null;
    readonly correlationId: string;
  },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO report_delivery_log
       (org_id, client_id, report_run_id, recipient_email, delivery_status,
        delivered_at, error_detail, r2_archive_key, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     RETURNING id`,
    [
      params.orgId,
      params.clientId,
      params.reportRunId,
      params.recipientEmail,
      params.status,
      params.deliveredAt,
      params.errorDetail === null ? null : JSON.stringify(params.errorDetail),
      params.r2ArchiveKey,
      params.correlationId,
    ],
  );
  return result.rows[0]!.id;
}

export interface DeliveryLogRow {
  readonly id: string;
  readonly recipient_email: string;
  readonly delivery_status: string;
  readonly delivered_at: Date | null;
  readonly r2_archive_key: string | null;
  readonly correlation_id: string;
  readonly created_at: Date;
}

export async function listDeliveryAttempts(
  tx: TenantTransaction,
  reportRunId: string,
): Promise<readonly DeliveryLogRow[]> {
  const result = await tx.query<DeliveryLogRow>(
    `SELECT id, recipient_email, delivery_status, delivered_at, r2_archive_key,
            correlation_id, created_at
       FROM report_delivery_log
      WHERE report_run_id = $1
      ORDER BY created_at ASC`,
    [reportRunId],
  );
  return result.rows;
}
