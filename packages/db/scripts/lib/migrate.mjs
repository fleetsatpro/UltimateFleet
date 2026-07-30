import migrationRunnerModule from 'node-pg-migrate';
import { migrationsDir, ownerUrl } from './env.mjs';

// node-pg-migrate exposes the runner as a default export; tolerate both shapes so a
// minor packaging change does not break the migration path silently.
const runner =
  typeof migrationRunnerModule === 'function'
    ? migrationRunnerModule
    : migrationRunnerModule.default;

if (typeof runner !== 'function') {
  throw new Error('Could not resolve the node-pg-migrate runner export.');
}

/**
 * Runs migrations as deepsight_owner.
 *
 * @param {'up'|'down'} direction
 * @param {number|undefined} count number of migrations for `down`; undefined means all
 */
export async function migrate(direction, count) {
  return runner({
    databaseUrl: ownerUrl(),
    dir: migrationsDir,
    direction,
    migrationsTable: 'pgmigrations',
    count: count ?? (direction === 'down' ? Infinity : undefined),
    verbose: process.env['MIGRATE_VERBOSE'] === '1',
    // One transaction across the whole batch: a half-applied RLS migration would leave
    // some tables protected and others open, which is worse than not migrating at all.
    singleTransaction: true,
  });
}
