import { withGlobalConfig } from '../tenant.js';
import type { TenantTransaction } from '../tenant.js';

/**
 * Authentication persistence: the login lookup, user provisioning, and the enrollment- and
 * refresh-token lifecycles. Everything except the login lookup is tenant-scoped (runs under
 * withOrg); the login lookup alone crosses orgs, and does so through the audited
 * SECURITY DEFINER `auth_lookup_user` rather than a raw cross-tenant read.
 */

export interface AuthUser {
  readonly id: string;
  readonly org_id: string;
  readonly role: string;
  readonly client_id: string | null;
  readonly password_hash: string;
}

/**
 * Resolves a user by globally-unique email for login. Runs with NO tenant context — the org is
 * not known until the row is found — so it calls the SECURITY DEFINER function, which is the one
 * sanctioned way to read users across orgs. Returns null for an unknown email, indistinguishable
 * (to the caller) from a wrong password, so account existence does not leak.
 */
export async function lookupUserForAuth(email: string): Promise<AuthUser | null> {
  return withGlobalConfig(async (tx) => {
    const result = await tx.query<AuthUser>(
      `SELECT id, org_id, role, client_id, password_hash FROM auth_lookup_user($1)`,
      [email],
    );
    return result.rows[0] ?? null;
  });
}

/** Provisions a dashboard user. Tenant-scoped; the caller supplies the pre-hashed password. */
export async function insertUser(
  tx: TenantTransaction,
  params: {
    readonly orgId: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly role: string;
    readonly clientId: string | null;
  },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO users (org_id, email, password_hash, role, client_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.orgId, params.email, params.passwordHash, params.role, params.clientId],
  );
  return result.rows[0]!.id;
}

// --- Enrollment tokens ---

export async function insertEnrollmentToken(
  tx: TenantTransaction,
  params: {
    readonly orgId: string;
    readonly clientId: string;
    readonly guardId: string;
    readonly deviceLabel: string | null;
    readonly tokenHash: string;
    readonly createdBy: string;
    readonly expiresAt: Date;
  },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO enrollment_tokens
       (org_id, client_id, guard_id, device_label, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      params.orgId,
      params.clientId,
      params.guardId,
      params.deviceLabel,
      params.tokenHash,
      params.createdBy,
      params.expiresAt,
    ],
  );
  return result.rows[0]!.id;
}

export interface ConsumedEnrollment {
  readonly id: string;
  readonly client_id: string;
  readonly guard_id: string;
  readonly device_label: string | null;
  readonly created_by: string;
}

/**
 * Atomically redeems an enrollment token: single-use and time-limited enforced in ONE UPDATE.
 * The WHERE clause requires the token to be unconsumed and unexpired, so a second redemption or
 * an expired one matches zero rows and returns null — the route maps that to 410 Gone. Doing it
 * in a single statement (not read-then-write) closes the race where two devices redeem at once.
 */
export async function consumeEnrollmentToken(
  tx: TenantTransaction,
  tokenHash: string,
): Promise<ConsumedEnrollment | null> {
  const result = await tx.query<ConsumedEnrollment>(
    `UPDATE enrollment_tokens
        SET consumed_at = now()
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, client_id, guard_id, device_label, created_by`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

// --- Refresh token families ---

export async function createRefreshFamily(
  tx: TenantTransaction,
  params: {
    readonly orgId: string;
    readonly clientId: string;
    readonly guardId: string;
    readonly enrollmentId: string;
    readonly deviceId: string;
  },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO refresh_families (org_id, client_id, guard_id, enrollment_id, device_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.orgId, params.clientId, params.guardId, params.enrollmentId, params.deviceId],
  );
  return result.rows[0]!.id;
}

export async function insertRefreshToken(
  tx: TenantTransaction,
  params: {
    readonly orgId: string;
    readonly clientId: string;
    readonly familyId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO device_refresh_tokens (org_id, client_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.orgId, params.clientId, params.familyId, params.tokenHash, params.expiresAt],
  );
  return result.rows[0]!.id;
}

export interface RefreshTokenRow {
  readonly id: string;
  readonly family_id: string;
  readonly consumed_at: Date | null;
  readonly expires_at: Date;
}

/**
 * Locks a refresh token row FOR UPDATE so concurrent refreshes of the same token serialize —
 * the check-then-rotate must be atomic or a replay could slip through between read and write.
 */
export async function lockRefreshToken(
  tx: TenantTransaction,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  const result = await tx.query<RefreshTokenRow>(
    `SELECT id, family_id, consumed_at, expires_at
       FROM device_refresh_tokens
      WHERE token_hash = $1
      FOR UPDATE`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export interface RefreshFamilyRow {
  readonly id: string;
  readonly guard_id: string;
  readonly client_id: string;
  readonly enrollment_id: string;
  readonly device_id: string;
  readonly revoked_at: Date | null;
}

export async function findRefreshFamily(
  tx: TenantTransaction,
  familyId: string,
): Promise<RefreshFamilyRow | null> {
  const result = await tx.query<RefreshFamilyRow>(
    `SELECT id, guard_id, client_id, enrollment_id, device_id, revoked_at
       FROM refresh_families
      WHERE id = $1`,
    [familyId],
  );
  return result.rows[0] ?? null;
}

export async function consumeRefreshToken(tx: TenantTransaction, tokenId: string): Promise<void> {
  await tx.query(
    `UPDATE device_refresh_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
    [tokenId],
  );
}

/** Kills an entire refresh family — on replay detection or enrollment revocation. */
export async function revokeRefreshFamily(tx: TenantTransaction, familyId: string): Promise<void> {
  await tx.query(
    `UPDATE refresh_families SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}
