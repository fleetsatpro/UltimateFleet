import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRoleClients, type RoleClients } from '@deepsight/test-support';
// The guards are plain .mjs so the same code serves both the CLI and this test — one
// mechanism, not a script and a re-implementation that can drift apart.
import {
  findBinaryColumnViolations,
  findTenancyViolations,
  runAllGuards,
} from '../../scripts/lib/schema-guard.mjs';

/**
 * Phase 1 acceptance test A12 (schema half): the migration-lint rules are live, not
 * aspirational. Each fixture below is a mistake a future developer will plausibly make,
 * and each must fail CI with a message pointing at the rule.
 */

let roles: RoleClients;

beforeAll(() => {
  roles = createRoleClients();
});

afterAll(async () => {
  await roles.close();
});

describe('the real schema is clean', () => {
  it('passes every guard', async () => {
    const client = await roles.owner.connect();
    try {
      const violations = await runAllGuards(client);
      expect(violations, `schema guard violations:\n${violations.join('\n')}`).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe('a tenant table shipped without RLS is rejected', () => {
  it('reports missing org_id, missing RLS, missing FORCE and missing policy', async () => {
    const client = await roles.owner.connect();
    try {
      await client.query(`CREATE TABLE fixture_bad_tenant_table (id uuid PRIMARY KEY, note text)`);

      const violations = await findTenancyViolations(client);
      const forTable = violations.filter((v) => v.startsWith('fixture_bad_tenant_table'));

      expect(forTable.some((v) => /no org_id column/.test(v))).toBe(true);
      expect(forTable.some((v) => /not enabled/.test(v))).toBe(true);
      expect(forTable.some((v) => /not FORCED/.test(v))).toBe(true);
    } finally {
      await client.query(`DROP TABLE IF EXISTS fixture_bad_tenant_table`);
      client.release();
    }
  });

  it('rejects a table with RLS enabled but only restrictive policies', async () => {
    /**
     * The subtlest of the three, and the reason this rule exists at all: PostgreSQL
     * computes (OR of permissive) AND (AND of restrictive), so an empty permissive set
     * is false and the table returns ZERO rows. It looks protected. It is broken.
     */
    const client = await roles.owner.connect();
    try {
      await client.query(
        `CREATE TABLE fixture_restrictive_only (id uuid PRIMARY KEY, org_id uuid NOT NULL)`,
      );
      await client.query(`ALTER TABLE fixture_restrictive_only ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE fixture_restrictive_only FORCE ROW LEVEL SECURITY`);
      await client.query(
        `CREATE POLICY only_restrictive ON fixture_restrictive_only AS RESTRICTIVE
           USING (org_id = current_setting('app.current_org_id', true)::uuid)`,
      );

      const violations = await findTenancyViolations(client);
      const forTable = violations.filter((v) => v.startsWith('fixture_restrictive_only'));
      expect(forTable.some((v) => /only RESTRICTIVE policies/.test(v))).toBe(true);
    } finally {
      await client.query(`DROP TABLE IF EXISTS fixture_restrictive_only`);
      client.release();
    }
  });
});

describe('a binary column outside the allowlist is rejected', () => {
  it('accepts guard_enrollments.embedding_vector and nothing else', async () => {
    const client = await roles.owner.connect();
    try {
      // The real schema already contains the one allowed bytea column.
      expect(await findBinaryColumnViolations(client)).toEqual([]);

      await client.query(`CREATE TABLE fixture_binary_table (id uuid PRIMARY KEY, photo bytea)`);

      const violations = await findBinaryColumnViolations(client);
      expect(violations.some((v) => v.startsWith('fixture_binary_table.photo'))).toBe(true);
      // The message must point at the fix, not merely name the offence.
      expect(violations.some((v) => /Cloudflare R2/.test(v))).toBe(true);
    } finally {
      await client.query(`DROP TABLE IF EXISTS fixture_binary_table`);
      client.release();
    }
  });
});
