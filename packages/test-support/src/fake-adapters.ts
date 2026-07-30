import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AlarmSeverity,
  NormalizedAlarmEvent,
  NormalizedEventType,
  PollCursor,
  PollingAlarmAdapter,
  SignatureVerdict,
  StreamAlarmAdapter,
  Unsubscribe,
  VendorId,
  WebhookAlarmAdapter,
} from '@deepsight/contracts';

/**
 * Fake adapters, one per ingestion mode.
 *
 * These exist so the ingestion core is fully testable while every real vendor contract is
 * unverified (open items 1-3). They implement the REAL interfaces — no `any`, no partial
 * shapes — which is what makes them meaningful: if the union or a method signature
 * changes, these fail to compile alongside the real adapters.
 *
 * They are not mocks posing as vendors. Nothing here claims to reproduce GuardTek, Dahua
 * or AxxonSoft behaviour; they exercise the *core's* contract with an adapter.
 */

export interface FakeEventOptions {
  readonly orgId: string;
  readonly clientId: string;
  readonly siteId: string;
  readonly vendor?: VendorId | undefined;
  readonly vendorEventId: string;
  readonly vendorEventCode?: string | null | undefined;
  readonly eventType?: NormalizedEventType | undefined;
  readonly severity?: AlarmSeverity | undefined;
  readonly occurredAt?: Date | undefined;
  readonly correlationId?: string | undefined;
  readonly internalId?: string | undefined;
}

let internalIdCounter = 0;

/** Deterministic UUID generator, so a failing test names a stable id. */
function syntheticUuid(prefix: string): string {
  internalIdCounter += 1;
  const tail = String(internalIdCounter).padStart(12, '0');
  return `${prefix}-0000-4000-8000-${tail}`;
}

export function makeFakeEvent(options: FakeEventOptions): NormalizedAlarmEvent {
  const occurred = options.occurredAt ?? new Date('2026-06-01T10:00:00Z');
  return {
    internal_id: options.internalId ?? syntheticUuid('fa4e0000'),
    vendor: options.vendor ?? 'dahua',
    vendor_event_id: options.vendorEventId,
    org_id: options.orgId,
    client_id: options.clientId,
    site_id: options.siteId,
    event_type: options.eventType ?? 'unknown',
    severity: options.severity ?? 'low',
    occurred_at: occurred,
    received_at: new Date(occurred.getTime() + 1_000),
    raw_payload: { fake: true, vendorEventId: options.vendorEventId },
    media_urls: [],
    correlation_id: options.correlationId ?? 'fake-correlation',
    vendor_event_code: options.vendorEventCode === undefined ? '1001' : options.vendorEventCode,
  };
}

/** Resets the synthetic id counter so a suite's ids are stable run to run. */
export function resetFakeEventIds(): void {
  internalIdCounter = 0;
}

export interface FakePollAdapter extends PollingAlarmAdapter {
  /** Cursor values observed on each call, so resumption can be asserted. */
  readonly seenCursors: PollCursor[];
  setBatch(events: readonly NormalizedAlarmEvent[], nextCursor: PollCursor): void;
}

export function createFakePollAdapter(vendor: VendorId = 'guardtek'): FakePollAdapter {
  let batch: readonly NormalizedAlarmEvent[] = [];
  let next: PollCursor = null;
  const seenCursors: PollCursor[] = [];

  return {
    vendor,
    mode: 'poll',
    seenCursors,
    setBatch(events, nextCursor) {
      batch = events;
      next = nextCursor;
    },
    healthCheck() {
      return Promise.resolve({
        vendor,
        status: 'connected' as const,
        breaker_state: 'closed' as const,
        latency_ms: 12,
      });
    },
    async *poll(cursor, signal) {
      seenCursors.push(cursor);
      for (const event of batch) {
        // Honouring the signal is part of the contract: Railway sends SIGTERM on every
        // redeploy, and an adapter that ignores it dies mid-write.
        if (signal.aborted) break;
        yield event;
      }
      return next;
    },
  };
}

