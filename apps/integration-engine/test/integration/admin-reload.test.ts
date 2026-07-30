import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool, initPool, withGlobalConfig } from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { appDatabaseUrl } from '@deepsight/test-support';
import { createEngineCore } from '../../src/core.js';
import { createApp } from '../../src/http/app.js';

/**
 * Phase 2 acceptance criterion 4: the mapping table reloads without a process restart.
 *
 * This is the payoff of building the vendor-code mapping as database config rather than
 * hardcoded logic. A Dahua firmware update emits a code nobody has seen; a supervisor adds
 * a row; the next event is classified correctly — no redeploy, no downtime, and no window
 * during which every event of that type is misfiled.
 */

const PROBE_CODE = '77777';

beforeAll(() => {
  initPool({ connectionString: appDatabaseUrl(), max: 4 });
});

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  await withGlobalConfig((tx) =>
    tx.query(`DELETE FROM alarm_event_type_mappings WHERE vendor_code = $1`, [PROBE_CODE]),
  );
});

describe('AC4 — POST /admin/mappings/reload', () => {
  it('picks up a new mapping row with no restart, proven by an unchanged pid', async () => {
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
    });

    // Before: the probe code is unknown to the cache.
    expect(core.mappings.resolve('dahua', PROBE_CODE)).toEqual({
      event_type: 'unknown',
      severity: null,
      mapped: false,
    });

    const sizeBefore = core.mappings.size();

    await withGlobalConfig((tx) =>
      tx.query(
        `INSERT INTO alarm_event_type_mappings
           (vendor, vendor_code, normalized_type, severity_override, description)
         VALUES ('dahua', $1, 'fire', 'critical', 'probe: added at runtime')`,
        [PROBE_CODE],
      ),
    );

    // A new row alone must not change behaviour — the cache is authoritative until told
    // to reload, which is what makes reload observable rather than incidental.
    expect(core.mappings.resolve('dahua', PROBE_CODE).mapped).toBe(false);

    const response = await request(app).post('/admin/mappings/reload').expect(200);

    expect(response.body.reloaded).toBe(sizeBefore + 1);
    // Same process: no restart happened. If the only way to pick up config were a
    // redeploy, this pid would differ.
    expect(response.body.pid).toBe(process.pid);

    expect(core.mappings.resolve('dahua', PROBE_CODE)).toEqual({
      event_type: 'fire',
      severity: 'critical',
      mapped: true,
    });
  });

  it('reports mapping state and uptime on /health', async () => {
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
    });

    const response = await request(app).get('/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('integration-engine');
    expect(response.body.mappings.count).toBeGreaterThan(0);
    expect(response.body.mappings.loadedAt).not.toBeNull();
    // Per-vendor adapter health and breaker state populate this in Phase 3; the key is
    // present from now so the dashboard can rely on the shape.
    expect(response.body.vendors).toEqual([]);
  });

  it('echoes an inbound correlation id rather than starting a new trace', async () => {
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
    });

    capture.clear();
    const inbound = 'caller-supplied-correlation-id';
    const response = await request(app).get('/health').set('x-correlation-id', inbound).expect(200);

    expect(response.headers['x-correlation-id']).toBe(inbound);
    const requestLines = capture.lines().filter((line) => line['msg'] === 'http request received');
    expect(requestLines.length).toBeGreaterThan(0);
    for (const line of requestLines) expect(line['correlationId']).toBe(inbound);
  });

  it('mints a correlation id when the caller supplies none', async () => {
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
    });

    const response = await request(app).get('/health').expect(200);
    const header = response.headers['x-correlation-id'];
    expect(typeof header).toBe('string');
    expect(header).not.toBe('');
  });
});
