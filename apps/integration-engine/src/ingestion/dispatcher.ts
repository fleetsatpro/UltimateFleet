import {
  type AlarmAdapter,
  type NormalizedAlarmEvent,
  type PollCursor,
  type Unsubscribe,
} from '@deepsight/contracts';
import type { Logger, Metrics } from '@deepsight/observability';
import type { CursorStore, PollSource } from './cursor-store.js';
import { ingestEvents, type IngestOutcome, type PipelineDeps } from './pipeline.js';

/**
 * Drives an adapter according to its ingestion mode.
 *
 * The exhaustive switch plus the `never` assignment in the default branch is the point of
 * the whole discriminated-union refactor (divergence D3). With the brief's original
 * all-optional-methods interface, an adapter missing its ingestion method type-checks
 * fine and silently ingests nothing — indistinguishable from "no alarms occurred", which
 * for an alarm system is the worst failure mode available. Here, adding a fourth
 * IngestionMode makes `const exhaustive: never = adapter` a COMPILE ERROR until it is
 * wired in.
 */

export interface DispatchDeps extends PipelineDeps {
  readonly cursors: CursorStore;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface StreamHandle {
  stop(): Promise<void>;
}

/**
 * Runs one poll cycle: drains the generator, ingests what it yielded, and persists the
 * returned cursor so the next cycle resumes rather than re-fetching all history.
 */
export async function runPollCycle(
  adapter: Extract<AlarmAdapter, { mode: 'poll' }>,
  source: PollSource,
  deps: DispatchDeps,
  signal: AbortSignal,
): Promise<IngestOutcome> {
  const startCursor = await deps.cursors.read(source);
  const collected: NormalizedAlarmEvent[] = [];

  const generator = adapter.poll(startCursor, signal);
  let nextCursor: PollCursor = startCursor;

  while (true) {
    const step = await generator.next();
    if (step.done === true) {
      nextCursor = step.value;
      break;
    }
    collected.push(step.value);
  }

  const outcome = await ingestEvents(deps, collected);

  // Written only after ingestion succeeds. Advancing the cursor first would skip events
  // permanently if persistence then failed — the cursor is a promise that everything
  // before it is durably stored.
  await deps.cursors.write(source, nextCursor);

  deps.metrics.counter('poll_cycles_total', 1, { vendor: adapter.vendor });
  deps.logger.info(
    {
      vendor: adapter.vendor,
      yielded: collected.length,
      persisted: outcome.persisted,
      duplicates: outcome.duplicates,
    },
    'poll cycle complete',
  );

  return outcome;
}

/** Handles one inbound webhook delivery: verify raw bytes, then parse, then ingest. */
export async function handleWebhookDelivery(
  adapter: Extract<AlarmAdapter, { mode: 'webhook' }>,
  rawBody: Uint8Array,
  headers: Readonly<Record<string, string>>,
  deps: DispatchDeps,
): Promise<{
  readonly accepted: boolean;
  readonly reason?: string;
  readonly outcome?: IngestOutcome;
}> {
  // Verification runs on the raw bytes BEFORE any parse (divergence D4). A forged
  // webhook must never reach the normalizer.
  const verdict = adapter.verifySignature(rawBody, headers);
  if (!verdict.ok) {
    deps.metrics.counter('webhook_rejected_total', 1, {
      vendor: adapter.vendor,
      reason: verdict.reason,
    });
    deps.logger.warn(
      { vendor: adapter.vendor, reason: verdict.reason },
      'webhook signature rejected',
    );
    return { accepted: false, reason: verdict.reason };
  }

  const events = await adapter.handleWebhook(rawBody, headers);
  const outcome = await ingestEvents(deps, events);
  return { accepted: true, outcome };
}

/** Subscribes to a stream adapter. Returns a handle that unsubscribes AND stops it. */
export async function startStream(
  adapter: Extract<AlarmAdapter, { mode: 'stream' }>,
  deps: DispatchDeps,
  signal: AbortSignal,
): Promise<StreamHandle> {
  const pending: Promise<unknown>[] = [];

  const unsubscribe: Unsubscribe = adapter.onAlarm((event) => {
    // The listener is synchronous by contract, so ingestion is tracked separately and
    // awaited on stop — otherwise stopping the stream could drop in-flight events.
    pending.push(
      ingestEvents(deps, [event]).catch((error: unknown) => {
        deps.logger.error(
          { vendor: adapter.vendor, err: error instanceof Error ? error.message : error },
          'stream event ingestion failed',
        );
      }),
    );
  });

  await adapter.start(signal);

  return {
    async stop() {
      // Unsubscribe first so no new work arrives while draining, then stop the adapter.
      // Leaving this to the caller is how a reconnect loop accumulates listeners.
      unsubscribe();
      await adapter.stop();
      await Promise.allSettled(pending);
    },
  };
}

/**
 * Mode-based dispatch. Returns a description of what was set up, so a caller wiring many
 * adapters can report on each without knowing the mode-specific shapes.
 */
export async function dispatchAdapter(
  adapter: AlarmAdapter,
  source: PollSource,
  deps: DispatchDeps,
  signal: AbortSignal,
): Promise<{ readonly mode: AlarmAdapter['mode']; readonly stream?: StreamHandle }> {
  switch (adapter.mode) {
    case 'poll': {
      await runPollCycle(adapter, source, deps, signal);
      return { mode: 'poll' };
    }
    case 'webhook': {
      // Push-based: nothing to start. Deliveries arrive through handleWebhookDelivery.
      return { mode: 'webhook' };
    }
    case 'stream': {
      const stream = await startStream(adapter, deps, signal);
      return { mode: 'stream', stream };
    }
    default: {
      // If a fourth IngestionMode is ever added, THIS LINE fails to compile until the
      // switch above handles it. That is the guarantee the union exists to provide.
      const exhaustive: never = adapter;
      throw new Error(`Unhandled ingestion mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export type { CursorStore, PollSource };
