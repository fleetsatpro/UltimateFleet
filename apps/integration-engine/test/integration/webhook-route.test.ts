import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { closePool, initPool, withOrg } from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import {
  appDatabaseUrl,
  createFakeWebhookAdapter,
  makeFakeEvent,
  resetFakeEventIds,
  signFakeWebhook,
  FAKE_SIGNATURE_HEADER,
} from '@deepsight/test-support';
import type { VendorId, WebhookAlarmAdapter } from '@deepsight/contracts';
import { createEngineCore } from '../../src/core.js';
import { createApp } from '../../src/http/app.js';
import { createWebhookHandler } from '../../src/http/webhook.js';

/**
 * Phase 3 acceptance criterion 5: the webhook route accepts a validly-signed body, rejects
 * a one-byte-changed body with 401, and — the regression that matters — a body routed
 * through express.json() fails verification because the raw bytes are gone (divergence D4).
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';

beforeAll(() => {
  initPool({ connectionString: appDatabaseUrl(), max: 4 });
});

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  await withOrg(ORG_A, (tx) =>
    tx.query(`DELETE FROM alarm_events WHERE correlation_id LIKE 'phase3-%'`),
  );
  resetFakeEventIds();
});

async function buildAppWithWebhookAdapter(adapter: WebhookAlarmAdapter) {
  const capture = createCapturingLogger('webhook-test');
  const metrics = createMetrics();
  const alerts = createAlerts(capture.logger);
  const core = await createEngineCore({ logger: capture.logger, metrics, alerts });

  // Inject the fake webhook adapter in place of the (unverified) real Dahua one, keeping
  // the rest of the wiring — the real dispatch, mapping cache and persistence.
  const adapters = new Map<VendorId, WebhookAlarmAdapter>([['dahua', adapter]]);
  const webhooks = createWebhookHandler({
    adapters,
    dispatch: core.dispatch,
    logger: capture.logger,
    metrics,
    alerts,
  });

  const app = createApp({
    logger: capture.logger,
    metrics,
    alerts,
    mappings: core.mappings,
    startedAt: new Date(),
    webhooks,
    vendorHealth: core.vendorHealth,
  });
  return { app, adapter };
}

function signedBody() {
  const body = Buffer.from(
    JSON.stringify({
      events: [
        makeFakeEvent({
          orgId: ORG_A,
          clientId: CLIENT_A1,
          siteId: SITE_A1_1,
          vendorEventId: 'phase3-webhook-1',
          correlationId: 'phase3-webhook',
          vendorEventCode: '1001',
        }),
      ],
    }),
    'utf8',
  );
  return { body, signature: signFakeWebhook(body) };
}

describe('AC5 — webhook route over the real HTTP surface', () => {
  it('accepts a validly-signed delivery and persists the event', async () => {
    const fake = createFakeWebhookAdapter('dahua');
    const { app } = await buildAppWithWebhookAdapter(fake);
    const { body, signature } = signedBody();

    const response = await request(app)
      .post('/webhooks/dahua')
      .set(FAKE_SIGNATURE_HEADER, signature)
      .set('content-type', 'application/json')
      // Send the raw JSON string, exactly as a vendor would: passing a Buffer with a JSON
      // content-type makes superagent re-encode it to {"type":"Buffer",...}, changing the
      // bytes — itself a small demonstration of why raw-byte fidelity matters here.
      .send(body.toString('utf8'))
      .expect(202);

    expect(response.body.accepted).toBe(true);
    expect(response.body.persisted).toBe(1);
    expect(fake.handled).toHaveLength(1);

    const stored = await withOrg(ORG_A, async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM alarm_events WHERE vendor_event_id = $1`,
        ['phase3-webhook-1'],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
    expect(stored).toBe(1);
  });

  it('rejects a one-byte-changed body with 401 and never reaches handleWebhook', async () => {
    const fake = createFakeWebhookAdapter('dahua');
    const { app } = await buildAppWithWebhookAdapter(fake);
    const { body, signature } = signedBody();

    const tampered = Buffer.from(body);
    // Flip one byte in the middle so the JSON stays superficially plausible.
    const idx = Math.floor(tampered.length / 2);
    tampered[idx] = tampered[idx] === 0x20 ? 0x21 : 0x20;

    await request(app)
      .post('/webhooks/dahua')
      .set(FAKE_SIGNATURE_HEADER, signature) // signature of the ORIGINAL body
      .set('content-type', 'application/json')
      .send(tampered.toString('utf8'))
      .expect(401);

    // The forged body was never parsed — signature verification runs first, on raw bytes.
    expect(fake.handled).toHaveLength(0);
  });

  it('returns 501 for the real, unverified Dahua adapter', async () => {
    // The default core wires the real DahuaAdapter, whose verifySignature throws
    // UNVERIFIED_VENDOR_CONTRACT. The route must surface that as 501 Not Implemented, never
    // as a silent acceptance.
    const capture = createCapturingLogger('webhook-test');
    const metrics = createMetrics();
    const alerts = createAlerts(capture.logger);
    const core = await createEngineCore({ logger: capture.logger, metrics, alerts });
    const app = createApp({
      logger: capture.logger,
      metrics,
      alerts,
      mappings: core.mappings,
      startedAt: new Date(),
      webhooks: core.webhooks,
      vendorHealth: core.vendorHealth,
    });

    const response = await request(app)
      .post('/webhooks/dahua')
      .set('content-type', 'application/json')
      .send('{}')
      .expect(501);
    expect(response.body.error).toMatch(/UNVERIFIED_VENDOR_CONTRACT/);
  });

  it('REGRESSION: express.raw accepts what express.json rejects, for identical bytes', async () => {
    // The exact one-line mistake divergence D4 exists to prevent. The signed body is
    // PRETTY-PRINTED, so its exact bytes carry whitespace that a compact re-serialisation
    // does not reproduce — which is precisely how a real vendor's formatting differs from a
    // naive receiver's JSON.stringify.
    const fake = createFakeWebhookAdapter('dahua');
    const pretty = Buffer.from(
      JSON.stringify({ events: [], note: 'formatted with whitespace' }, null, 2),
      'utf8',
    );
    const signature = signFakeWebhook(pretty);

    // A route that re-serialises the parsed body (the bug) computes the HMAC over compact
    // bytes that differ from what was signed, so verification FAILS.
    const brokenApp = express();
    brokenApp.post('/w', express.json(), (req, res) => {
      const reserialized = Buffer.from(JSON.stringify(req.body), 'utf8');
      const verdict = fake.verifySignature(reserialized, { [FAKE_SIGNATURE_HEADER]: signature });
      res.status(verdict.ok ? 202 : 401).json(verdict);
    });
    await request(brokenApp)
      .post('/w')
      .set(FAKE_SIGNATURE_HEADER, signature)
      .set('content-type', 'application/json')
      .send(pretty.toString('utf8'))
      .expect(401);

    // A route that preserves raw bytes (express.raw, as the real route does) verifies the
    // very same delivery successfully.
    const rawApp = express();
    rawApp.post('/w', express.raw({ type: '*/*' }), (req, res) => {
      const raw: Uint8Array = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const verdict = fake.verifySignature(raw, { [FAKE_SIGNATURE_HEADER]: signature });
      res.status(verdict.ok ? 202 : 401).json(verdict);
    });
    await request(rawApp)
      .post('/w')
      .set(FAKE_SIGNATURE_HEADER, signature)
      .set('content-type', 'application/json')
      .send(pretty.toString('utf8'))
      .expect(202);
  });

  it('reports vendors with breaker state on /health', async () => {
    const fake = createFakeWebhookAdapter('dahua');
    const { app } = await buildAppWithWebhookAdapter(fake);
    const response = await request(app).get('/health').expect(200);

    const vendors = response.body.vendors as { vendor: string; breaker_state: string }[];
    expect(vendors.map((v) => v.vendor).sort()).toEqual(['axxon', 'dahua', 'guardtek']);
    for (const v of vendors) expect(v.breaker_state).toBe('closed');
  });
});
