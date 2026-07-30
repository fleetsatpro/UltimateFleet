import { afterEach, describe, expect, it } from 'vitest';
import {
  createAlerts,
  createCapturingLogger,
  createMetrics,
  type Metrics,
} from '@deepsight/observability';
import { createControllableStreamSource, makeFakeEvent } from '@deepsight/test-support';
import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import {
  createReconnectingConsumer,
  decorrelatedJitter,
  type ReconnectingConsumer,
} from '../../src/consumer.js';

/**
 * Phase 4 acceptance criteria 1, 2, 5 and 6, at the consumer level (no Redis needed — the
 * publish function is injected, so these are fast and deterministic).
 *
 *   AC1: reconnect after an outage, losing no events across the window.
 *   AC2: reconnect intervals are jittered, with the FIRST retry already jittered.
 *   AC5: a shutdown drains in-flight publishes.
 *   AC6: the onAlarm listener count stays at 1 across many reconnects (no leak).
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';

function event(id: string): NormalizedAlarmEvent {
  return makeFakeEvent({
    orgId: ORG_A,
    clientId: CLIENT_A1,
    siteId: SITE_A1_1,
    vendor: 'axxon',
    vendorEventId: id,
    correlationId: 'phase4',
  });
}

/**
 * A near-instant sleep that still yields a MACROTASK. This matters whenever the stream can
 * fail its connect synchronously (an "endpoint down" phase): a microtask-only sleep would
 * let the reconnect loop spin without ever yielding to the test's setTimeout-based polling,
 * starving it. Yielding a macrotask keeps the loop fast but cooperative.
 */
const yieldingSleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let running: ReconnectingConsumer | null = null;
afterEach(async () => {
  if (running !== null) {
    await running.stop();
    running = null;
  }
});

function deps(published: NormalizedAlarmEvent[], metrics: Metrics) {
  const logger = createCapturingLogger('axxon-consumer-test');
  return {
    logger: logger.logger,
    metrics,
    alerts: createAlerts(logger.logger),
    publish: (e: NormalizedAlarmEvent) => {
      published.push(e);
      return Promise.resolve();
    },
  };
}

describe('AC6 — the listener count never exceeds 1 across many reconnects', () => {
  it('stays at 0 or 1 across 50 reconnects', async () => {
    const source = createControllableStreamSource('axxon');
    const published: NormalizedAlarmEvent[] = [];
    const metrics = createMetrics();
    const consumer = createReconnectingConsumer(
      { adapter: source, ...deps(published, metrics) },
      { sleep: yieldingSleep, random: () => 0.5 },
    );
    running = consumer;

    const loop = consumer.run();

    let maxListeners = 0;
    for (let i = 0; i < 50; i += 1) {
      // Wait until connected, record the listener count, then drop the stream.
      await waitFor(() => source.isConnected());
      maxListeners = Math.max(maxListeners, consumer.listenerCount());
      source.disconnect();
      // Let the reconnect loop come back around.
      await tick();
    }

    // The leak this guards against: `on(): this` would leave a handler behind on every
    // reconnect. Here the count is exactly 1 while connected, 0 between.
    expect(maxListeners).toBe(1);
    expect(consumer.reconnectCount()).toBeGreaterThanOrEqual(50);

    await consumer.stop();
    await loop;
    expect(consumer.listenerCount()).toBe(0);
  });
});

describe('AC1 — reconnect after an outage without losing events', () => {
  it('keeps publishing after the endpoint goes down and recovers', async () => {
    const source = createControllableStreamSource('axxon');
    const published: NormalizedAlarmEvent[] = [];
    const metrics = createMetrics();
    const consumer = createReconnectingConsumer(
      { adapter: source, ...deps(published, metrics) },
      { sleep: yieldingSleep, random: () => 0.5 },
    );
    running = consumer;
    const loop = consumer.run();

    await waitFor(() => source.isConnected());
    source.emit(event('phase4-before-1'));
    source.emit(event('phase4-before-2'));

    // Outage: the endpoint goes down and every reconnect fails for a while.
    source.setDown(true);
    source.disconnect();
    const attemptsAtOutage = source.connectAttempts();
    await waitFor(() => source.connectAttempts() > attemptsAtOutage + 3);

    // Recovery.
    source.setDown(false);
    await waitFor(() => source.isConnected());
    source.emit(event('phase4-after-1'));
    source.emit(event('phase4-after-2'));

    await consumer.stop();
    await loop;

    // Nothing published during the outage (nothing was emitted then), and events before and
    // after the outage all made it through — the reconnect lost nothing.
    const ids = published.map((e) => e.vendor_event_id).sort();
    expect(ids).toEqual(['phase4-after-1', 'phase4-after-2', 'phase4-before-1', 'phase4-before-2']);
    expect(consumer.reconnectCount()).toBeGreaterThan(3);
  });
});

