import type { AlarmAdapter, VendorId, WebhookAlarmAdapter } from '@deepsight/contracts';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';
import { createVendorPolicy, type VendorPolicy } from '@deepsight/resilience';
import type { VendorHealth, VendorHealthSource } from '../http/app.js';
import { runPollCycle, type DispatchDeps, type PollSource } from './dispatcher.js';

/**
 * Pairs each vendor adapter with a per-vendor resilience policy, and exposes the two things
 * the rest of the engine needs from a vendor: its health (for /health and the dashboard),
 * and — for poll-mode vendors — a poll cycle that runs THROUGH the policy so retries,
 * timeout, bulkhead and the circuit breaker all apply.
 *
 * Running polls through the policy is what makes the breaker meaningful: when a vendor is
 * failing (including the current state where every real adapter throws
 * UNVERIFIED_VENDOR_CONTRACT), consecutive failures trip the breaker and the 6th cycle
 * fails fast without calling the adapter at all.
 */

export interface VendorRuntime {
  readonly vendor: VendorId;
  readonly adapter: AlarmAdapter;
  readonly policy: VendorPolicy;
  /** Poll one cycle through the policy. Throws (or fails fast) if the breaker is open. */
  runPoll(source: PollSource, dispatch: DispatchDeps, signal: AbortSignal): Promise<void>;
  health(): Promise<VendorHealth>;
  dispose(): void;
}

export interface VendorRuntimeDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

export function createVendorRuntime(adapter: AlarmAdapter, deps: VendorRuntimeDeps): VendorRuntime {
  const policy = createVendorPolicy(adapter.vendor, deps);

  return {
    vendor: adapter.vendor,
    adapter,
    policy,

    async runPoll(source, dispatch, signal) {
      if (adapter.mode !== 'poll') {
        throw new Error(`runPoll called for non-poll vendor ${adapter.vendor} (${adapter.mode})`);
      }
      // The policy owns retry/timeout/bulkhead/breaker; the poll cycle owns cursor
      // read/advance and ingestion. Wrapping the whole cycle means a failing poll counts
      // toward the breaker.
      await policy.execute(async ({ signal: policySignal }) => {
        // Prefer the policy's signal (it fires on timeout) but also honour the caller's
        // shutdown signal — either aborting the poll is correct.
        const merged = mergeSignals(signal, policySignal);
        await runPollCycle(adapter, source, dispatch, merged);
      });
    },

    async health() {
      // Status comes from the adapter (is it connected?), breaker state from the policy
      // (are we even attempting calls?). Both are needed: a vendor can be reachable but
      // have an open breaker from a recent burst of failures.
      const adapterHealth = await adapter.healthCheck();
      const breaker = policy.state();
      return {
        vendor: adapter.vendor,
        status: breaker === 'open' ? 'offline' : adapterHealth.status,
        breaker_state: breaker,
        ...(adapterHealth.error !== undefined ? { error: adapterHealth.error } : {}),
      };
    },

    dispose() {
      policy.dispose();
    },
  };
}

/**
 * Combines two AbortSignals into one that aborts when either does. Node 20+ has
 * AbortSignal.any, but composing manually keeps this independent of the runtime's exact
 * version and is trivial to reason about.
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/** A VendorHealthSource over a set of runtimes, for the /health endpoint. */
export function createVendorHealthSource(runtimes: readonly VendorRuntime[]): VendorHealthSource {
  return {
    async snapshot() {
      // allSettled, never all: one vendor's healthCheck throwing must not blank out the
      // health of every other vendor (brief: partial failure must never become total).
      const settled = await Promise.allSettled(runtimes.map((r) => r.health()));
      const out: VendorHealth[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          out.push(result.value);
        } else {
          const runtime = runtimes[index];
          out.push({
            vendor: runtime?.vendor ?? 'guardtek',
            status: 'offline',
            breaker_state: 'closed',
            error: `health check threw: ${String(result.reason)}`,
          });
        }
      }
      return out;
    },
  };
}

/** Filters a runtime set to the webhook-mode adapters, keyed by vendor, for the route. */
export function webhookAdapterMap(
  runtimes: readonly VendorRuntime[],
): ReadonlyMap<VendorId, WebhookAlarmAdapter> {
  const map = new Map<VendorId, WebhookAlarmAdapter>();
  for (const runtime of runtimes) {
    if (runtime.adapter.mode === 'webhook') {
      map.set(runtime.vendor, runtime.adapter);
    }
  }
  return map;
}
