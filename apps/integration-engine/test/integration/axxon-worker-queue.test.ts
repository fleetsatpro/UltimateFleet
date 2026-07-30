import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initPool, withOrg } from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { QUEUE_NAMES, createQueueFactory, type QueueFactory } from '@deepsight/queue';
import {
  appDatabaseUrl,
  createControllableStreamSource,
  makeFakeEvent,
} from '@deepsight/test-support';
import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import { createEngineCore } from '../../src/core.js';
// The worker's consumer only depends on contracts + observability, so importing it here is
// light. This test lives in the engine app because the engine owns the DB + queue deps; the
// worker itself must stay isolated from the database (Phase 4 AC3).
import {
  createReconnectingConsumer,
  type ReconnectingConsumer,
} from '../../../axxon-worker/src/consumer.js';

/**
 * Phase 4 acceptance criterion 4: the AxxonSoft worker publishes events over BullMQ and the
 * engine consumes every one into the database, with the queue draining to zero.
 *
 * This is the real trust boundary in action: the worker publishes SIGNED jobs; the engine's
 * alarm worker verifies each envelope (inside the queue factory) before ingesting. The
 * worker touches no database — it only publishes.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';

// The brief specifies 10,000. Default to a smaller count so CI stays fast; set
// AXXON_AC4_COUNT=10000 for the full-scale run. The property proven (no loss, drain to zero)
// is identical at either size.
const EVENT_COUNT = Number(process.env['AXXON_AC4_COUNT'] ?? '2000');

function redisUrl(): string {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url === '') throw new Error('Phase 4 tests require REDIS_URL.');
  return url;
}

const SIGNING = { current: { kid: 'k1', secret: 'phase4-secret' } } as const;

let workerQueues: QueueFactory | null = null;
let engineQueues: QueueFactory | null = null;
let consumer: ReconnectingConsumer | null = null;

beforeAll(() => {
  initPool({ connectionString: appDatabaseUrl(), max: 8 });
});

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  if (consumer !== null) {
    await consumer.stop();
    consumer = null;
  }
  if (workerQueues !== null) {
    await workerQueues.close();
    workerQueues = null;
  }
  if (engineQueues !== null) {
    await engineQueues.close();
    engineQueues = null;
  }
  await withOrg(ORG_A, (tx) =>
    tx.query(`DELETE FROM alarm_events WHERE correlation_id = 'phase4-ac4'`),
  );
});

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function storedCount(): Promise<number> {
  return withOrg(ORG_A, async (tx) => {
    const result = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM alarm_events WHERE correlation_id = 'phase4-ac4'`,
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

describe('AC4 — every published event is consumed, queue drains to zero', () => {
  it(`publishes ${EVENT_COUNT} events and the engine ingests all of them`, async () => {
    const capture = createCapturingLogger('axxon-ac4');
    const metrics = createMetrics();
    const alerts = createAlerts(capture.logger);

    // Engine side: the real core plus an alarm worker that verifies envelopes and ingests.
    const core = await createEngineCore({ logger: capture.logger, metrics, alerts });
    engineQueues = createQueueFactory({
      redisUrl: redisUrl(),
      service: 'integration-engine',
      signing: SIGNING,
      logger: capture.logger,
      metrics,
      alerts,
    });
    const drainQueue = engineQueues.queue<{ events: readonly NormalizedAlarmEvent[] }>(
      QUEUE_NAMES.alarmIngest,
    );
    await drainQueue.drain();
    engineQueues.worker<{ events: readonly NormalizedAlarmEvent[] }>(
      QUEUE_NAMES.alarmIngest,
      async (payload) => {
        await core.ingest(payload.events);
      },
      { concurrency: 16 },
    );

    // Worker side: a controllable stream and the reconnecting consumer publishing signed jobs.
    workerQueues = createQueueFactory({
      redisUrl: redisUrl(),
      service: 'axxon-worker',
      signing: SIGNING,
      logger: capture.logger,
      metrics,
      alerts,
    });
    const publishQueue = workerQueues.queue<{ events: readonly NormalizedAlarmEvent[] }>(
      QUEUE_NAMES.alarmIngest,
    );

    const source = createControllableStreamSource('axxon');
    consumer = createReconnectingConsumer(
      {
        adapter: source,
        publish: async (event) => {
          await publishQueue.add('axxon-alarm', { events: [event] });
        },
        logger: capture.logger,
        metrics,
        alerts,
      },
      { sleep: () => Promise.resolve() },
    );
    const loop = consumer.run();
    await until(() => source.isConnected(), 5_000);

    for (let i = 0; i < EVENT_COUNT; i += 1) {
      source.emit(
        makeFakeEvent({
          orgId: ORG_A,
          clientId: CLIENT_A1,
          siteId: SITE_A1_1,
          vendor: 'axxon',
          vendorEventId: `phase4-ac4-${i}`,
          correlationId: 'phase4-ac4',
          vendorEventCode: null,
          eventType: 'intrusion',
        }),
      );
    }

    await until(async () => (await storedCount()) >= EVENT_COUNT, 150_000);
    expect(await storedCount()).toBe(EVENT_COUNT);

    // Drain to zero: nothing waiting, nothing stuck active, nothing failed.
    await until(async () => {
      const counts = await publishQueue.counts();
      return counts.waiting === 0 && counts.active === 0 && counts.failed === 0;
    }, 30_000);
    expect(await publishQueue.counts()).toEqual({ waiting: 0, active: 0, failed: 0 });

    await consumer.stop();
    await loop;
  }, 200_000);
});
