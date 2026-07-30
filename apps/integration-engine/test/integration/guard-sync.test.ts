import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { closePool, initPool, insertAlarmEvent, withOrg } from '@deepsight/db';
import { signGuardAccessToken } from '@deepsight/auth';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { appDatabaseUrl, makeFakeEvent } from '@deepsight/test-support';
import { createEngineCore } from '../../src/core.js';
import { createApp } from '../../src/http/app.js';
import { createSyncRouter } from '../../src/http/sync/routes.js';

/**
 * Phase 8 acceptance suite for the guard sync ENDPOINT — the server side of the offline app.
 * Idempotency, exactly-once landing, append-only conflict, and server-authoritative geofencing
 * are all asserted here; the on-device pieces (offline UI, keystore, WatermelonDB migration) are
 * the frontend track.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const GUARD_A1 = '0a000000-0000-4000-8000-000000000a01';
const GUARD_SECRET = 'guard-access-secret-0123456789';
const SYNC_SITE = '0a000000-0000-4000-8000-0000000005e7';
const SYNC_CHECKPOINT = '0a000000-0000-4000-8000-0000000005c8';
const ALARMS = [randomUUID(), randomUUID(), randomUUID()];

function tokenFor(deviceId: string): Promise<string> {
  return signGuardAccessToken(
    { guardId: GUARD_A1, orgId: ORG_A, clientId: CLIENT_A1, deviceId, enrollmentId: randomUUID() },
    GUARD_SECRET,
    3_600,
  );
}

async function buildApp() {
  const capture = createCapturingLogger('sync-test');
  const metrics = createMetrics();
  const alerts = createAlerts(capture.logger);
  const core = await createEngineCore({ logger: capture.logger, metrics, alerts });
  const syncRouter = createSyncRouter({
    guardAccessSecret: GUARD_SECRET,
    logger: capture.logger,
    metrics,
    alerts,
  });
  return createApp({
    logger: capture.logger,
    metrics,
    alerts,
    mappings: core.mappings,
    startedAt: new Date(),
    syncRouter,
  });
}

beforeAll(async () => {
  initPool({ connectionString: appDatabaseUrl(), max: 4 });
  await withOrg(ORG_A, async (tx) => {
    // A test site at the origin with a 100 m radius, plus a checkpoint, so patrols/attendance
    // have real FKs and the geofence maths has known coordinates.
    await tx.query(
      `INSERT INTO sites (id, org_id, client_id, name, latitude, longitude, geofence_radius_m)
       VALUES ($1, $2, $3, 'Sync Test Site', 0, 0, 100) ON CONFLICT (id) DO NOTHING`,
      [SYNC_SITE, ORG_A, CLIENT_A1],
    );
    await tx.query(
      `INSERT INTO patrol_checkpoints (id, org_id, client_id, site_id, label, qr_code)
       VALUES ($1, $2, $3, $4, 'CP-1', 'QR-SYNC-1') ON CONFLICT (id) DO NOTHING`,
      [SYNC_CHECKPOINT, ORG_A, CLIENT_A1, SYNC_SITE],
    );
  });
  // Three alarm events for closures to reference.
  for (const id of ALARMS) {
    await withOrg(ORG_A, (tx) =>
      insertAlarmEvent(
        tx,
        makeFakeEvent({
          orgId: ORG_A,
          clientId: CLIENT_A1,
          siteId: SYNC_SITE,
          vendor: 'axxon',
          vendorEventId: `phase8-${id}`,
          internalId: id,
          correlationId: 'phase8',
        }),
      ),
    );
  }
});

afterAll(async () => {
  await withOrg(ORG_A, async (tx) => {
    await tx.query(`DELETE FROM alarm_closures WHERE device_id LIKE 'sync-dev%'`);
    await tx.query(`DELETE FROM patrol_scans WHERE device_id LIKE 'sync-dev%'`);
    await tx.query(`DELETE FROM shift_attendance WHERE device_id LIKE 'sync-dev%'`);
    await tx.query(`DELETE FROM alarm_events WHERE correlation_id = 'phase8'`);
    await tx.query(`DELETE FROM patrol_checkpoints WHERE id = $1`, [SYNC_CHECKPOINT]);
    await tx.query(`DELETE FROM sites WHERE id = $1`, [SYNC_SITE]);
  });
  await closePool();
});

async function countByDevice(deviceId: string): Promise<number> {
  return withOrg(ORG_A, async (tx) => {
    const q = async (table: string): Promise<number> => {
      const r = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE device_id = $1`,
        [deviceId],
      );
      return Number(r.rows[0]?.n ?? '0');
    };
    return (await q('shift_attendance')) + (await q('patrol_scans')) + (await q('alarm_closures'));
  });
}

/** A full 12-hour shift's worth of events: 1 sign-in, 20 patrols, 3 closures = 24. */
function fullShift() {
  return {
    attendance: [
      {
        client_event_id: randomUUID(),
        site_id: SYNC_SITE,
        event_type: 'sign_in',
        occurred_at: '2026-07-01T08:00:00Z',
        gps_latitude: 0.0001,
        gps_longitude: 0,
      },
    ],
    patrols: Array.from({ length: 20 }, (_, i) => ({
      client_event_id: randomUUID(),
      site_id: SYNC_SITE,
      checkpoint_id: SYNC_CHECKPOINT,
      scan_method: i % 2 === 0 ? 'qr' : 'nfc',
      occurred_at: `2026-07-01T${String(8 + Math.floor(i / 4)).padStart(2, '0')}:0${i % 6}:00Z`,
    })),
    closures: ALARMS.map((alarmId) => ({
      client_event_id: randomUUID(),
      alarm_event_id: alarmId,
      occurred_at: '2026-07-01T12:00:00Z',
      notes: 'cleared on patrol',
    })),
  };
}

