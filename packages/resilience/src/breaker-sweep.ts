import type { Alerts, Logger, Metrics } from '@deepsight/observability';
import type { VendorPolicy } from './policy.js';

/**
 * Alerts when a breaker stays open beyond a threshold.
 *
 * A PERIODIC SWEEP over current state, deliberately not a setTimeout scheduled inside the
 * breaker's state-change handler. An in-process timer is lost on redeploy — and redeploy is
 * exactly when breakers are most likely to be open, so the timer approach loses the alert
 * at the moment it matters most. A sweep re-derives the condition from state that survives,
 * so a freshly started process still reports a breaker that is open right now.
 *
 * Escalation is separate from the opening alert (which fires immediately at 'warning'):
 * open for a moment is normal, open for a minute is an outage.
 */

export interface BreakerSweepOptions {
  readonly openBeyondMs?: number | undefined;
  readonly intervalMs?: number | undefined;
}

export interface BreakerSweep {
  /** Runs one pass. Exposed so tests can drive it directly instead of waiting on a timer. */
  runOnce(now?: Date): void;
  stop(): void;
}

export interface BreakerSweepDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

export function createBreakerSweep(
  policies: readonly VendorPolicy[],
  deps: BreakerSweepDeps,
  options: BreakerSweepOptions = {},
): BreakerSweep {
  const openBeyondMs = options.openBeyondMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 15_000;

  /**
   * Which vendors have already been escalated for their CURRENT open episode. Keyed by the
   * timestamp the breaker opened, so a breaker that recovers and reopens escalates again
   * while one that simply stays open does not alert on every sweep — the difference between
   * an alert and an alert storm.
   */
  const escalated = new Map<string, number>();

  const runOnce = (now: Date = new Date()): void => {
    for (const policy of policies) {
      const state = policy.state();
      const openedAt = policy.openedAt();

      if (state !== 'open' || openedAt === null) {
        // A breaker that was escalated and is now closed/half-open has RECOVERED. Fire a single
        // resolution so an on-call who saw the outage alert also sees it clear — an alert that
        // never resolves trains people to ignore the channel.
        if (escalated.has(policy.vendor)) {
          deps.alerts.fire('vendor_breaker_recovered', { severity: 'info', vendor: policy.vendor });
          deps.logger.info({ vendor: policy.vendor }, 'vendor circuit breaker recovered');
        }
        escalated.delete(policy.vendor);
        continue;
      }

      const openForMs = now.getTime() - openedAt.getTime();
      deps.metrics.gauge('vendor_breaker_open_for_ms', openForMs, { vendor: policy.vendor });

      if (openForMs < openBeyondMs) continue;
      if (escalated.get(policy.vendor) === openedAt.getTime()) continue;

      escalated.set(policy.vendor, openedAt.getTime());
      deps.alerts.fire('vendor_breaker_open_too_long', {
        severity: 'critical',
        vendor: policy.vendor,
        openForMs,
        thresholdMs: openBeyondMs,
      });
      deps.logger.error(
        { vendor: policy.vendor, openForMs },
        'vendor circuit breaker has been open beyond the alert threshold',
      );
    }
  };

  const timer = setInterval(() => runOnce(), intervalMs);
  // Must not hold the event loop open: a sweep timer that keeps the process alive turns a
  // clean SIGTERM shutdown into a hang, which Railway reports as a failed deploy.
  timer.unref();

  return {
    runOnce,
    stop() {
      clearInterval(timer);
    },
  };
}
