import type {
  AdapterHealth,
  NormalizedAlarmEvent,
  StreamAlarmAdapter,
  Unsubscribe,
} from '@deepsight/contracts';
import { unverified } from '../unverified.js';

/**
 * AxxonSoft — long-poll/stream based.
 *
 * start and stop throw UNVERIFIED_VENDOR_CONTRACT: the stream endpoint, its framing, and
 * its auth are unconfirmed (open item 3). onAlarm is the one method safe to implement now,
 * because it is pure local subscription bookkeeping with no vendor contract involved — and
 * building it correctly here is what lets the isolated AxxonSoft worker (Phase 4) register
 * listeners without leaking them across reconnects.
 *
 * This adapter runs inside a DEDICATED Railway service (Phase 4), not the integration
 * engine, so its reconnect lifecycle and memory profile stay isolated. That is why onAlarm
 * returns an Unsubscribe rather than `this`: in a process whose whole job is reconnecting
 * forever, `on(): this` accumulates a handler per reconnect that nothing removes.
 */
export class AxxonAdapter implements StreamAlarmAdapter {
  public readonly vendor = 'axxon' as const;
  public readonly mode = 'stream' as const;

  readonly #listeners = new Set<(event: NormalizedAlarmEvent) => void>();

  healthCheck(): Promise<AdapterHealth> {
    return Promise.resolve({
      vendor: this.vendor,
      status: 'offline',
      breaker_state: 'closed',
      error: 'UNVERIFIED_VENDOR_CONTRACT: AxxonSoft stream endpoint not confirmed',
    });
  }

  start(_signal: AbortSignal): Promise<void> {
    return Promise.resolve(
      unverified(
        'axxon',
        'start',
        'confirm the long-poll/stream endpoint URL, the frame format (chunked JSON? ' +
          'SSE? a proprietary framing?), the auth scheme, and the keep-alive/heartbeat ' +
          'contract so reconnect-with-jitter can distinguish idle from disconnected',
      ),
    );
  }

  stop(): Promise<void> {
    // Safe and correct regardless of the unverified transport: drop local listeners so a
    // stopped adapter holds no references. The transport teardown itself is deferred with
    // start(), where the endpoint contract lives.
    this.#listeners.clear();
    return Promise.resolve();
  }

  onAlarm(listener: (event: NormalizedAlarmEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Delivers an event to current listeners. Not part of the AlarmAdapter interface — it is
   * the seam the (unverified) transport will call once start() is implemented, and it lets
   * the subscription bookkeeping be tested now without a live stream.
   */
  emit(event: NormalizedAlarmEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  listenerCount(): number {
    return this.#listeners.size;
  }
}