describe('AC1 + AC2 — a shift lands exactly once, and a retried push changes nothing', () => {
  it('accepts 24 events, then reports all 24 as duplicates on replay', async () => {
    const app = await buildApp();
    const device = 'sync-dev-shift';
    const token = await tokenFor(device);
    const body = fullShift();

    const first = await request(app)
      .post('/guard/sync/push')
      .set('authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);
    expect(first.body).toEqual({ accepted: 24, duplicates: 0, rejected: 0 });
    expect(await countByDevice(device)).toBe(24);

    // The exact same push again (a retry after a lost response): nothing new lands.
    const retry = await request(app)
      .post('/guard/sync/push')
      .set('authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);
    expect(retry.body).toEqual({ accepted: 0, duplicates: 24, rejected: 0 });
    expect(await countByDevice(device)).toBe(24);
  });

  it('rejects a push with no access token', async () => {
    const app = await buildApp();
    await request(app).post('/guard/sync/push').send({ attendance: [] }).expect(401);
  });
});

describe('AC3 — two devices’ overlapping sign-ins both persist (append-only)', () => {
  it('keeps both sign-ins, neither overwriting the other', async () => {
    const app = await buildApp();
    const signIn = () => ({
      attendance: [
        {
          client_event_id: randomUUID(),
          site_id: SYNC_SITE,
          event_type: 'sign_in',
          occurred_at: '2026-07-02T08:00:00Z',
          gps_latitude: 0.0001,
          gps_longitude: 0,
        },
      ],
    });
    for (const device of ['sync-dev-a', 'sync-dev-b']) {
      await request(app)
        .post('/guard/sync/push')
        .set('authorization', `Bearer ${await tokenFor(device)}`)
        .send(signIn())
        .expect(200);
    }
    // Both devices' events exist for the same guard — nothing was overwritten.
    const total = await withOrg(ORG_A, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM shift_attendance
          WHERE guard_id = $1 AND device_id IN ('sync-dev-a','sync-dev-b')`,
        [GUARD_A1],
      );
      return Number(r.rows[0]?.n ?? '0');
    });
    expect(total).toBe(2);
  });
});

describe('AC4 — a sign-in outside the geofence persists, flagged, with the distance', () => {
  it('stores geofence_violation and the distance, never dropping the event', async () => {
    const app = await buildApp();
    const device = 'sync-dev-geo';
    const clientEventId = randomUUID();
    await request(app)
      .post('/guard/sync/push')
      .set('authorization', `Bearer ${await tokenFor(device)}`)
      .send({
        attendance: [
          {
            client_event_id: clientEventId,
            site_id: SYNC_SITE,
            event_type: 'sign_in',
            occurred_at: '2026-07-03T08:00:00Z',
            gps_latitude: 0.0045, // ~500 m from the origin site
            gps_longitude: 0,
          },
        ],
      })
      .expect(200);

    const row = await withOrg(ORG_A, async (tx) => {
      const r = await tx.query<{ geofence_violation: boolean; geofence_distance_m: number | null }>(
        `SELECT geofence_violation, geofence_distance_m FROM shift_attendance
          WHERE device_id = $1 AND client_event_id = $2`,
        [device, clientEventId],
      );
      return r.rows[0];
    });
    expect(row?.geofence_violation).toBe(true);
    expect(row?.geofence_distance_m ?? 0).toBeGreaterThan(450);
  });
});
