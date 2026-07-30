import type { Logger } from '@deepsight/observability';
import type { VendorHealthSource } from '../http/app.js';
import type { RealtimeHub } from './hub.js';

/**
 * The realtime alarm fan-out itself lives at the engine entrypoint as a small deferred closure:
 * the core is constructed with its fan-out before the HTTP server (and therefore the hub) exist,
 * so the closure forwards to the hub once it is bound. What remains here is the health broadcast.
 *
 * Periodically pushes vendor health to dashboards.
 *
 * A poll rather than a hook into the breaker: the breaker state change already updates a gauge
 * and fires an alert (resilience package); the dashboard just needs the current picture soon
 * after it changes. A short interval (default 2s) means a tripped breaker shows on the dashboard
 * well inside the 5s AC4 requires, without coupling the socket layer to Cockatiel internals.
 */
export interface VendorHealthBroadcaster {
  close(): void;
}

export function startVendorHealthBroadcast(deps: {
  readonly hub: RealtimeHub;
  readonly source: VendorHealthSource;
  readonly logger: Logger;
  readonly intervalMs?: number | undefined;
}): VendorHealthBroadcaster {
  const intervalMs = deps.intervalMs ?? 2_000;
  let stopped = false;

  const tick = async (): Promise<void> => {
    try {
      const health = await deps.source.snapshot();
      if (!stopped) deps.hub.broadcastVendorHealth(health);
    } catch (error) {
      // Never let a health-snapshot failure kill the broadcaster: the dashboard simply keeps
      // the last picture until the next successful tick.
      deps.logger.warn(
        { err: error instanceof Error ? error.message : error },
        'vendor health broadcast tick failed',
      );
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  // Emit one immediately so a freshly connected dashboard is not blank for a whole interval.
  void tick();

  return {
    close() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