const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/** Signs a body the way the fake webhook adapter expects. Exported so tests can forge. */
export function signFakeWebhook(rawBody: Uint8Array, secret = FAKE_WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export interface FakeWebhookAdapter extends WebhookAlarmAdapter {
  /** Bodies that reached handleWebhook — must stay empty when a signature is rejected. */
  readonly handled: Uint8Array[];
}

export function createFakeWebhookAdapter(vendor: VendorId = 'dahua'): FakeWebhookAdapter {
  const handled: Uint8Array[] = [];

  return {
    vendor,
    mode: 'webhook',
    handled,
    healthCheck() {
      return Promise.resolve({
        vendor,
        status: 'connected' as const,
        breaker_state: 'closed' as const,
      });
    },
    verifySignature(rawBody, headers): SignatureVerdict {
      const provided = headers[FAKE_SIGNATURE_HEADER];
      if (provided === undefined) return { ok: false, reason: 'missing signature header' };

      // Computed over the exact received bytes, which is only possible because the
      // interface takes rawBody rather than parsed JSON (divergence D4).
      const expected = signFakeWebhook(rawBody);
      const expectedBytes = Buffer.from(expected, 'utf8');
      const providedBytes = Buffer.from(provided, 'utf8');
      if (expectedBytes.length !== providedBytes.length) {
        return { ok: false, reason: 'signature length mismatch' };
      }
      return timingSafeEqual(expectedBytes, providedBytes)
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
    },
    handleWebhook(rawBody) {
      handled.push(rawBody);
      const parsed = JSON.parse(Buffer.from(rawBody).toString('utf8')) as {
        events?: unknown[];
      };
      // Dates survive JSON as strings; the core's zod schema coerces, so revive them here
      // the way a real adapter would.
      const events = (parsed.events ?? []).map((raw) => {
        const record = raw as Record<string, unknown>;
        return {
          ...record,
          occurred_at: new Date(String(record['occurred_at'])),
          received_at: new Date(String(record['received_at'])),
        } as NormalizedAlarmEvent;
      });
      return Promise.resolve(events);
    },
  };
}

export interface FakeStreamAdapter extends StreamAlarmAdapter {
  emit(event: NormalizedAlarmEvent): void;
  /** Live listener count — proves unsubscribe actually detaches across reconnects. */
  listenerCount(): number;
  readonly starts: number[];
}

export function createFakeStreamAdapter(vendor: VendorId = 'axxon'): FakeStreamAdapter {
  const listeners = new Set<(event: NormalizedAlarmEvent) => void>();
  const starts: number[] = [];
  let running = false;

  return {
    vendor,
    mode: 'stream',
    starts,
    healthCheck() {
      return Promise.resolve({
        vendor,
        status: running ? ('connected' as const) : ('offline' as const),
        breaker_state: 'closed' as const,
      });
    },
    start(_signal) {
      running = true;
      starts.push(Date.now());
      return Promise.resolve();
    },
    stop() {
      running = false;
      return Promise.resolve();
    },
    onAlarm(listener): Unsubscribe {
      listeners.add(listener);
      // Returning an unsubscribe rather than `this` is what makes teardown mandatory; in
      // a process whose job is reconnecting forever, `on(): this` is a listener leak.
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

/**
 * A controllable stream source for testing the AxxonSoft worker's reconnect behaviour.
 *
 * Unlike createFakeStreamAdapter, its start() BLOCKS while "connected" and only settles
 * when the test drives it — resolving on disconnect() (a clean stream close) or rejecting
 * when setDown(true) makes the next connect fail (an unreachable endpoint). That is what
 * lets a test simulate a 45-second outage, count reconnects, and assert no events are lost.
 */
export interface ControllableStreamSource extends StreamAlarmAdapter {
  emit(event: NormalizedAlarmEvent): void;
  listenerCount(): number;
  /** Number of times start() has been invoked — i.e. connection attempts. */
  connectAttempts(): number;
  /** Whether a connection is currently established. */
  isConnected(): boolean;
  /** Ends the current connection cleanly (start() resolves), simulating a dropped stream. */
  disconnect(): void;
  /** When true, start() rejects immediately, simulating an unreachable endpoint. */
  setDown(down: boolean): void;
}

export function createControllableStreamSource(
  vendor: VendorId = 'axxon',
): ControllableStreamSource {
  const listeners = new Set<(event: NormalizedAlarmEvent) => void>();
  let attempts = 0;
  let connected = false;
  let down = false;
  let resolveCurrent: (() => void) | null = null;

  return {
    vendor,
    mode: 'stream',
    healthCheck() {
      return Promise.resolve({
        vendor,
        status: connected ? ('connected' as const) : ('offline' as const),
        breaker_state: 'closed' as const,
      });
    },
    start(signal) {
      attempts += 1;
      if (down) {
        // Unreachable endpoint: reject so the consumer backs off and retries.
        return Promise.reject(new Error('axxon endpoint unreachable'));
      }
      connected = true;
      return new Promise<void>((resolve) => {
        resolveCurrent = () => {
          connected = false;
          resolveCurrent = null;
          resolve();
        };
        // A shutdown abort also ends the connection cleanly.
        signal.addEventListener(
          'abort',
          () => {
            if (resolveCurrent !== null) resolveCurrent();
          },
          { once: true },
        );
      });
    },
    stop() {
      if (resolveCurrent !== null) resolveCurrent();
      return Promise.resolve();
    },
    onAlarm(listener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    listenerCount() {
      return listeners.size;
    },
    connectAttempts() {
      return attempts;
    },
    isConnected() {
      return connected;
    },
    disconnect() {
      if (resolveCurrent !== null) resolveCurrent();
    },
    setDown(value) {
      down = value;
    },
  };
}
