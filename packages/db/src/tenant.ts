import type { QueryResult, QueryResultRow } from 'pg';
import { getPool } from './pool.js';

/**
 * Tenant-scoped database access. Read the three notes below before changing anything
 * here — each one is a cross-tenant leak vector if got wrong.
 *
 * 1. set_config(..., TRUE) is TRANSACTION-LOCAL, not session-local. With `SET` or
 *    set_config(..., false), the GUC survives client.release() and is still set for
 *    whichever request borrows that connection next — and that request then reads the
 *    PREVIOUS TENANT'S ROWS. This is the exact failure mode that rules out ORM
 *    abstractions which hide connection checkout, and it is asserted by test A5.
 *
 * 2. Always inside a transaction. Transaction-local scoping requires a transaction;
 *    without BEGIN the setting has nothing to be scoped to.
 *
 * 3. Tenant context is a parameter, never ambient. There is no global "current org".
 *    Untenanted access exists only via withGlobalConfig(), which is separately named
 *    so it is visible in review.
 */

export interface TenantTransaction {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface TenantContext {
  readonly orgId: string;
  readonly clientId: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validated before it reaches set_config. An empty string would make the policy's
 * `''::uuid` cast throw mid-statement, and a caller passing a non-uuid deserves a
 * clear error at the boundary rather than a confusing one three layers down.
 */
function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID; received ${JSON.stringify(value)}`);
  }
}

async function runInTenantContext<T>(
  context: TenantContext,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertUuid(context.orgId, 'orgId');
  if (context.clientId !== null) assertUuid(context.clientId, 'clientId');

  const client = await getPool().connect();
  const tx: TenantTransaction = {
    query: (text, params) =>
      params === undefined ? client.query(text) : client.query(text, [...params]),
  };

  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', context.orgId]);
    if (context.clientId !== null) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_client_id',
        context.clientId,
      ]);
    }
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Rolling back can itself fail if the connection is already broken. Swallowing
    // THAT would hide the original error, which is the one worth seeing — so the
    // rollback failure is reported and the original is rethrown below.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      process.stderr.write(
        `${JSON.stringify({
          level: 'error',
          msg: 'ROLLBACK failed; connection discarded',
          err: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        })}\n`,
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` scoped to one organization. Every tenant table is filtered to that org by
 * the org_isolation policy; the client-narrowing policy is a no-op because
 * app.current_client_id is left unset.
 *
 * This is the entry point for supervisor and admin work, which spans all of an
 * operator's clients.
 */
export async function withOrg<T>(
  orgId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return runInTenantContext({ orgId, clientId: null }, fn);
}

/**
 * Runs `fn` scoped to one organization AND one client. Used for report_viewer sessions
 * and per-client report generation, where seeing a sibling client's data would be a
 * confidentiality breach between two customers of the same operator.
 */
export async function withOrgClient<T>(
  orgId: string,
  clientId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return runInTenantContext({ orgId, clientId }, fn);
}

/**
 * Runs `fn` with NO tenant context, for the genuinely global configuration table
 * `alarm_event_type_mappings`.
 *
 * This is safe by construction rather than by discipline: with no GUC set, every
 * tenant-scoped policy evaluates `org_id = NULL`, which is NULL and never true, so
 * every tenant table returns zero rows and rejects every insert. A withGlobalConfig
 * block physically cannot read or write tenant data even if someone points it at a
 * tenant table. Test A3 asserts that fail-closed property.
 */
export async function withGlobalConfig<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const tx: TenantTransaction = {
    query: (text, params) =>
      params === undefined ? client.query(text) : client.query(text, [...params]),
  };
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      process.stderr.write(
        `${JSON.stringify({
          level: 'error',
          msg: 'ROLLBACK failed; connection discarded',
          err: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        })}\n`,
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
