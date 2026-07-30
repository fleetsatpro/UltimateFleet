#!/usr/bin/env node
/**
 * Migration lint, run against the live schema.
 *
 * Two rules, both from docs/architecture/02-REPOSITORY-STRUCTURE.md section 6:
 *   - no bytea column outside the named allowlist (divergence D5)
 *   - no tenant table without org_id, RLS enabled, RLS forced, and a permissive policy
 */
import pg from 'pg';
import { runAllGuards } from './lib/schema-guard.mjs';
import { ownerUrl } from './lib/env.mjs';

const client = new pg.Client({ connectionString: ownerUrl() });
await client.connect();
try {
  const violations = await runAllGuards(client);
  if (violations.length > 0) {
    console.error('migration-lint FAILED:\n');
    for (const v of violations) console.error(`  - ${v}`);
    console.error('');
    process.exitCode = 1;
  } else {
    console.log('migration-lint OK — tenancy and binary-column rules hold across the schema.');
  }
} finally {
  await client.end();
}