describe('AC2 — reconnect intervals are jittered from the first retry', () => {
  it('decorrelatedJitter never returns a fixed sequence', () => {
    // Two runs with different randomness must diverge immediately — including the FIRST
    // interval. A plain exponential backoff would be identical run to run.
    const base = 500;
    const cap = 30_000;
    const seqA: number[] = [];
    const seqB: number[] = [];
    let a = base;
    let b = base;
    const randA = mulberry32(1);
    const randB = mulberry32(2);
    for (let i = 0; i < 10; i += 1) {
      a = decorrelatedJitter(a, base, cap, randA);
      b = decorrelatedJitter(b, base, cap, randB);
      seqA.push(a);
      seqB.push(b);
    }
    // First interval already differs (jitter from the first retry, not after it).
    expect(seqA[0]).not.toBe(seqB[0]);
    // And the whole sequences differ.
    expect(seqA).not.toEqual(seqB);
    // Stays within [base, cap].
    for (const v of [...seqA, ...seqB]) {
      expect(v).toBeGreaterThanOrEqual(base);
      expect(v).toBeLessThanOrEqual(cap);
    }
  });

  it('produces non-uniform real backoff intervals across reconnects', async () => {
    const source = createControllableStreamSource('axxon');
    source.setDown(true); // every connect fails, forcing backoff each time
    const published: NormalizedAlarmEvent[] = [];
    const metrics = createMetrics();

    const intervals: number[] = [];
    const consumer = createReconnectingConsumer(
      { adapter: source, ...deps(published, metrics) },
      {
        initialBackoffMs: 100,
        maxBackoffMs: 5_000,
        // Capture each computed backoff by intercepting sleep. Yield a macrotask (not just a
        // microtask) so the reconnect loop — which here fails instantly every time, since the
        // endpoint is down — cannot starve the test's polling below.
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            intervals.push(ms);
            setTimeout(resolve, 0);
          }),
      },
    );
    running = consumer;
    const loop = consumer.run();

    await waitFor(() => intervals.length >= 10);
    await consumer.stop();
    await loop;

    const first10 = intervals.slice(0, 10);
    // The very first backoff is jittered, and the intervals are not all equal.
    expect(new Set(first10).size).toBeGreaterThan(5);
  });
});

describe('AC5 — shutdown drains in-flight publishes', () => {
  it('awaits slow publishes before stop() resolves', async () => {
    const source = createControllableStreamSource('axxon');
    const settled: string[] = [];
    const metrics = createMetrics();
    const logger = createCapturingLogger('axxon-consumer-test');

    let releaseSlow: () => void = () => {};
    const slowPublish = new Promise<void>((resolve) => {
      releaseSlow = () => resolve();
    });

    const consumer = createReconnectingConsumer(
      {
        adapter: source,
        logger: logger.logger,
        metrics,
        alerts: createAlerts(logger.logger),
        publish: async (e: NormalizedAlarmEvent) => {
          await slowPublish; // simulate a publish still in flight at shutdown
          settled.push(e.vendor_event_id);
        },
      },
      { sleep: yieldingSleep },
    );
    running = consumer;
    const loop = consumer.run();

    await waitFor(() => source.isConnected());
    source.emit(event('phase4-inflight'));

    // Begin shutdown while the publish is still pending.
    const stopping = consumer.stop();
    // Nothing has settled yet — stop() must be waiting for the in-flight publish.
    expect(settled).toEqual([]);

    // Release the publish; now shutdown can complete.
    releaseSlow();
    await stopping;
    await loop;

    // The in-flight publish completed before shutdown finished — nothing lost.
    expect(settled).toEqual(['phase4-inflight']);
  });
});

// --- helpers ---

/** A small deterministic PRNG so jitter tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor timed out');
}
