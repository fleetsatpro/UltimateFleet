import type { TenantTransaction } from '../tenant.js';

/**
 * Report run persistence.
 *
 * A `report_runs` row is written on EVERY outcome — complete, partial, stale_data, failed — never
 * only on success. A report that silently fails to appear is worse than one that appears marked
 * failed with a reason: the first looks like "no incidents", the second is actionable. The status
 * CHECK constraint enumerates the outcomes so an unknown one cannot be written.
 */
export type ReportStatus = 'pending' | 'running' | 'complete' | 'partial' | 'stale_data' | 'failed';

export async function insertReportRun(
  tx: TenantTransaction,
  params: {
    readonly orgId: string;
    readonly clientId: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly status: ReportStatus;
    readonly correlationId: string;
  },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO report_runs
       (org_id, client_id, period_start, period_end, status, correlation_id, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING id`,
    [
      params.orgId,
      params.clientId,
      params.periodStart,
      params.periodEnd,
      params.status,
      params.correlationId,
    ],
  );
  return result.rows[0]!.id;
}

/** Records the final outcome: status, any structured error detail, and the R2 archive key. */
export async function completeReportRun(
  tx: TenantTransaction,
  params: {
    readonly id: string;
    readonly status: ReportStatus;
    readonly errorDetail: Record<string, unknown> | null;
    readonly r2ObjectKey: string | null;
  },
): Promise<void> {
  await tx.query(
    `UPDATE report_runs
        SET status = $2,
            error_detail = $3::jsonb,
            r2_object_key = $4,
            completed_at = now()
      WHERE id = $1`,
    [
      params.id,
      params.status,
      params.errorDetail === null ? null : JSON.stringify(params.errorDetail),
      params.r2ObjectKey,
    ],
  );
}

export interface ReportRunRow {
  readonly id: string;
  readonly client_id: string;
  readonly status: string;
  readonly error_detail: unknown;
  readonly r2_object_key: string | null;
}

export async function getReportRun(
  tx: TenantTransaction,
  id: string,
): Promise<ReportRunRow | null> {
  const result = await tx.query<ReportRunRow>(
    `SELECT id, client_id, status, error_detail, r2_object_key FROM report_runs WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
