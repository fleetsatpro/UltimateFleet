import {
  bulkhead,
  circuitBreaker,
  CircuitState,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  timeout,
  TimeoutStrategy,
  wrap,
  type IPolicy,
} from 'cockatiel';
import type { BreakerState, VendorId } from '@deepsight/contracts';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';

/**
 * The per-vendor resilience policy stack.
 *
 * The brief's snippet for this does not compile — it is Polly (.NET) fluent-builder syntax
 * (`handleAll.retry().attempts(3)`), whereas Cockatiel exposes standalone policy functions.
 * Divergence D1 in the architecture document covers the correction; this is the corrected
 * implementation.
 *
 * VERIFIED SEMANTICS, measured rather than assumed:
 *
 *   - Cockatiel's `maxAttempts` counts RETRIES, not total calls. `maxAttempts: 3` invokes
 *     the function FOUR times. The brief asks for "3 attempts", which is ambiguous in
 *     exactly the way that produces an off-by-one in production, so this module's option is
 *     named `totalAttempts` and converted at the boundary. Three means three network calls.
 *
 *   - decorrelatedJitterGenerator is already ExponentialBackoff's DEFAULT generator, so the
 *     brief's explicit `.jitter(ExponentialBackoff.decorrelatedJitter())` was redundant as
 *     well as invalid. Jitter is active without configuring anything.
 *
 *   - ConsecutiveBreaker(5) lets exactly 5 calls through before opening; the 6th fails fast
 *     with no call at all.
 */

export interface VendorPolicyOptions {
  /** TOTAL calls including the first, not retries. 3 means three network calls. */
  readonly totalAttempts?: number | undefined;
  readonly consecutiveFailures?: number | undefined;
  readonly halfOpenAfterMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly bulkheadLimit?: number | undefined;
  readonly initialBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
}

export interface VendorPolicy {
  readonly vendor: VendorId;
  execute<T>(fn: (context: { signal: AbortSignal }) => Promise<T>): Promise<T>;
  /** Current breaker state, surfaced on /health and exported as a metric. */
  state(): BreakerState;
  /** When the breaker last opened, or null if closed. Drives the stuck-open sweep. */
  openedAt(): Date | null;
  dispose(): void;
}

export interface VendorPolicyDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

function toBreakerState(state: CircuitState): BreakerState {
  switch (state) {
    case CircuitState.Closed:
      return 'closed';
    case CircuitState.Open:
      return 'open';
    case CircuitState.HalfOpen:
      return 'half-open';
    case CircuitState.Isolated:
      // Manual isolation is an operator action, not a fault. Reported as open because that
      // is what it means to a caller: requests are being refused.
      return 'open';
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled circuit state: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Numeric encoding for the gauge: 0 closed, 1 half-open, 2 open. Ordered by severity. */
function stateToNumber(state: BreakerState): number {
  return state === 'closed' ? 0 : state === 'half-open' ? 1 : 2;
}

export function createVendorPolicy(
  vendor: VendorId,
  deps: VendorPolicyDeps,
  options: VendorPolicyOptions = {},
): VendorPolicy {
  const totalAttempts = options.totalAttempts ?? 3;
  if (totalAttempts < 1) {
    throw new Error(`totalAttempts must be at least 1, received ${totalAttempts}`);
  }

  const breaker = circuitBreaker(handleAll, {
    halfOpenAfter: options.halfOpenAfterMs ?? 30_000,
    breaker: new ConsecutiveBreaker(options.consecutiveFailures ?? 5),
  });

  let openedAtMs: number | null = null;

  const listener = breaker.onStateChange((state) => {
    const mapped = toBreakerState(state);
    deps.metrics.gauge('vendor_breaker_state', stateToNumber(mapped), { vendor });

    if (mapped === 'open') {
      openedAtMs = Date.now();
      // Alert, not merely log. A silently-open breaker quietly serving degraded data is a
      // worse failure mode than a visible outage — the dashboard looks calm precisely
      // because no vendor traffic is being attempted.
      deps.alerts.fire('vendor_breaker_open', { severity: 'warning', vendor });
      deps.logger.warn({ vendor }, 'vendor circuit breaker opened');
    } else {
      if (openedAtMs !== null) {
        deps.metrics.histogram('vendor_breaker_open_duration_ms', Date.now() - openedAtMs, {
          vendor,
        });
        deps.logger.info({ vendor, state: mapped }, 'vendor circuit breaker recovered');
      }
      openedAtMs = null;
    }
  });

  deps.metrics.gauge('vendor_breaker_state', stateToNumber(toBreakerState(breaker.state)), {
    vendor,
  });

  /**
   * Order matters, and `wrap`'s FIRST argument is the OUTERMOST policy.
   *
   *   retry (outermost)  so a transient failure is retried before anything else sees it
   *   breaker            so retries count toward opening it
   *   timeout            INSIDE the breaker, so a hanging vendor can trip the circuit — a
   *                      vendor that never answers is exactly what a breaker is for
   *   bulkhead (inner)   so waiting for a concurrency slot is charged against the same
   *                      timeout budget rather than added on top of it
   */
  const composed: IPolicy = wrap(
    retry(handleAll, {
      // Converted here: Cockatiel counts retries, this module's API counts total calls.
      maxAttempts: totalAttempts - 1,
      backoff: new ExponentialBackoff({
        initialDelay: options.initialBackoffMs ?? 128,
        maxDelay: options.maxBackoffMs ?? 30_000,
        // generator defaults to decorrelatedJitterGenerator — jitter is on by default.
      }),
    }),
    breaker,
    timeout(options.timeoutMs ?? 10_000, TimeoutStrategy.Aggressive),
    bulkhead(options.bulkheadLimit ?? 10),
  );

  return {
    vendor,

    async execute<T>(fn: (context: { signal: AbortSignal }) => Promise<T>): Promise<T> {
      const started = Date.now();
      try {
        const result = await composed.execute(({ signal }) => fn({ signal }));
        deps.metrics.counter('vendor_call_success_total', 1, { vendor });
        return result as T;
      } catch (error) {
        deps.metrics.counter('vendor_call_failure_total', 1, { vendor });
        deps.logger.warn(
          { vendor, err: error instanceof Error ? error.message : error },
          'vendor call failed',
        );
        throw error;
      } finally {
        deps.metrics.histogram('vendor_call_duration_ms', Date.now() - started, { vendor });
      }
    },

    state() {
      return toBreakerState(breaker.state);
    },

    openedAt() {
      return openedAtMs === null ? null : new Date(openedAtMs);
    },

    dispose() {
      // Without this the listener outlives the policy, which matters in a long-lived
      // process that rebuilds adapters on configuration change.
      listener.dispose();
    },
  };
}
