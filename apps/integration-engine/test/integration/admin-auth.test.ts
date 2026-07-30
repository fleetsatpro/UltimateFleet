import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool, initPool } from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { appDatabaseUrl } from '@deepsight/test-support';
import { createEngineCore } from '../../src/core.js';
import { createApp } from '../../src/http/app.js';

/**
 * The /admin surface can change how every incoming alarm is classified, so it must never be
 * reachable unauthenticated — including in the window before Phase 7 brings supervisor
 * sessions and RBAC. "Auth comes later" must not mean "open until then".
 */

const ADMIN_TOKEN = 'test-admin-token-0123456789';

async function buildApp(adminToken?: string) {
  const capture = createCapturingLogger('integration-engine-test');
  const metrics = createMetrics();
  const alerts = createAlerts(capture.logger);
  const core = await createEngineCore({ logger: capture.logger, metrics, alerts });
  const app = createApp({
    logger: capture.logger,
    metrics,
    alerts,
    mappings: core.mappings,
    startedAt: new Date(),
    ...(adminToken !== undefined ? { adminToken } : {}),
  });
  return { app, metrics };
}

beforeAll(() => {
  initPool({ connectionString: appDatabaseUrl(), max: 4 });
});

afterAll(async () => {
  await closePool();
});

describe('admin routes fail closed', () => {
  it('refuses to serve at all when no token is configured', async () => {
    const { app } = await buildApp(undefined);

    // 503, not 200. A config omission must not silently expose an admin mutation endpoint,
    // which is the failure mode that turns "we will add auth in Phase 7" into an incident.
    const response = await request(app).post('/admin/mappings/reload').expect(503);
    expect(response.body.error).toMatch(/ADMIN_API_TOKEN is not configured/);
  });

  it('rejects a missing bearer token', async () => {
    const { app, metrics } = await buildApp(ADMIN_TOKEN);
    await request(app).post('/admin/mappings/reload').expect(401);
    expect(metrics.snapshot().some((s) => s.name === 'admin_unauthorized_total')).toBe(true);
  });

  it('rejects a wrong token', async () => {
    const { app } = await buildApp(ADMIN_TOKEN);
    await request(app)
      .post('/admin/mappings/reload')
      .set('authorization', 'Bearer wrong-token-0123456789xx')
      .expect(401);
  });

  it('rejects a token of the right length but wrong content', async () => {
    // Guards the constant-time comparison: a length-only check would let this through.
    const sameLengthWrong = 'X'.repeat(ADMIN_TOKEN.length);
    const { app } = await buildApp(ADMIN_TOKEN);
    await request(app)
      .post('/admin/mappings/reload')
      .set('authorization', `Bearer ${sameLengthWrong}`)
      .expect(401);
  });

  it('rejects a non-Bearer authorization scheme', async () => {
    const { app } = await buildApp(ADMIN_TOKEN);
    await request(app)
      .post('/admin/mappings/reload')
      .set('authorization', `Basic ${ADMIN_TOKEN}`)
      .expect(401);
  });

  it('accepts the configured token', async () => {
    const { app } = await buildApp(ADMIN_TOKEN);
    const response = await request(app)
      .post('/admin/mappings/reload')
      .set('authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    expect(response.body.reloaded).toBeGreaterThan(0);
  });

  it('leaves read-only routes open, since they carry no tenant data', async () => {
    const { app } = await buildApp(undefined);
    await request(app).get('/health').expect(200);
    await request(app).get('/metrics').expect(200);
  });
});
