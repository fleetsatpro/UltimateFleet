import type { Client, PoolClient } from 'pg';

/** A stable JSON fingerprint of the live schema: columns, policies, RLS flags, indexes, routines. */
export declare function schemaSnapshot(client: Client | PoolClient): Promise<string>;
