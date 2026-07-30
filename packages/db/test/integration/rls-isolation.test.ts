import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENT_SCOPED_TABLES,
  TENANT_TABLES,
  asTenant,
  countRows,
  createRoleClients,
  selectRows,
  withoutTenantContext,
  type RoleClients,
} from '@deepsight/test-support';

/**
 * Phase 1 acceptance tests A1-A6: tenant isolation.
 *
 * A4, A5 and A6 are the three worth reviewing hardest. They catch the RLS mistakes that
 * otherwise reach production looking exactly like working code.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const ORG_B = '0b000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const CLIENT_A2 = '0a000000-0000-4000-8000-0000000000c2';

let roles: RoleClients;

beforeAll(() => {
  roles = createRoleClients();
});

afterAll(async () => {
  await roles.close();
});

describe('A1 — org read isolation as deepsight_app', () => {
  it('returns only the current org rows, on every tenant table', async () => {
    const aCounts = await asTenant(roles.app, { orgId: ORG_A }, async (client) => {
      const counts: Record<string, number> = {};
      for (const table of TENANT_TABLES) counts[table] = await countRows(client, table);
      return counts;
    });

    const bCounts = await asTenant(roles.app, { orgId: ORG_B }, async (client) => {
      const counts: Record<string, number> = {};
      for (const table of TENANT_TABLES) counts[table] = await countRows(client, table);
      return counts;
    });

    // Org A is seeded with 2 clients / 3 sites / 2 guards / 3 users; org B with fewer.
    expect(aCounts['clients']).toBe(2);
    expect(bCounts['clients']).toBe(2);
    expect(aCounts['sites']).toBe(3);
    expect(bCounts['sites']).toBe(1);
    expect(aCounts['guards']).toBe(2);
    expect(bCounts['guards']).toBe(1);

    // Every tenant table must be non-empty for at least one org, otherwise this test
    // would pass vacuously on a table nobody seeded.
    for (const table of TENANT_TABLES) {
      expect(
        (aCounts[table] ?? 0) + (bCounts[table] ?? 0),
        `${table} has no seeded rows in either org, so isolation is untested for it`,
      ).toBeGreaterThan(0);
    }
  });

  it('never surfaces another org marker in alarm payloads', async () => {
    const rows = await asTenant(roles.app, { orgId: ORG_A }, (client) =>
      selectRows<{ marker: string }>(
        client,
        `SELECT DISTINCT raw_payload->>'marker' AS marker FROM alarm_events`,
      ),
    );
    expect(rows.map((r) => r.marker)).toEqual(['MARKER_ORG_A']);
  });
});

describe('A2 — WITH CHECK blocks cross-org writes', () => {
  it('rejects an INSERT stamped with another org id', async () => {
    await expect(
      asTenant(roles.app, { orgId: ORG_A }, (client) =>
        client.query(`INSERT INTO guards (org_id, full_name, employee_code) VALUES ($1, $2, $3)`, [
          ORG_B,
          'Smuggled Guard',
          'X-999',
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('rejects an UPDATE that would move a row to another org', async () => {
    await expect(
      asTenant(roles.app, { orgId: ORG_A }, (client) =>
        client.query(`UPDATE guards SET org_id = $1`, [ORG_B]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('A3 — fails closed with no GUC set', () => {
  it('returns zero rows from every tenant table', async () => {
    const counts = await withoutTenantContext(roles.app, async (client) => {
      const result: Record<string, number> = {};
      for (const table of TENANT_TABLES) result[table] = await countRows(client, table);
      result['organizations'] = await countRows(client, 'organizations');
      return result;
    });

    for (const [table, count] of Object.entries(counts)) {
      expect(count, `${table} leaked ${count} rows with no tenant context`).toBe(0);
    }
  });

  it('still reads global config, which is deliberately not tenant-scoped', async () => {
    const count = await withoutTenantContext(roles.app, (client) =>
      countRows(client, 'alarm_event_type_mappings'),
    );
    expect(count).toBeGreaterThan(0);
  });

  it('returns zero rows rather than RAISING on a recycled connection', async () => {
    /**
     * Regression test for a bug found while building Phase 1.
     *
     * set_config(..., true) reverts on COMMIT to the custom GUC's previous value, which
     * for a never-session-set custom GUC is the EMPTY STRING, not NULL. So a policy
     * written as `org_id = current_setting('app.current_org_id', true)::uuid` raises
     * "invalid input syntax for type uuid" on any connection that previously served a
     * tenant query — a runtime error instead of an empty result.
     *
     * The fix is the app_current_org() helper, which NULLIFs the empty string away.
     */
    await asTenant(roles.app, { orgId: ORG_A }, (client) => countRows(client, 'alarm_events'));

    const observed = await withoutTenantContext(roles.app, async (client) => {
      const raw = await selectRows<{ guc: string | null; resolved: string | null }>(
        client,
        `SELECT current_setting('app.current_org_id', true) AS guc,
                app_current_org()::text                    AS resolved`,
      );
      // Must not throw — this is the assertion that matters.
      const count = await countRows(client, 'alarm_events');
      return { guc: raw[0]?.guc ?? null, resolved: raw[0]?.resolved ?? null, count };
    });

    // The raw GUC really is the empty string here, which is the whole point.
    expect(observed.guc).toBe('');
    // The helper turns it into NULL, so the policy compares against NULL and matches nothing.
    expect(observed.resolved).toBeNull();
    expect(observed.count).toBe(0);
  });
});

