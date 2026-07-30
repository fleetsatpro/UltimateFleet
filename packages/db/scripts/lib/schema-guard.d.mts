import type { Client, PoolClient } from 'pg';

/**
 * Hand-authored declarations for the .mjs schema guards.
 *
 * The guards stay plain JavaScript so `node` can run them directly from a package
 * script with no TS loader, while these declarations give TypeScript consumers real
 * types instead of `any`. One implementation, two consumers (CLI and test suite).
 */
type Queryable = Client | PoolClient;

export declare const GLOBAL_TABLES: Set<string>;
export declare const BINARY_COLUMN_ALLOWLIST: Set<string>;
export declare function findTenancyViolations(client: Queryable): Promise<string[]>;
export declare function findBinaryColumnViolations(client: Queryable): Promise<string[]>;
export declare function runAllGuards(client: Queryable): Promise<string[]>;
