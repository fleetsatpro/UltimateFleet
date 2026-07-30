import type { TenantTransaction } from '../tenant.js';

/**
 * Guard enrollment lifecycle — three INDEPENDENT operations, which is what the brief's
 * offboarding and right-to-erasure requirements actually demand:
 *
 *   revoke          blocks future sign-ins immediately; record retained
 *   eraseBiometric  destroys the embedding; event records untouched
 *   delete          not supported, at any layer
 *
 * `embedding_vector` is nullable precisely so erasure is a column update rather than a
 * row delete. Because guard_enrollments is FK-referenced by nothing in the event
 * tables (events carry guard_id, which points at `guards`), erasing an embedding cannot
 * cascade into event history. That is the schema property making right-to-erasure and a
 * permanent audit trail coexist, and it is asserted by test A10.
 */

export interface EnrollmentRow {
  readonly id: string;
  readonly guard_id: string;
  readonly device_id: string;
  readonly revoked_at: Date | null;
  readonly erased_at: Date | null;
  readonly has_embedding: boolean;
}

export async function findActiveEnrollment(
  tx: TenantTransaction,
  guardId: string,
): Promise<EnrollmentRow | undefined> {
  const result = await tx.query<EnrollmentRow>(
    `SELECT id, guard_id, device_id, revoked_at, erased_at,
            (embedding_vector IS NOT NULL) AS has_embedding
       FROM guard_enrollments
      WHERE guard_id = $1 AND revoked_at IS NULL`,
    [guardId],
  );
  return result.rows[0];
}

/**
 * The check the mobile refresh endpoint runs on EVERY refresh. No row means the
 * enrollment is revoked, so the refresh is rejected and the token family invalidated —
 * which is what bounds revocation propagation to one refresh cycle.
 */
export async function isEnrollmentActive(
  tx: TenantTransaction,
  deviceId: string,
  guardId: string,
): Promise<boolean> {
  const result = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok FROM guard_enrollments
      WHERE device_id = $1 AND guard_id = $2 AND revoked_at IS NULL`,
    [deviceId, guardId],
  );
  return result.rowCount === 1;
}

/** Offboarding. Historical patrol, attendance and closure records are never touched. */
export async function revokeEnrollment(
  tx: TenantTransaction,
  enrollmentId: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE guard_enrollments SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [enrollmentId],
  );
  return result.rowCount === 1;
}

/**
 * Right-to-erasure. Destroys the biometric embedding without affecting event records.
 * Deliberately separate from revocation: a guard may be erased while their historical
 * attendance remains, and may be revoked while still enrolled pending an erasure request.
 */
export async function eraseBiometric(
  tx: TenantTransaction,
  enrollmentId: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE guard_enrollments
        SET embedding_vector = NULL, erased_at = now()
      WHERE id = $1 AND embedding_vector IS NOT NULL`,
    [enrollmentId],
  );
  return result.rowCount === 1;
}
