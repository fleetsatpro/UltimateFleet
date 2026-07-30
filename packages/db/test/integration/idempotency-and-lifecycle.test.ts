import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import {
  asTenant,
  countRows,
  createRoleClients,
  selectRows,
  type RoleClients,
} from '@deepsight/test-support';

/**
 * Phase 1 acceptance tests A7, A9, A10: idempotency, single-active-enrollment, and
 * right-to-erasure independence from the audit trail.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';
const GUARD_A1 = '0a000000-0000-4000-8000-000000000a01';
const ENROLLMENT_A1 = '0a000000-0000-4000-8000-000000000e01';
const USER_A_ADMIN = '0a000000-0000-4000-8000-000000000901';

let roles: RoleClients;

beforeAll(() => {
  roles = createRoleClients();
});

afterAll(async () => {
  await roles.close();
});

describe('A7 — ingestion is idempotent against (vendor, vendor_event_id)', () => {
  it('writes one row for a duplicated event and reports 0 rows on the second attempt', async () => {
    const vendorEventId = `dup-test-${uuidv7()}`;

    const insert = (internalId: string) =>
      asTenant(roles.app, { orgId: ORG_A }, async (client) => {
        const result = await client.query(
          `INSERT INTO alarm_events (
             internal_id, org_id, client_id, site_id, vendor, vendor_event_id,
             vendor_event_code, event_type, severity, occurred_at, raw_payload, correlation_id
           ) VALUES ($1,$2,$3,$4,'dahua',$5,'1001','intrusion','high', now(), $6, 'corr-dup')
           ON CONFLICT (vendor, vendor_event_id) DO NOTHING
           RETURNING internal_id`,
          [
            internalId,
            ORG_A,
            CLIENT_A1,
            SITE_A1_1,
            vendorEventId,
            JSON.stringify({ marker: 'MARKER_ORG_A', probe: 'dup' }),
          ],
        );
        return result.rowCount;
      });

    // Two different internal ids — as would happen on a genuine redelivery, since the
    // internal id is minted fresh on each ingestion.
    const first = await insert(uuidv7());
    const second = await insert(uuidv7());

    expect(first).toBe(1);
    // Zero rows returned is what lets the pipeline gate fan-out on ACTUAL insertion.
    // Without it, a vendor redelivering one event 50 times would push 50 dashboard
    // notifications and enqueue 50 media fetches while correctly writing one row.
    expect(second).toBe(0);

    const stored = await asTenant(roles.app, { orgId: ORG_A }, (client) =>
      selectRows<{ count: string }>(
        client,
        `SELECT count(*)::text AS count FROM alarm_events WHERE vendor_event_id = $1`,
        [vendorEventId],
      ),
    );
    expect(Number(stored[0]?.count)).toBe(1);
  });

  it('deduplicates mobile sync retries on (device_id, client_event_id)', async () => {
    const clientEventId = uuidv7();
    const deviceId = 'device-sync-probe';

    const push = () =>
      asTenant(roles.app, { orgId: ORG_A }, async (client) => {
        const result = await client.query(
          `INSERT INTO shift_attendance (
             org_id, client_id, site_id, guard_id, device_id, client_event_id,
             event_type, occurred_at, correlation_id
           ) VALUES ($1,$2,$3,$4,$5,$6,'sign_in', now(), 'corr-sync')
           ON CONFLICT (device_id, client_event_id) DO NOTHING
           RETURNING id`,
          [ORG_A, CLIENT_A1, SITE_A1_1, GUARD_A1, deviceId, clientEventId],
        );
        return result.rowCount;
      });

    expect(await push()).toBe(1);
    // The phone lost the response and retried. The second insert must be harmless.
    expect(await push()).toBe(0);
  });
});

describe('A9 — at most one active enrollment per guard, enforced by the database', () => {
  /**
   * Enforced by a partial unique index rather than an application check, because an
   * application check races: two supervisors enrolling simultaneously both pass a
   * SELECT-then-INSERT and both write.
   */
  it('rejects a second active enrollment, then allows one after revocation', async () => {
    const secondDevice = `device-a1-replacement-${Date.now()}`;

    await expect(
      asTenant(roles.app, { orgId: ORG_A }, (client) =>
        client.query(
          `INSERT INTO guard_enrollments (org_id, client_id, guard_id, device_id, enrolled_by)
             VALUES ($1,$2,$3,$4,$5)`,
          [ORG_A, CLIENT_A1, GUARD_A1, secondDevice, USER_A_ADMIN],
        ),
      ),
    ).rejects.toThrow(/guard_enrollments_active_guard_idx|duplicate key/i);

    // Revoke the existing enrollment, then the replacement device is accepted.
    await asTenant(roles.app, { orgId: ORG_A }, (client) =>
      client.query(`UPDATE guard_enrollments SET revoked_at = now() WHERE id = $1`, [
        ENROLLMENT_A1,
      ]),
    );

    const inserted = await asTenant(roles.app, { orgId: ORG_A }, async (client) => {
      const result = await client.query(
        `INSERT INTO guard_enrollments (org_id, client_id, guard_id, device_id, enrolled_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ORG_A, CLIENT_A1, GUARD_A1, secondDevice, USER_A_ADMIN],
      );
      return result.rowCount;
    });
    expect(inserted).toBe(1);
  });
});

describe('A10 — right-to-erasure does not touch the audit trail', () => {
  it('nulls the embedding while every attendance and patrol record survives unchanged', async () => {
    const before = await asTenant(roles.app, { orgId: ORG_A }, async (client) => ({
      attendance: await selectRows<{ id: string; occurred_at: Date }>(
        client,
        `SELECT id, occurred_at FROM shift_attendance WHERE guard_id = $1 ORDER BY id`,
        [GUARD_A1],
      ),
      scans: await selectRows<{ id: string; occurred_at: Date }>(
        client,
        `SELECT id, occurred_at FROM patrol_scans WHERE guard_id = $1 ORDER BY id`,
        [GUARD_A1],
      ),
    }));

    expect(before.attendance.length).toBeGreaterThan(0);
    expect(before.scans.length).toBeGreaterThan(0);

    const erased = await asTenant(roles.app, { orgId: ORG_A }, async (client) => {
      const result = await client.query(
        `UPDATE guard_enrollments
            SET embedding_vector = NULL, erased_at = now()
          WHERE guard_id = $1 AND embedding_vector IS NOT NULL`,
        [GUARD_A1],
      );
      return result.rowCount;
    });
    expect(erased).toBeGreaterThan(0);

    const after = await asTenant(roles.app, { orgId: ORG_A }, async (client) => ({
      attendance: await selectRows<{ id: string; occurred_at: Date }>(
        client,
        `SELECT id, occurred_at FROM shift_attendance WHERE guard_id = $1 ORDER BY id`,
        [GUARD_A1],
      ),
      scans: await selectRows<{ id: string; occurred_at: Date }>(
        client,
        `SELECT id, occurred_at FROM patrol_scans WHERE guard_id = $1 ORDER BY id`,
        [GUARD_A1],
      ),
      remainingEmbeddings: await selectRows<{ count: string }>(
        client,
        `SELECT count(*)::text AS count FROM guard_enrollments
          WHERE guard_id = $1 AND embedding_vector IS NOT NULL`,
        [GUARD_A1],
      ),
    }));

    expect(after.attendance).toEqual(before.attendance);
    expect(after.scans).toEqual(before.scans);
    expect(Number(after.remainingEmbeddings[0]?.count)).toBe(0);
  });

  it('keeps the guard row itself — deletion is not supported at any layer', async () => {
    const guards = await asTenant(roles.app, { orgId: ORG_A }, (client) =>
      countRows(client, 'guards'),
    );
    expect(guards).toBe(2);
  });

  it('refuses an erased enrollment that still holds an embedding', async () => {
    await expect(
      asTenant(roles.app, { orgId: ORG_A }, (client) =>
        client.query(
          `UPDATE guard_enrollments SET erased_at = now(), embedding_vector = $1
             WHERE guard_id = $2`,
          [Buffer.alloc(16, 1), GUARD_A1],
        ),
      ),
    ).rejects.toThrow(/guard_enrollments_erased_implies_null/i);
  });
});
