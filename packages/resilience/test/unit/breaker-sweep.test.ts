import { describe, expect, it } from 'vitest';
import {
  createAlerts,
  createCapturingLogger,
  createMetrics,
  type Alerts,
} from '@deepsight/observability';
import { createBreakerSweep } from '../../src/breaker-sweep.js';
import type { BreakerState, VendorId } from '@deepsight/contracts';
import type { VendorPolicy } from '../../src/policy.js';

/**
 * Phase 12 will lean on this, but the sweep is built now alongside the policy it watches.
 *
 * The property under test is the one the brief calls out: alert when a breaker stays open
 * beyond a threshold, as a PERIODIC SWEEP over current state rather than a setTimeout
 * scheduled when the breaker opens. A timer is lost on redeploy — and redeploy is exactly
 * when breakers are most likely open — so a fresh process must still be able to report a
 * breaker that is open right now.
 */

/** A hand-controlled stand-in for a VendorPolicy, so state and timing are deterministic. */
function fakePolicy(vendor: VendorId): {
  policy: VendorPolicy;
  set(state: BreakerState, openedAt: Date | null): void;
} {
  let state: BreakerState = 'closed';
  let openedAt: Date | null = null;
  const policy: VendorPolicy = {
    vendor,
    execute: async (fn) => fn({ signal: new AbortController().signal }),
    state: () => state,
    openedAt: () => openedAt,
    dispose: () => {},
  };
  return {
    policy,
    set(nextState, nextOpenedAt) {
      state = nextState;
      openedAt = nextOpenedAt;
    },
  };
}

function deps(): {
  logger: ReturnType<typeof createCapturingLogger>['logger'];
  alerts: Alerts;
  metrics: ReturnType<typeof createMetrics>;
} {
  const logger = createCapturingLogger('sweep-test');
  return { logger: logger.logger, alerts: createAlerts(logger.logger), metrics: createMetrics() };
}

describe('breaker sweep escalates a breaker open too long', () => {
  it('fires exactly one critical alert, not one per sweep', () => {
    const { logger, alerts, metrics } = deps();
    const fake = fakePolicy('dahua');
    const sweep = createBreakerSweep(
      [fake.policy],
      { logger, alerts, metrics },
      {
        openBeyondMs: 60_000,
        intervalMs: 1_000_000, // never fire on its own; the test drives runOnce()
      },
    );

    const openedAt = new Date('2026-06-01T00:00:00Z');
    fake.set('open', openedAt);

    // Open for 30s: under threshold, no alert.
    sweep.runOnce(new Date(openedAt.getTime() + 30_000));
    expect(alerts.fired().filter((a) => a.name === 'vendor_breaker_open_too_long')).toHaveLength(0);

    // Open for 70s: over threshold, one alert.
    sweep.runOnce(new Date(openedAt.getTime() + 70_000));
    // Still open at the next sweep: must NOT alert again — an alert storm is its own outage.
    sweep.runOnce(new Date(openedAt.getTime() + 85_000));
    sweep.runOnce(new Date(openedAt.getTime() + 100_000));

    const escalations = alerts.fired().filter((a) => a.name === 'vendor_breaker_open_too_long');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.severity).toBe('critical');
    expect(escalations[0]?.context['vendor']).toBe('dahua');

    sweep.stop();
  });

  it('re-escalates a breaker that recovers and reopens', () => {
    const { logger, alerts, metrics } = deps();
    const fake = fakePolicy('axxon');
    const sweep = createBreakerSweep(
      [fake.policy],
      { logger, alerts, metrics },
      {
        openBeyondMs: 60_000,
        intervalMs: 1_000_000,
      },
    );

    const firstOpen = new Date('2026-06-01T00:00:00Z');
    fake.set('open', firstOpen);
    sweep.runOnce(new Date(firstOpen.getTime() + 70_000));

    // Recovered.
    fake.set('closed', null);
    sweep.runOnce(new Date(firstOpen.getTime() + 80_000));

    // Opened AGAIN, a distinct episode (new openedAt): it must be able to alert again.
    const secondOpen = new Date(firstOpen.getTime() + 200_000);
    fake.set('open', secondOpen);
    sweep.runOnce(new Date(secondOpen.getTime() + 70_000));

    expect(alerts.fired().filter((a) => a.name === 'vendor_breaker_open_too_long')).toHaveLength(2);
    sweep.stop();
  });

  it('alerts from a freshly-constructed sweep — no reliance on an in-process timer', () => {
    // Simulates the redeploy case: the process that would have held a setTimeout is gone,
    // a new one starts, and the breaker is already open. A sweep re-derives the condition
    // from state that survives, so it still alerts.
    const { logger, alerts, metrics } = deps();
    const fake = fakePolicy('guardtek');
    fake.set('open', new Date('2026-06-01T00:00:00Z'));

    const sweep = createBreakerSweep(
      [fake.policy],
      { logger, alerts, metrics },
      {
        openBeyondMs: 60_000,
        intervalMs: 1_000_000,
      },
    );

    sweep.runOnce(new Date('2026-06-01T00:02:00Z')); // 120s open
    expect(alerts.fired().filter((a) => a.name === 'vendor_breaker_open_too_long')).toHaveLength(1);
    sweep.stop();
  });

  it('fires a single resolution when an escalated breaker recovers (AC1)', () => {
    const { logger, alerts, metrics } = deps();
    const fake = fakePolicy('dahua');
    const sweep = createBreakerSweep(
      [fake.policy],
      { logger, alerts, metrics },
      { openBeyondMs: 60_000, intervalMs: 1_000_000 },
    );

    const openedAt = new Date('2026-06-01T00:00:00Z');
    fake.set('open', openedAt);
    sweep.runOnce(new Date(openedAt.getTime() + 70_000)); // escalate
    expect(alerts.fired().filter((a) => a.name === 'vendor_breaker_open_too_long')).toHaveLength(1);

    fake.set('closed', null);
    sweep.runOnce(new Date(openedAt.getTime() + 80_000)); // recovered -> one resolution
    sweep.runOnce(new Date(openedAt.getTime() + 90_000)); // still closed -> no repeat
    const recovered = alerts.fired().filter((a) => a.name === 'vendor_breaker_recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.severity).toBe('info');
    sweep.stop();
  });

  it('clears escalation state when the breaker closes', () => {
    const { logger, alerts, metrics } = deps();
    const fake = fakePolicy('dahua');
    const sweep = createBreakerSweep(
      [fake.policy],
      { logger, alerts, metrics },
      {
        openBeyondMs: 10_000,
        intervalMs: 1_000_000,
      },
    );

    const openedAt = new Date('2026-06-01T00:00:00Z');
    fake.set('open', openedAt);
    sweep.runOnce(new Date(openedAt.getTime() + 20_000));
    expect(alerts.fired()).toHaveLength(1);

    fake.set('closed', null);
    sweep.runOnce(new Date(openedAt.getTime() + 30_000));
    // A gauge is still emitted, but no further escalation.
    expect(alerts.fired().filter((a) => a.name === 'vendor_breaker_open_too_long')).toHaveLength(1);
    sweep.stop();
  });
});
