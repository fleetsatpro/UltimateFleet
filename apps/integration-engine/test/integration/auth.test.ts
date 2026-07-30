import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import { closePool, initPool, insertUser, withOrg, type TenantTransaction } from '@deepsight/db';
import { createSessionStore, generateScopedToken, hashPassword } from '@deepsight/auth';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { appDatabaseUrl } from '@deepsight/test-support';
import { createEngineCore } from '../../src/core.js';
import { createApp } from '../../src/http/app.js';
import { ADMIN_ROUTE_PATHS, createAuthRouter } from '../../src/http/auth/routes.js';

/**
 * Phase 7 acceptance suite (dashboard + guard auth). Session revocation, enrollment single-use,
 * refresh-family reuse detection, RBAC-per-route and the RLS/RBAC redundancy are all exercised
 * end to end against real PostgreSQL and Redis.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const ORG_B = '0b000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const GUARD_A1 = '0a000000-0000-4000-8000-000000000a01';
// A guard created just for these tests, with NO seeded enrollment, so the one-active-enrollment
// -per-guard index does not collide when we enroll a device against it.
const AUTH_GUARD = '0a000000-0000-4000-8000-000000000af7';
const SOME_UUID = '0a000000-0000-4000-8000-00000000dead';
const GUARD_SECRET = 'guard-access-secret-0123456789';

const USERS = {
  adminA: {
    email: 'authtest-admin-a@test',
    password: 'pw-admin-a-123456',
    role: 'admin',
    org: ORG_A,
    client: null,
  },
  supA: {
    email: 'authtest-sup-a@test',
    password: 'pw-sup-a-123456',
    role: 'supervisor',
    org: ORG_A,
    client: null,
  },
  viewerA: {
    email: 'authtest-viewer-a@test',
    password: 'pw-viewer-a-123',
    role: 'report_viewer',
    org: ORG_A,
    client: CLIENT_A1,
  },
  supB: {
    email: 'authtest-sup-b@test',
    password: 'pw-sup-b-123456',
    role: 'supervisor',
    org: ORG_B,
    client: null,
  },
} as const;

function redis(): Redis {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url === '') throw new Error('Phase 7 tests require REDIS_URL.');
  return new Redis(url, { maxRetriesPerRequest: null });
}

let redisClient: Redis;

async function buildApp(overrides?: { enrollmentTtlSeconds?: number }) {
  const capture = createCapturingLogger('auth-test');
  const metrics = createMetrics();
  const alerts = createAlerts(capture.logger);
  const core = await createEngineCore({ logger: capture.logger, metrics, alerts });
  const authRouter = createAuthRouter({
    sessionStore: createSessionStore(redisClient),
    guardAccessSecret: GUARD_SECRET,
    logger: capture.logger,
    metrics,
    alerts,
    secureCookies: false,
    ...(overrides?.enrollmentTtlSeconds !== undefined
      ? { enrollmentTtlSeconds: overrides.enrollmentTtlSeconds }
      : {}),
  });
  return createApp({
    logger: capture.logger,
    metrics,
    alerts,
    mappings: core.mappings,
    startedAt: new Date(),
    authRouter,
  });
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  user: { email: string; password: string },
) {
  const agent = request.agent(app);
  await agent
    .post('/dashboard/login')
    .send({ email: user.email, password: user.password })
    .expect(200);
  return agent;
}

beforeAll(async () => {
  initPool({ connectionString: appDatabaseUrl(), max: 6 });
  redisClient = redis();
  // Provision the four test users, each with a real Argon2id hash.
  for (const u of Object.values(USERS)) {
    const passwordHash = await hashPassword(u.password);
    await withOrg(u.org, (tx) =>
      insertUser(tx, {
        orgId: u.org,
        email: u.email,
        passwordHash,
        role: u.role,
        clientId: u.client,
      }),
    );
  }
  // A dedicated, un-enrolled guard for the enrollment/refresh flows.
  await withOrg(ORG_A, (tx) =>
    tx.query(
      `INSERT INTO guards (id, org_id, full_name, employee_code) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [AUTH_GUARD, ORG_A, 'Auth Test Guard', 'AUTH-G7'],
    ),
  );
});

afterAll(async () => {
  await withOrg(ORG_A, (tx) => tx.query(`DELETE FROM guards WHERE id = $1`, [AUTH_GUARD]));
  for (const u of Object.values(USERS)) {
    await withOrg(u.org, (tx) => tx.query(`DELETE FROM users WHERE email = $1`, [u.email]));
  }
  redisClient.disconnect();
  await closePool();
});

async function cleanupArtifacts(tx: TenantTransaction): Promise<void> {
  // FK-safe order, scoped to the test markers so seeded rows are untouched.
  await tx.query(`DELETE FROM device_refresh_tokens WHERE family_id IN
                    (SELECT id FROM refresh_families WHERE device_id LIKE 'authtest-%')`);
  await tx.query(`DELETE FROM refresh_families WHERE device_id LIKE 'authtest-%'`);
  await tx.query(`DELETE FROM guard_enrollments WHERE device_id LIKE 'authtest-%'`);
  await tx.query(`DELETE FROM enrollment_tokens WHERE created_by IN
                    (SELECT id FROM users WHERE email LIKE 'authtest-%')`);
}

afterEach(async () => {
  await withOrg(ORG_A, cleanupArtifacts);
  await withOrg(ORG_B, cleanupArtifacts);
});

describe('AC5 — dashboard logout invalidates the session server-side', () => {
  it('rejects the same cookie immediately after logout', async () => {
    const app = await buildApp();
    const agent = await login(app, USERS.adminA);

    await agent.get(`/dashboard/clients/${CLIENT_A1}`).expect(200);
    await agent.post('/dashboard/logout').expect(204);
    // The very next request with the same cookie is 401 — the session is gone from Redis, not
    // merely "expiring eventually". A stateless JWT could not do this.
    await agent.get(`/dashboard/clients/${CLIENT_A1}`).expect(401);
  });

  it('rejects bad credentials and unknown emails alike with 401', async () => {
    const app = await buildApp();
    await request(app)
      .post('/dashboard/login')
      .send({ email: USERS.adminA.email, password: 'wrong' })
      .expect(401);
    await request(app)
      .post('/dashboard/login')
      .send({ email: 'nobody@test', password: 'whatever' })
      .expect(401);
  });
});

describe('AC6 — RBAC and RLS are independently sufficient across orgs', () => {
  it('denies a supervisor in org B any org A resource, and the query itself returns zero rows', async () => {
    const app = await buildApp();
    const agentB = await login(app, USERS.supB);
    // Org A's client is not found under org B's session — 404, via RLS, not a route allowlist.
    await agentB.get(`/dashboard/clients/${CLIENT_A1}`).expect(404);

    // Independent proof: even bypassing the route entirely, the query under org B returns zero
    // rows for org A's client. RLS holds without RBAC's help.
    const rows = await withOrg(ORG_B, (tx) =>
      tx.query(`SELECT id FROM clients WHERE id = $1`, [CLIENT_A1]),
    );
    expect(rows.rowCount).toBe(0);
  });
});

describe('AC4 — every admin route is role-guarded (table-driven)', () => {
  it('returns 403 to a report_viewer on each admin route, and lets a supervisor through', async () => {
    const app = await buildApp();
    const viewer = await login(app, USERS.viewerA);
    const supervisor = await login(app, USERS.supA);

    for (const path of ADMIN_ROUTE_PATHS) {
      const concrete = path.replace(':enrollmentId', SOME_UUID);
      // report_viewer is forbidden on every admin route — asserted per route, so a new route
      // added to the table without a role list would fail here.
      await viewer.post(concrete).send({}).expect(403);
      // A supervisor is NOT forbidden (may be 201/400/404 depending on body, never 403).
      const res = await supervisor.post(concrete).send({ guardId: GUARD_A1, clientId: CLIENT_A1 });
      expect(res.status).not.toBe(403);
    }
  });
});

describe('AC1 — enrollment tokens are single-use and time-limited', () => {
  it('redeems once, then returns 410 on a second redemption', async () => {
    const app = await buildApp();
    const supervisor = await login(app, USERS.supA);
    const created = await supervisor
      .post('/admin/enrollments')
      .send({ guardId: AUTH_GUARD, clientId: CLIENT_A1 })
      .expect(201);
    const token = created.body.token as string;
    expect(typeof token).toBe('string');

    const enrolled = await request(app)
      .post('/guard/enroll')
      .send({ token, deviceId: 'authtest-dev-1' })
      .expect(201);
    expect(typeof enrolled.body.accessToken).toBe('string');
    expect(typeof enrolled.body.refreshToken).toBe('string');

    // Single-use: the same token cannot be redeemed again.
    await request(app)
      .post('/guard/enroll')
      .send({ token, deviceId: 'authtest-dev-1' })
      .expect(410);
  });

  it('returns 410 for an expired token', async () => {
    const app = await buildApp();
    // Store a token that is already expired, then try to redeem it.
    const scoped = generateScopedToken(ORG_A);
    await withOrg(ORG_A, (tx) =>
      tx.query(
        `INSERT INTO enrollment_tokens (org_id, client_id, guard_id, token_hash, created_by, expires_at)
         VALUES ($1, $2, $3, $4, (SELECT id FROM users WHERE email = $5), now() - interval '1 minute')`,
        [ORG_A, CLIENT_A1, AUTH_GUARD, scoped.hash, USERS.supA.email],
      ),
    );
    await request(app)
      .post('/guard/enroll')
      .send({ token: scoped.plaintext, deviceId: 'authtest-dev-exp' })
      .expect(410);
  });
});

describe('AC2 — revoking an enrollment fails the next refresh and kills the family', () => {
  it('rejects refresh after the enrollment is revoked', async () => {
    const app = await buildApp();
    const supervisor = await login(app, USERS.supA);
    const created = await supervisor
      .post('/admin/enrollments')
      .send({ guardId: AUTH_GUARD, clientId: CLIENT_A1 })
      .expect(201);
    const enrolled = await request(app)
      .post('/guard/enroll')
      .send({ token: created.body.token, deviceId: 'authtest-dev-2' })
      .expect(201);

    const enrollmentId = await withOrg(ORG_A, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `SELECT id FROM guard_enrollments WHERE device_id = 'authtest-dev-2'`,
      );
      return r.rows[0]!.id;
    });

    await supervisor.post(`/admin/enrollments/${enrollmentId}/revoke`).expect(204);

    // The next refresh fails, and the family is dead: a second attempt fails too.
    await request(app)
      .post('/guard/refresh')
      .send({ refreshToken: enrolled.body.refreshToken })
      .expect(401);
    await request(app)
      .post('/guard/refresh')
      .send({ refreshToken: enrolled.body.refreshToken })
      .expect(401);
  });
});

describe('AC3 — replaying a consumed refresh token invalidates the whole family', () => {
  it('detects reuse and locks out both the attacker and the legitimate token', async () => {
    const app = await buildApp();
    const supervisor = await login(app, USERS.supA);
    const created = await supervisor
      .post('/admin/enrollments')
      .send({ guardId: AUTH_GUARD, clientId: CLIENT_A1 })
      .expect(201);
    const enrolled = await request(app)
      .post('/guard/enroll')
      .send({ token: created.body.token, deviceId: 'authtest-dev-3' })
      .expect(201);
    const r0 = enrolled.body.refreshToken as string;

    // Normal rotation: r0 -> r1. r0 is now consumed.
    const rotated = await request(app)
      .post('/guard/refresh')
      .send({ refreshToken: r0 })
      .expect(200);
    const r1 = rotated.body.refreshToken as string;

    // Replay of the consumed r0 revokes the family.
    await request(app).post('/guard/refresh').send({ refreshToken: r0 }).expect(401);

    // The legitimate r1 is now dead too — the family is gone, forcing re-provisioning.
    await request(app).post('/guard/refresh').send({ refreshToken: r1 }).expect(401);
  });
});
