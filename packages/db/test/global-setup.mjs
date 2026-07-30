/**
 * Integration suite global setup: bring the schema to a known state, then seed.
 *
 * Migrations run as deepsight_owner (never as a superuser, which would bypass RLS and
 * make the isolation assertions meaningless). Down-then-up rather than just up, so the
 * suite always starts from an empty schema regardless of what the previous run left.
 */
import pg from 'pg';
import { migrate } from '../scripts/lib/migrate.mjs';
import { seedAll } from '../seeds/seed.mjs';
import { ownerUrl } from '../scripts/lib/env.mjs';

export async function setup() {
  await migrate('down', undefined);
  await migrate('up', undefined);

  const client = new pg.Client({ connectionString: ownerUrl() });
  await client.connect();
  try {
    await seedAll(client);
  } finally {
    await client.end();
  }
}

export async function teardown() {
  // Schema is left in place deliberately: after a failure, being able to inspect the
  // database is worth more than a clean slate.
}
