import { afterEach, describe, expect, it } from 'vitest';
import {
  createAlerts,
  createCapturingLogger,
  createMetrics,
  type Alerts,
  type Metrics,
} from '@deepsight/observability';
import { createVendorPolicy, type VendorPolicy } from '../../src/policy.js';

/**
 * Phase 3 acceptance criteria 3 and 4: the circuit breaker opens after N consecutive
 * failures and then fails fast without a call, and retry timings are jittered.
 *
 * The semantics asserted here were MEASURED against cockatiel before the policy was
 * written, not assumed — see the header of src/policy.ts. In particular Cockatiel's
 * `maxAttempts` counts retries, so this module converts a `totalAttempts` API to it, and
 * these tests pin that conversion so an upgrade that changes the counting is caught.
 */

let disposers: VendorPolicy[] = [];

function deps(): {
  logger: ReturnType<typeof createCapturingLogger>;
  metrics: Metrics;
  alerts: Alerts;
} {
  const logger = createCapturingLogger('resilience-test');
  const metrics = createMetrics();
  const alerts = createAlerts(logger.logger);
  return { logger, metrics, alerts };
}

function track(policy: VendorPolicy): VendorPolicy {
  disposers.push(policy);
  return policy;
}

afterEach(() => {
  for (const p of disposers) p.dispose();
  disposers = [];
});

describe('AC3 — circuit breaker opens and then fails fast', () => {
  it('lets exactly 5 consecutive failures through, then refuses the 6th without a call', async () => {
    const { logger, metrics, alerts } = deps();
    const policy = track(
      createVendorPolicy(
        'dahua',
        { logger: logger.logger, metrics, alerts },
        // totalAttempts 1 so retry does not mask the consecutive-failure count: each
        // execute() is exactly one call, which is what makes "5 calls then open" legible.
        { totalAttempts: 1, consecutiveFailures: 5, halfOpenAfterMs: 60_000 },
      ),
    );

    let calls = 0;
    const failing = async (): Promise<never> => {
      calls += 1;
      throw new Error('vendor down');
    };

    for (let i = 0; i < 5; i += 1) {
      await expect(policy.execute(failing)).rejects.toThrow('vendor down');
    }
    expect(calls).toBe(5);
    expect(policy.state()).toBe('open');

    // The 6th call must fail fast: the breaker is open, so the function is never invoked.
    // A vendor being hammered while it is down is exactly what the breaker prevents.
    await expect(policy.execute(failing)).rejects.toThrow();
    expect(calls).toBe(5);

    // Breaker state is exported as a gauge (2 === open) for the dashboard and alerting.
    const gauge = metrics
      .snapshot()
      .filter((s) => s.name === 'vendor_breaker_state' && s.labels['vendor'] === 'dahua')
      .at(-1);
    expect(gauge?.value).toBe(2);

    // Opening alerts immediately at warning — a silently-open breaker serving degraded
    // data is worse than a visible outage.
    const opened = alerts.fired().filter((a) => a.name === 'vendor_breaker_open');
    expect(opened.length).toBeGreaterThanOrEqual(1);
    expect(opened[0]?.context['vendor']).toBe('dahua');
  });

  it('reports openedAt while open and null once recovered', async () => {
    const { logger, metrics, alerts } = deps();
    const policy = track(
      createVendorPolicy(
        'axxon',
        { logger: logger.logger, metrics, alerts },
        { totalAttempts: 1, consecutiveFailures: 2, halfOpenAfterMs: 50 },
      ),
    );

    expect(policy.openedAt()).toBeNull();

    for (let i = 0; i < 2; i += 1) {
      await expect(policy.execute(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    }
    expect(policy.state()).toBe('open');
    expect(policy.openedAt()).toBeInstanceOf(Date);

    // After halfOpenAfter, a success closes it and openedAt clears.
    await new Promise((r) => setTimeout(r, 80));
    await policy.execute(async () => 'ok');
    expect(policy.state()).toBe('closed');
    expect(policy.openedAt()).toBeNull();
  });
});

describe('AC4 — retries are jittered, not plain exponential', () => {
  it('produces non-uniform total durations across runs', async () => {
    // Each run makes 3 total attempts (2 retries). With decorrelated jitter — cockatiel's
    // default generator — the summed backoff differs run to run; plain exponential would
    // repeat. Comparing across runs is what distinguishes jitter from fixed backoff.
    async function runOnce(): Promise<number> {
      const { logger, metrics, alerts } = deps();
      const policy = track(
        createVendorPolicy(
          'guardtek',
          { logger: logger.logger, metrics, alerts },
          {
            totalAttempts: 3,
            consecutiveFailures: 99, // keep the breaker out of the way
            initialBackoffMs: 20,
            maxBackoffMs: 400,
          },
        ),
      );
      const start = Date.now();
      await expect(
        policy.execute(async () => Promise.reject(new Error('always'))),
      ).rejects.toThrow();
      return Date.now() - start;
    }

    const durations: number[] = [];
    for (let i = 0; i < 20; i += 1) durations.push(await runOnce());

    const unique = new Set(durations);
    // Jitter makes collisions across 20 runs vanishingly unlikely. A fixed backoff would
    // collapse these to one or two values.
    expect(unique.size).toBeGreaterThan(10);
  }, 30_000);

  it('makes exactly totalAttempts calls before giving up', async () => {
    const { logger, metrics, alerts } = deps();
    const policy = track(
      createVendorPolicy(
        'guardtek',
        { logger: logger.logger, metrics, alerts },
        { totalAttempts: 3, consecutiveFailures: 99, initialBackoffMs: 1, maxBackoffMs: 4 },
      ),
    );

    let calls = 0;
    await expect(
      policy.execute(async () => {
        calls += 1;
        throw new Error('nope');
      }),
    ).rejects.toThrow();

    // The whole reason this module renames the option: cockatiel's maxAttempts:2 means 3
    // calls. totalAttempts:3 must mean 3 calls, full stop.
    expect(calls).toBe(3);
  });

  it('rejects an invalid totalAttempts rather than silently clamping', () => {
    const { logger, metrics, alerts } = deps();
    expect(() =>
      createVendorPolicy('dahua', { logger: logger.logger, metrics, alerts }, { totalAttempts: 0 }),
    ).toThrow(/at least 1/);
  });
});

describe('successful calls record success and duration', () => {
  it('increments the success counter and closes over a returned value', async () => {
    const { logger, metrics, alerts } = deps();
    const policy = track(createVendorPolicy('dahua', { logger: logger.logger, metrics, alerts }));

    const value = await policy.execute(async () => 42);
    expect(value).toBe(42);

    expect(metrics.snapshot().some((s) => s.name === 'vendor_call_success_total')).toBe(true);
    expect(metrics.snapshot().some((s) => s.name === 'vendor_call_duration_ms')).toBe(true);
  });
});