describe('A4 — FORCE ROW LEVEL SECURITY applies to the table owner', () => {
  /**
   * This is the test that fails if FORCE was omitted. By default a table owner bypasses
   * every policy, so without FORCE the owner would see all 4 clients across both orgs
   * instead of org A's 2. Developers routinely test isolation while connected as the
   * owner, see policies "working", and never notice the bypass.
   */
  it('filters the owner to the current org, not to everything', async () => {
    const ownerVisible = await asTenant(roles.owner, { orgId: ORG_A }, (client) =>
      countRows(client, 'clients'),
    );
    expect(ownerVisible).toBe(2);

    const totalAcrossOrgs = await asTenant(roles.owner, { orgId: ORG_A }, async (client) => {
      const rows = await selectRows<{ total: string }>(
        client,
        // Bypass RLS deliberately? No — this counts what the owner CAN see, which under
        // FORCE RLS is the org-scoped set. A non-forced table would report 4 here.
        `SELECT count(*)::text AS total FROM clients`,
      );
      return Number(rows[0]?.total ?? '0');
    });
    expect(totalAcrossOrgs).toBe(2);
  });

  it('reports relforcerowsecurity on every tenant table', async () => {
    const rows = await withoutTenantContext(roles.owner, (client) =>
      selectRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        client,
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND c.relname <> ALL($1::text[])`,
        [['alarm_event_type_mappings', 'pgmigrations']],
      ),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname}: RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname}: RLS not FORCED`).toBe(true);
    }
  });
});

