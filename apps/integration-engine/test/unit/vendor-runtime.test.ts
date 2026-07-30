import { afterEach, describe, expect, it } from 'vitest';
import type {
  NormalizedAlarmEvent,
  PollCursor,
  PollingAlarmAdapter,
  VendorId,
} from '@deepsight/contracts';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { createVendorRuntime, type VendorRuntime } from '../../src/ingestion/vendor-runtime.js';
import type { DispatchDeps } from '../../src/ingestion/dispatcher.js';

/**
 * Phase 3 acceptance criterion 3, at the engine's vendor-runtime layer: a failing poll
 * adapter, driven through its resilience policy, opens the circuit breaker after 5
 * consecutive failures, and the 6th cycle fails fast WITHOUT invoking the adapter.
 *
 * This is the engine-level analogue of the resilience package's own breaker test. Here the
 * point is that runPoll routes the whole cycle through the policy, so a vendor that is
 * failing — including today's reality, where every real adapter throws
 * UNVERIFIED_VENDOR_CONTRACT — trips the breaker rather than being retried forever.
 *
 * No database: an in-memory cursor store and a no-op fan-out isolate the breaker behaviour
 * from persistence.
 */

/** A poll adapter that counts invocations and always fails, standing in for a down vendor. */
function countingFailingPollAdapter(vendor: VendorId): {
  adapter: PollingAlarmAdapter;
  calls(): number;
} {
  let calls = 0;
  const adapter: PollingAlarmAdapter = {
    vendor,
    mode: 'poll',
    healthCheck: () =>
      Promise.resolve({ vendor, status: 'offline' as const, breaker_state: 'closed' as const }),
    // eslint-disable-next-line require-yield -- always throws before yielding, by design
    async *poll(_cursor: PollCursor, _signal: AbortSignal) {
      calls += 1;
      throw new Error('vendor unreachable');
    },
  };
  return { adapter, calls: () => calls };
}

function inMemoryDispatch(): DispatchDeps {
  const logger = createCapturingLogger('vendor-runtime-test');
  const cursors = new Map<string, PollCursor>();
  return {
    mappings: {
      resolve: () => ({ event_type: 'unknown', severity: null, mapped: false }),
    },
    fanOut: { publish: (_e: NormalizedAlarmEvent) => Promise.resolve() },
    cursors: {
      read: (source) => Promise.resolve(cursors.get(source.sourceId) ?? null),
      write: (source, cursor) => {
        cursors.set(source.sourceId, cursor);
        return Promise.resolve();
      },
    },
    logger: logger.logger,
    metrics: createMetrics(),
    alerts: createAlerts(logger.logger),
  };
}

let runtimes: VendorRuntime[] = [];
function track(r: VendorRuntime): VendorRuntime {
  runtimes.push(r);
  return r;
}
afterEach(() => {
  for (const r of runtimes) r.dispose();
  runtimes = [];
});

const SOURCE = { orgId: '0a000000-0000-4000-8000-000000000001', sourceId: 'src-1' };

describe('AC3 — a failing vendor trips the breaker through the runtime', () => {
  it('calls the adapter 5 times, opens the breaker, then fails the 6th without a call', async () => {
    const logger = createCapturingLogger('vendor-runtime-test');
    const metrics = createMetrics();
    const alerts = createAlerts(logger.logger);
    const failing = countingFailingPollAdapter('guardtek');
    const runtime = track(
      createVendorRuntime(failing.adapter, { logger: logger.logger, metrics, alerts }),
    );
    const dispatch = inMemoryDispatch();
    const signal = new AbortController().signal;

    // Default policy: 3 total attempts, breaker opens after 5 consecutive failures. Each
    // runPoll is one policy.execute, which internally retries up to 3 times — so a single
    // runPoll can move the consecutive-failure count by more than one. We simply keep
    // polling until the breaker is open, then assert the fail-fast property.
    let pollCyclesUntilOpen = 0;
    while (runtime.policy.state() !== 'open' && pollCyclesUntilOpen < 20) {
      pollCyclesUntilOpen += 1;
      await expect(runtime.runPoll(SOURCE, dispatch, signal)).rejects.toThrow();
    }

    expect(runtime.policy.state()).toBe('open');
    const callsAtOpen = failing.calls();
    expect(callsAtOpen).toBeGreaterThanOrEqual(5);

    // The decisive assertion: once open, the adapter is not called again.
    await expect(runtime.runPoll(SOURCE, dispatch, signal)).rejects.toThrow();
    expect(failing.calls()).toBe(callsAtOpen);

    // And the open breaker is reflected in the vendor's health, so the dashboard shows it.
    const health = await runtime.health();
    expect(health.breaker_state).toBe('open');
    expect(health.status).toBe('offline');
  });

  it('fires the breaker-open alert exactly once per open episode', async () => {
    const logger = createCapturingLogger('vendor-runtime-test');
    const metrics = createMetrics();
    const alerts = createAlerts(logger.logger);
    const failing = countingFailingPollAdapter('dahua');
    const runtime = track(
      createVendorRuntime(failing.adapter, { logger: logger.logger, metrics, alerts }),
    );
    const dispatch = inMemoryDispatch();
    const signal = new AbortController().signal;

    for (let i = 0; i < 12 && runtime.policy.state() !== 'open'; i += 1) {
      await runtime.runPoll(SOURCE, dispatch, signal).catch(() => undefined);
    }

    const opened = alerts.fired().filter((a) => a.name === 'vendor_breaker_open');
    // The onStateChange handler fires the alert once on the closed->open transition. Extra
    // failed polls while already open do not re-fire it.
    expect(opened.length).toBe(1);
    expect(opened[0]?.context['vendor']).toBe('dahua');
  });
});
