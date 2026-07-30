import type { NormalizedAlarmEvent, NormalizedAttendanceRecord, VendorId } from './events.js';

/**
 * Adapter contracts (divergences D3 and D4).
 *
 * The brief's draft made every ingestion method optional (`poll?`, `handleWebhook?`,
 * `start?`). A misconfigured or half-written adapter then type-checks fine and
 * SILENTLY INGESTS NOTHING — the worst possible failure mode for an alarm system,
 * because a silent no-op is indistinguishable from "no alarms occurred".
 *
 * A discriminated union on `mode` forces the engine to switch exhaustively, so adding
 * a vendor with a new ingestion style is a compile error until it is wired in.
 */

export type IngestionMode = 'poll' | 'webhook' | 'stream';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface AdapterHealth {
  readonly vendor: VendorId;
  readonly status: 'connected' | 'degraded' | 'offline';
  readonly latency_ms?: number | undefined;
  readonly last_event_at?: Date | undefined;
  readonly error?: string | undefined;
  /** Exported per vendor as a metric; alerted on if open beyond 60 seconds. */
  readonly breaker_state: BreakerState;
}

interface AlarmAdapterBase {
  readonly vendor: VendorId;
  readonly mode: IngestionMode;
  healthCheck(): Promise<AdapterHealth>;
}

/** Opaque, vendor-defined resume point. Persisted in `alarm_sources.poll_cursor`. */
export type PollCursor = { readonly value: string } | null;

export interface PollingAlarmAdapter extends AlarmAdapterBase {
  readonly mode: 'poll';
  /**
   * Yields events and returns the cursor to persist for the next run.
   *
   * The brief's draft `poll()` had no resume point, forcing an adapter to either
   * re-fetch all history every run or hide cursor state internally — untestable, and
   * lost on every redeploy. The AbortSignal exists because Railway sends SIGTERM on
   * redeploy, and without a cancellation path an in-flight poll dies mid-write.
   */
  poll(
    cursor: PollCursor,
    signal: AbortSignal,
  ): AsyncGenerator<NormalizedAlarmEvent, PollCursor, void>;
}

export type SignatureVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface WebhookAlarmAdapter extends AlarmAdapterBase {
  readonly mode: 'webhook';
  /**
   * MUST run on raw bytes, before any parse (divergence D4).
   *
   * HMAC is computed over the exact received bytes. The brief's draft passed parsed
   * JSON, which makes verification impossible: any re-serialization (key order,
   * whitespace, unicode escaping) yields a different digest, so verification fails —
   * or worse, someone "fixes" it by skipping verification.
   */
  verifySignature(rawBody: Uint8Array, headers: Readonly<Record<string, string>>): SignatureVerdict;
  handleWebhook(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<readonly NormalizedAlarmEvent[]>;
}

export type Unsubscribe = () => void;

export interface StreamAlarmAdapter extends AlarmAdapterBase {
  readonly mode: 'stream';
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  /**
   * Returns an unsubscribe function rather than `this`.
   *
   * The brief's draft `on(): this` is the EventEmitter idiom, and in a process whose
   * entire job is reconnecting forever it is a listener leak: every reconnect adds a
   * handler that nothing removes. Returning an unsubscribe makes teardown mandatory
   * and reviewable — which is the whole reason this worker runs isolated.
   */
  onAlarm(listener: (event: NormalizedAlarmEvent) => void): Unsubscribe;
}

export type AlarmAdapter = PollingAlarmAdapter | WebhookAlarmAdapter | StreamAlarmAdapter;

export interface AttendanceSource {
  readonly vendor: VendorId;
  fetchAttendance(
    siteId: string,
    from: Date,
    to: Date,
    signal: AbortSignal,
  ): Promise<readonly NormalizedAttendanceRecord[]>;
}

/**
 * Exhaustiveness guard for the union above. Placed in the default branch of a switch
 * on `adapter.mode`, it turns "a new ingestion mode was added and nobody wired it up"
 * from a silent runtime no-op into a compile error.
 */
export function assertNeverMode(mode: never): never {
  throw new Error(`Unhandled ingestion mode: ${JSON.stringify(mode)}`);
}