describe('A5 — the tenant GUC is transaction-local and never leaks across a pooled connection', () => {
  /**
   * The failure this guards against: with `SET` or set_config(..., false), the GUC
   * survives client.release() and is still set for whichever request borrows that
   * connection next — which then reads the previous tenant's rows.
   *
   * 100 interleaved calls across a pool of 5 connections, so connections are certain
   * to be reused between orgs.
   */
  it('sees no cross-org rows across 100 interleaved calls', async () => {
    const observed: { org: string; clients: number; markers: string[] }[] = [];

    for (let i = 0; i < 100; i += 1) {
      const orgId = i % 2 === 0 ? ORG_A : ORG_B;
      const expectedMarker = i % 2 === 0 ? 'MARKER_ORG_A' : 'MARKER_ORG_B';

      const result = await asTenant(roles.app, { orgId }, async (client) => {
        const clients = await countRows(client, 'clients');
        const markers = await selectRows<{ marker: string }>(
          client,
          `SELECT DISTINCT raw_payload->>'marker' AS marker FROM alarm_events`,
        );
        return { clients, markers: markers.map((m) => m.marker) };
      });

      expect(result.markers).toEqual([expectedMarker]);
      observed.push({ org: orgId, ...result });
    }

    expect(observed).toHaveLength(100);
    expect(observed.every((o) => o.clients === 2)).toBe(true);
  });

  it('leaves the GUC unset on a freshly checked-out connection', async () => {
    // Dirty a connection, return it to the pool, then check what the next borrower sees.
    await asTenant(roles.app, { orgId: ORG_A }, (client) => countRows(client, 'clients'));

    const leaked = await withoutTenantContext(roles.app, (client) =>
      selectRows<{ org: string | null }>(
        client,
        `SELECT current_setting('app.current_org_id', true) AS org`,
      ),
    );

    // Empty string or null both mean "not set"; a uuid here would be a leak.
    const value = leaked[0]?.org ?? null;
    expect(value === null || value === '').toBe(true);
  });
});

describe('A6 — client narrowing is RESTRICTIVE and therefore AND-combined', () => {
  /**
   * Verified experimentally before writing the migration: PostgreSQL evaluates
   *   (OR of PERMISSIVE) AND (AND of RESTRICTIVE)
   * so leaving the narrowing policy PERMISSIVE would OR it with org_isolation and
   * silently defeat it — over-exposure with no error anywhere. Equally, making BOTH
   * policies restrictive yields zero rows, because an empty permissive set is false.
   */
  it('narrows to one client while withOrg sees all of them', async () => {
    const broad = await asTenant(roles.app, { orgId: ORG_A }, (client) =>
      countRows(client, 'alarm_events'),
    );
    const narrowedA1 = await asTenant(roles.app, { orgId: ORG_A, clientId: CLIENT_A1 }, (client) =>
      countRows(client, 'alarm_events'),
    );
    const narrowedA2 = await asTenant(roles.app, { orgId: ORG_A, clientId: CLIENT_A2 }, (client) =>
      countRows(client, 'alarm_events'),
    );

    expect(broad).toBe(narrowedA1 + narrowedA2);
    expect(narrowedA1).toBeGreaterThan(0);
    expect(narrowedA2).toBeGreaterThan(0);
    expect(narrowedA1).toBeLessThan(broad);
  });

  it('returns zero sibling-client rows on every client-scoped table', async () => {
    const siblingRows = await asTenant(
      roles.app,
      { orgId: ORG_A, clientId: CLIENT_A1 },
      async (client) => {
        const counts: Record<string, number> = {};
        for (const table of CLIENT_SCOPED_TABLES) {
          const rows = await selectRows<{ count: string }>(
            client,
            `SELECT count(*)::text AS count FROM ${table} WHERE client_id <> $1`,
            [CLIENT_A1],
          );
          counts[table] = Number(rows[0]?.count ?? '0');
        }
        return counts;
      },
    );

    for (const [table, count] of Object.entries(siblingRows)) {
      expect(count, `${table} leaked ${count} sibling-client rows`).toBe(0);
    }
  });

  it('has exactly one permissive policy per tenant table', async () => {
    const rows = await withoutTenantContext(roles.owner, (client) =>
      selectRows<{ tablename: string; permissive: string; policyname: string }>(
        client,
        `SELECT tablename, policyname, permissive FROM pg_policies WHERE schemaname = 'public'`,
      ),
    );

    const permissiveCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.permissive !== 'PERMISSIVE') continue;
      permissiveCounts.set(row.tablename, (permissiveCounts.get(row.tablename) ?? 0) + 1);
    }

    for (const table of TENANT_TABLES) {
      expect(
        permissiveCounts.get(table),
        `${table} must have exactly one PERMISSIVE policy; restrictive-only yields zero rows`,
      ).toBe(1);
    }
  });
});
