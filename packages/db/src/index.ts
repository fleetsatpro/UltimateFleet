/**
 * @deepsight/db — the only path to PostgreSQL.
 *
 * Note what is NOT exported: the connection pool. `initPool` and `closePool` are
 * lifecycle functions for a service entrypoint; `getPool` is not re-exported at all.
 * Application code therefore cannot obtain a raw connection, so it cannot issue a
 * query without a tenant GUC. Deep imports into ./pool.js are additionally banned by
 * an ESLint rule, so the boundary holds even against someone reaching around it.
 */
export { initPool, closePool, isPoolInitialised, type PoolOptions } from './pool.js';

export {
  withOrg,
  withOrgClient,
  withGlobalConfig,
  type TenantTransaction,
  type TenantContext,
} from './tenant.js';

export * from './repositories/alarm-events.js';
export * from './repositories/enrollments.js';
