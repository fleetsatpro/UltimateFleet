import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';
import { createCursorStore, type CursorStore } from './ingestion/cursor-store.js';
import { createMappingCache, type MappingCache } from './ingestion/mapping-cache.js';
import { ingestEvents, type FanOut, type IngestResult } from './ingestion/pipeline.js';

/**
 * The engine's wired core: mapping cache, fan-out target, cursor store and the ingestion
 * entrypoint, assembled once.
 *
 * Separated from index.ts so the same wiring the service runs can be constructed by tests
 * without binding a port or opening a Redis connection. A test that assembles its own
 * variant of this graph proves things about the test's wiring rather than the service's.
 */

export interface EngineCoreDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
  /** Overridable so Phase 6 can substitute the Socket.io broadcaster. */
  readonly fanOut?: FanOut | undefined;
}

export interface EngineCore {
  readonly mappings: MappingCache;
  readonly cursors: CursorStore;
  readonly fanOut: FanOut;
  ingest(events: readonly unknown[]): Promise<IngestResult>;
}

/**
 * Default fan-out until Phase 6 introduces the realtime transport.
 *
 * Deliberately a real, complete implementation of the interface rather than a stub: the
 * property Phase 2 must guarantee is that fan-out happens exactly once per NEWLY INSERTED
 * event, and that is testable with any sink at all. Swapping in Socket.io later changes
 * the destination, not the guarantee.
 */
export function createLoggingFanOut(logger: Logger): FanOut {
  return {
    publish(event: NormalizedAlarmEvent) {
      logger.debug(
        { internalId: event.internal_id, eventType: event.event_type },
        'event fanned out',
      );
      return Promise.resolve();
    },
  };
}

export async function createEngineCore(deps: EngineCoreDeps): Promise<EngineCore> {
  const mappings = createMappingCache(deps.logger);
  await mappings.reload();

  const cursors = createCursorStore();
  const fanOut = deps.fanOut ?? createLoggingFanOut(deps.logger);

  return {
    mappings,
    cursors,
    fanOut,
    async ingest(events) {
      return ingestEvents(
        {
          mappings,
          fanOut,
          logger: deps.logger,
          metrics: deps.metrics,
          alerts: deps.alerts,
        },
        events,
      );
    },
  };
}
