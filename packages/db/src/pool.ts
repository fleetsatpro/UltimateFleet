import { Pool, type PoolConfig } from 'pg';

/**
 * The connection pool.
 *
 * This module is deliberately NOT re-exported from the package index, and deep imports
 * into it are banned by an ESLint rule. Application code therefore cannot obtain a raw
 * connection, which means it cannot issue a query without a tenant GUC — see tenant.ts
 * for why an escaped connection is a cross-tenant data leak rather than merely untidy.
 */

let pool: Pool | null = null;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number | undefined;
}

export function initPool(options: PoolOptions): Pool {
  if (pool !== null) {
    throw new Error('Pool already initialised. initPool() must be called exactly once at startup.');
  }
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  pool = new Pool(config);

  // An idle-client error that nobody listens for crashes the process on some pg
  // versions. Rethrowing here would do exactly that, so it is logged by the caller's
  // handler instead; the pool discards the broken client either way.
  pool.on('error', (error) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'idle postgres client error', err: error.message })}\n`,
    );
  });

  return pool;
}

export function getPool(): Pool {
  if (pool === null) {
    throw new Error('Pool not initialised. Call initPool() at service startup.');
  }
  return pool;
}

export function isPoolInitialised(): boolean {
  return pool !== null;
}

export async function closePool(): Promise<void> {
  if (pool === null) return;
  const current = pool;
  pool = null;
  await current.end();
}
