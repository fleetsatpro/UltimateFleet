import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../../scripts/lib/migrate.mjs';
// Imported from the side-effect-free library module, NOT from the CLI entrypoint —
// migrate-down-up.mjs runs at import, so importing the helper from there would silently
// execute a whole extra down/up cycle.
import { schemaSnapshot } from '../../scripts/lib/schema-snapshot.mjs';
import { seedAll } from '../../seeds/seed.mjs';
import { ownerDatabaseUrl } from '@deepsight/test-support';

/**
 * Phase 1 acceptance test A8: every down() migration genuinely reverses its up().
 *
 * Named `zz-` so it runs last in the serial integration suite: it necessarily drops
 * every table, and re-seeds afterwards so a subsequent run starts from known state.
 * Down migrations that are never executed are down migrations that DO NOT WORK, and you
 * find that out during an incident rollback — the worst possible moment.
 */

describe('A8 — migrations are reversible', () => {
  it('down then up reproduces an identical schema, and leaves no tables behind at the bottom', async () => {
    const client = new pg.Client({ connectionString: ownerDatabaseUrl() });
    await client.connect();

    try {
      const before = await schemaSnapshot(client);
      expect(before.length).toBeGreaterThan(0);

      await migrate('down', undefined);

      const atBottom = JSON.parse(await schemaSnapshot(client)) as {
        rls: { relname: string }[];
      };
      const leftover = atBottom.rls.filter((r) => r.relname !== 'pgmigrations');
      expect(
        leftover.map((t) => t.relname),
        'down migrations left tables behind',
      ).toEqual([]);

      await migrate('up', undefined);
      const after = await schemaSnapshot(client);

      // Compares columns, policies (including qual and with_check), RLS flags and every
      // index definition — so a down() that drops a table but forgets its policy, or an
      // up() that recreates a table without its partial index, both fail here.
      expect(after).toBe(before);

      // Restore fixtures for any later run.
      await seedAll(client);
    } finally {
      await client.end();
    }
  });
});
