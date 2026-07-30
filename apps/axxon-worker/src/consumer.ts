import type { NormalizedAlarmEvent, StreamAlarmAdapter, Unsubscribe } from '@deepsight/contracts';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';

/**
 * The reconnecting stream consumer — the heart of the isolated AxxonSoft worker.
 *
 * It subscribes to a StreamAlarmAdapter, publishes each alarm to the queue, and — when the
 * stream drops or fails to connect — reconnects with exponential backoff plus DECORRELATED
 * JITTER, from the FIRST failed attempt (not "immediate retry, then back off"). Its whole
 * reason to be a dedicated Railway service is that a long-lived stream client's reconnect
 * lifecycle and memory profile must stay isolated from ingestion.
 *
 * Two properties are load-bearing and tested:
 *   - the onAlarm subscription is torn down (unsubscribe) on EVERY reconnect, so a process
 *     whose entire job is reconnecting forever does not accumulate a listener per reconnect;
 *   - in-flight publishes are drained on shutdown, so a SIGTERM mid-stream loses nothing.
 *
 * The consumer models a connection lifecycle as: adapter.start(signal) runs the stream and
 * RESOLVES when the stream closes (a disconnect) or REJECTS when it cannot connect. Either
 * way the consumer backs off and reconnects until told to stop.
 */

export interface PublishFn {
  (event: NormalizedAlarmEvent): Promise<void>;
}

export interface ReconnectingConsumerOptions {
  readonly initialBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  /** Injectable for deterministic tests; defaults to Math.random. */
  readonly random?: (() => number) | undefined;
  /** Injectable sleep, so tests can run without real time. */
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export interface ReconnectingConsumerDeps {
  readonly adapter: StreamAlarmAdapter;
  readonly publish: PublishFn;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

export interface ReconnectingConsumer {
  /** Runs until stop() is called. Resolves once fully stopped and drained. */
  run(): Promise<void>;
  stop(): Promise<void>;
  reconnectCount(): number;
  /** The number of live onAlarm listeners — must never exceed 1 (leak guard). */
  listenerCount(): number;
}

/**
 * Decorrelated jitter, the AWS "Exponential Backoff and Jitter" formulation:
 *   sleep = min(cap, random_between(base, previous * 3))
 * This is applied from the FIRST retry, so there is never an un-jittered attempt.
 */
export function decorrelatedJitter(
  previous: number,
  base: number,
  cap: number,
  random: () => number,
): number {
  const upper = previous * 3;
  const value = base + random() * (upper - base);
  return Math.min(cap, Math.max(base, value));
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createReconnectingConsumer(
  deps: ReconnectingConsumerDeps,
  options: ReconnectingConsumerOptions = {},
): ReconnectingConsumer {
  const base = options.initialBackoffMs ?? 500;
  const cap = options.maxBackoffMs ?? 30_000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  const controller = new AbortController();
  let reconnects = 0;
  let liveListeners = 0;
  let stopped = false;
  /** Publishes started but not yet awaited; drained on stop so a SIGTERM loses nothing. */
  const inflight = new Set<Promise<void>>();

  /** Waits for in-flight publishes so a mid-stream shutdown loses nothing. */
  const drain = async (): Promise<void> => {
    await Promise.allSettled([...inflight]);
  };

  const trackPublish = (event: NormalizedAlarmEvent): void => {
    const p = deps
      .publish(event)
      .then(() => {
        deps.metrics.counter('axxon_events_published_total', 1);
      })
      .catch((error: unknown) => {
        deps.metrics.counter('axxon_publish_failures_total', 1);
        deps.logger.error(
          { err: error instanceof Error ? error.message : error },
          'failed to publish axxon alarm to queue',
        );
      })
      .finally(() => {
        inflight.delete(p);
      });
    inflight.add(p);
  };

  /** One connection lifecycle: subscribe, start, and tear the subscription down after. */
  const runOneConnection = async (): Promise<void> => {
    const unsubscribe: Unsubscribe = deps.adapter.onAlarm((event) => trackPublish(event));
    liveListeners += 1;
    try {
      // start() resolves on a clean stream close, rejects on a connection failure.
      await deps.adapter.start(controller.signal);
    } finally {
      // Torn down on EVERY exit path, so reconnects cannot leak listeners. This is the
      // whole reason onAlarm returns an Unsubscribe rather than `this`.
      unsubscribe();
      liveListeners -= 1;
    }
  };

  return {
    async run() {
      let backoff = base;

      while (!stopped && !controller.signal.aborted) {
        try {
          await runOneConnection();
          // A clean close still needs a reconnect — the stream ended, we want it back.
          if (stopped || controller.signal.aborted) break;
          deps.logger.info({}, 'axxon stream closed; will reconnect');
        } catch (error) {
          if (stopped || controller.signal.aborted) break;
          deps.logger.warn(
            { err: error instanceof Error ? error.message : error },
            'axxon stream connection failed; will reconnect',
          );
        }

        // The very first connect attempt is not itself a reconnect; every failure — starting
        // with the first — increments the reconnect count and backs off with jitter.
        reconnects += 1;
        deps.metrics.counter('axxon_reconnects_total', 1);
        deps.metrics.gauge('axxon_reconnect_count', reconnects);

        backoff = decorrelatedJitter(backoff, base, cap, random);
        deps.logger.debug(
          { backoffMs: Math.round(backoff), reconnects },
          'backing off before reconnect',
        );
        await sleep(backoff, controller.signal);
      }

      await drain();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
      // Ask the adapter to stop the current connection; run()'s loop then exits.
      await deps.adapter.stop();
      await drain();
    },

    reconnectCount() {
      return reconnects;
    },

    listenerCount() {
      return liveListeners;
    },
  };
}
