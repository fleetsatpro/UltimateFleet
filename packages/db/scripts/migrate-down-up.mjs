#!/usr/bin/env node
/**
 * Acceptance test A8, as a runnable command.
 *
 * Migrates all the way down, back up, and compares the resulting schema against the
 * snapshot taken before starting. Down migrations that are never executed are down
 * migrations that DO NOT WORK — and you find that out during an incident rollback,
 * which is the worst possible moment.
 */
import pg from 'pg';
import { migrate } from './lib/migrate.mjs';
import { schemaSnapshot } from './lib/schema-snapshot.mjs';
import { ownerUrl } from './lib/env.mjs';

const client = new pg.Client({ connectionString: ownerUrl() });
await client.connect();
try {
  const before = await schemaSnapshot(client);

  await migrate('down', undefined);

  const atBottom = JSON.parse(await schemaSnapshot(client));
  const leftover = atBottom.rls.filter((r) => r.relname !== 'pgmigrations');
  if (leftover.length > 0) {
    throw new Error(
      `down migrations left ${leftover.length} table(s) behind: ` +
        leftover.map((t) => t.relname).join(', '),
    );
  }

  await migrate('up', undefined);
  const after = await schemaSnapshot(client);

  if (before !== after) {
    throw new Error(
      'Schema after down+up does not match the schema before. At least one down() ' +
        'migration is not a faithful reverse of its up().',
    );
  }
  console.log('migrate:down:up OK — all migrations reversed and reapplied; schema identical.');
} finally {
  await client.end();
}
