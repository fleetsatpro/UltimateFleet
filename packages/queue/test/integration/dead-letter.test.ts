import { afterEach, describe, expect, it } from 'vitest';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { QUEUE_NAMES, createQueueFactory, type QueueFactory } from '../../src/factory.js';

/**
 * Phase 12 acceptance criterion 4: a poison-pill event lands in the dead-letter set, appears on
 * the review surface, and does not stall the queue.
 *
 * BullMQ's own failed set IS the dead-letter queue here: `defaultJobOptions.attempts: 3` bounds
 * retries (set in factory.ts), and `listFailed()` is the review surface a supervisor reads. The
 * property under test is the one that matters operationally — one job that can never succeed
 * must not block every job behind it, because a single malformed vendor payload must not take
 * down ingestion for every other event.
 */

function redisUrl(): string {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url === '') {
    throw new Error('Queue integration tests require REDIS_URL (see .env.example).');
  }
  return url;
}

const SIGNING = { current: { kid: 'k1', secret: 'dlq-test-secret' } } as const;

let factory: QueueFactory | null = null;

afterEach(async () => {
  if (factory !== null) {
    await factory.close();
    factory = null;
  }
});

function makeFactory(): QueueFactory {
  const capture = createCapturingLogger('dlq-test');
  const metrics = createMetrics();
  const alerts = createAlerts(capture.logger);
  factory = createQueueFactory({
    redisUrl: redisUrl(),
    service: 'integration-engine',
    signing: SIGNING,
    logger: capture.logger,
    metrics,
    alerts,
  });
  return factory;
}

describe('AC4 — a poison-pill job is quarantined without stalling the queue', () => {
  it('parks the failing job in the failed set, visible via listFailed, while good jobs still process', async () => {
    const qf = makeFactory();
    const queue = qf.queue<{ id: string; poison?: boolean }>(QUEUE_NAMES.mediaFetch);
    await queue.drain();

    const processed: string[] = [];
    qf.worker<{ id: string; poison?: boolean }>(
      QUEUE_NAMES.mediaFetch,
      (payload) => {
        if (payload.poison === true) {
          // Always throws: a job that can NEVER succeed, e.g. a malformed vendor payload.
          throw new Error('poison pill: malformed payload');
        }
        processed.push(payload.id);
        return Promise.resolve();
      },
      { concurrency: 2 },
    );

    // The poison pill goes in first, then good jobs right behind it.
    await queue.add(
      'poison',
      { id: 'poison-1', poison: true },
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );
    for (let i = 0; i < 5; i += 1) {
      await queue.add('good', { id: `good-${i}` });
    }

    // Good jobs must all land despite the poison pill sitting in the same queue.
    const deadline = Date.now() + 15_000;
    while (processed.length < 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(processed.sort()).toEqual(['good-0', 'good-1', 'good-2', 'good-3', 'good-4']);

    // The poison pill exhausts its retries and lands in the failed set — the review surface.
    // Filtered by job name: the queue name is shared across suites in CI, so other tests may
    // leave unrelated failed jobs behind; the poison pill's own entry is what matters here.
    const failDeadline = Date.now() + 15_000;
    let poisonEntries: Awaited<ReturnType<typeof queue.listFailed>> = [];
    while (poisonEntries.length === 0 && Date.now() < failDeadline) {
      const failed = await queue.listFailed(50);
      poisonEntries = failed.filter((f) => f.name === 'poison' && f.reason.includes('poison pill'));
      if (poisonEntries.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(poisonEntries.length).toBeGreaterThanOrEqual(1);

    // And the queue itself is not stalled: waiting and active settle to zero (allow a short
    // window for BullMQ's own bookkeeping — e.g. a lock release — to catch up).
    const settleDeadline = Date.now() + 5_000;
    let counts = await queue.counts();
    while ((counts.waiting > 0 || counts.active > 0) && Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, 100));
      counts = await queue.counts();
    }
    expect(counts.waiting).toBe(0);
    expect(counts.active).toBe(0);
  }, 40_000);
});
