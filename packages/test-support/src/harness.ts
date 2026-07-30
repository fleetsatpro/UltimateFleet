import pg from 'pg';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Integration test harness.
 *
 * Driven by connection URLs from the environment rather than by Testcontainers. That is
 * a deliberate choice: CI supplies PostgreSQL as a service container, and a
 * URL-driven harness runs unchanged against that, against a local cluster, and against
 * a Testcontainers instance if one is introduced later. Binding the harness to a Docker
 * daemon would make the acceptance suite unrunnable anywhere Docker is unavailable —
 * which includes this development environment.
 *
 * The critical property: integration tests connect as deepsight_app, never as the
 * owner. Running them as owner is how RLS bugs reach production — the tests pass
 * because the owner bypasses the very policies they claim to verify.
 */

function requireUrl(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Integration tests require ${name}. Run "pnpm db:bootstrap" once, then export ` +
        `ADMIN_DATABASE_URL, DATABASE_URL_OWNER and DATABASE_URL (see .env.example).`,
    );
  }
  return value;
}

export const appDatabaseUrl = (): string => requireUrl('DATABASE_URL');
export const ownerDatabaseUrl = (): string => requireUrl('DATABASE_URL_OWNER');
export const adminDatabaseUrl = (): string => requireUrl('ADMIN_DATABASE_URL');

export interface RoleClients {
  /** deepsight_app — the role every application query path uses. */
  readonly app: Pool;
  /** deepsight_owner — used ONLY to prove FORCE ROW LEVEL SECURITY applies to it (A4). */
  readonly owner: Pool;
  close(): Promise<void>;
}

export function createRoleClients(): RoleClients {
  const app = new pg.Pool({ connectionString: appDatabaseUrl(), max: 5 });
  const owner = new pg.Pool({ connectionString: ownerDatabaseUrl(), max: 2 });
  return {
    app,
    owner,
    async close() {
      await app.end();
      await owner.end();
    },
  };
}

export interface TenantScope {
  readonly orgId: string;
  readonly clientId?: string | null | undefined;
}

/**
 * Runs `fn` on a dedicated connection from `pool` with the tenant GUCs set
 * transaction-locally — the same mechanism as withOrg()/withOrgClient(), but against
 * an arbitrary pool so the owner role can be exercised too.
 */
export async function asTenant<T>(
  pool: Pool,
  scope: TenantScope,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', scope.orgId]);
    if (scope.clientId !== undefined && scope.clientId !== null) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_client_id',
        scope.clientId,
      ]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      process.stderr.write(`test harness ROLLBACK failed: ${String(rollbackError)}\n`);
    });
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `fn` with NO tenant GUC set at all — the fail-closed path asserted by A3. */
export async function withoutTenantContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      process.stderr.write(`test harness ROLLBACK failed: ${String(rollbackError)}\n`);
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function countRows(client: PoolClient, table: string): Promise<number> {
  // Table names here come from test code and a fixed schema list, never user input.
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function selectRows<R extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly R[]> {
  const result = await client.query<R>(sql, [...params]);
  return result.rows;
}

/**
 * Every tenant-scoped table, for table-driven isolation assertions. Listing them
 * explicitly means a new table added without a corresponding isolation test is a
 * visible omission in this file rather than an invisible gap in coverage.
 */
export const TENANT_TABLES = [
  'clients',
  'sites',
  'guards',
  'users',
  'guard_enrollments',
  'shift_attendance',
  'patrol_checkpoints',
  'patrol_scans',
  'alarm_sources',
  'alarm_events',
  'alarm_closures',
  'incident_media',
  'report_runs',
  'report_delivery_log',
] as const;

/** Of those, the ones carrying client_id and therefore subject to client narrowing. */
export const CLIENT_SCOPED_TABLES = [
  'sites',
  'guard_enrollments',
  'shift_attendance',
  'patrol_checkpoints',
  'patrol_scans',
  'alarm_sources',
  'alarm_events',
  'alarm_closures',
  'incident_media',
  'report_runs',
  'report_delivery_log',
] as const;
