import type { TenantTransaction } from '../tenant.js';

/**
 * Poll cursor persistence.
 *
 * The cursor lives in the database rather than in adapter memory so polling survives a
 * redeploy. Railway restarts a service on every deploy; an in-memory cursor means the
 * next poll either re-fetches all history or silently resumes from "now" and loses
 * whatever arrived during the restart.
 */
export interface AlarmSourceRow {
  readonly id: string;
  readonly vendor: string;
  readonly external_ref: string;
  readonly poll_cursor: string | null;
  readonly enabled: boolean;
}

export async function readPollCursor(
  tx: TenantTransaction,
  sourceId: string,
): Promise<string | null> {
  const result = await tx.query<{ poll_cursor: string | null }>(
    `SELECT poll_cursor FROM alarm_sources WHERE id = $1`,
    [sourceId],
  );
  return result.rows[0]?.poll_cursor ?? null;
}

export async function writePollCursor(
  tx: TenantTransaction,
  sourceId: string,
  cursor: string | null,
): Promise<boolean> {
  const result = await tx.query(`UPDATE alarm_sources SET poll_cursor = $2 WHERE id = $1`, [
    sourceId,
    cursor,
  ]);
  return result.rowCount === 1;
}

export async function listEnabledSources(
  tx: TenantTransaction,
): Promise<readonly AlarmSourceRow[]> {
  const result = await tx.query<AlarmSourceRow>(
    `SELECT id, vendor, external_ref, poll_cursor, enabled
       FROM alarm_sources WHERE enabled ORDER BY vendor, external_ref`,
  );
  return result.rows;
}
