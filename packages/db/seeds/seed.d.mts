import type { Client } from 'pg';

/** Seeds deterministic fixtures: 2 organizations x 2 clients. Idempotent. */
export declare function seedAll(client: Client): Promise<void>;
