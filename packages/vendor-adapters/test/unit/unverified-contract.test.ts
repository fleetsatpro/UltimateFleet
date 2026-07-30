import { describe, expect, it } from 'vitest';
import type { VendorId } from '@deepsight/contracts';
import {
  AxxonAdapter,
  DahuaAdapter,
  GuardTekAdapter,
  createAdapter,
  createAllAdapters,
} from '../../src/registry.js';
import { UnverifiedVendorContractError } from '../../src/unverified.js';

/**
 * Phase 3 acceptance criteria 1 and 2.
 *
 * AC1: every adapter satisfies its interface (proven by the fact this file type-checks
 * while treating them as the real interface types) and the package contains no `any`
 * (enforced by lint — @typescript-eslint/no-explicit-any is an error and no disable
 * comment appears in src/).
 *
 * AC2: every vendor-facing operation throws UNVERIFIED_VENDOR_CONTRACT with a message
 * naming what must be confirmed. Asserted PER METHOD, so no method can be silently empty
 * or quietly return a fabricated value.
 */

const ABORT = new AbortController().signal;

describe('AC1 — adapters are registered and typed', () => {
  it('creates one adapter per VendorId with matching vendor and mode', () => {
    const cases: { vendor: VendorId; mode: string }[] = [
      { vendor: 'guardtek', mode: 'poll' },
      { vendor: 'dahua', mode: 'webhook' },
      { vendor: 'axxon', mode: 'stream' },
    ];
    for (const { vendor, mode } of cases) {
      const adapter = createAdapter(vendor);
      expect(adapter.vendor).toBe(vendor);
      expect(adapter.mode).toBe(mode);
    }
  });

  it('createAllAdapters returns exactly the three vendors', () => {
    const vendors = createAllAdapters()
      .map((a) => a.vendor)
      .sort();
    expect(vendors).toEqual(['axxon', 'dahua', 'guardtek']);
  });

  it('reports offline health honestly rather than faking a connection', async () => {
    for (const adapter of createAllAdapters()) {
      const health = await adapter.healthCheck();
      expect(health.vendor).toBe(adapter.vendor);
      // Not connected to anything, and says so — the dashboard shows it offline pending
      // contract confirmation instead of a fabricated 'connected'.
      expect(health.status).toBe('offline');
      expect(health.breaker_state).toBe('closed');
      expect(health.error).toMatch(/UNVERIFIED_VENDOR_CONTRACT/);
    }
  });
});

/** Collects the error thrown by an operation, whether it throws sync or rejects async. */
async function captureError(op: () => unknown): Promise<unknown> {
  try {
    await op();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to throw UNVERIFIED_VENDOR_CONTRACT, but it did not');
}

function expectUnverified(error: unknown, vendor: string, operation: string): void {
  expect(error).toBeInstanceOf(UnverifiedVendorContractError);
  const typed = error as UnverifiedVendorContractError;
  expect(typed.message).toMatch(/^UNVERIFIED_VENDOR_CONTRACT: /);
  expect(typed.vendor).toBe(vendor);
  expect(typed.operation).toBe(operation);
  // The message must name something concrete to confirm, not merely say "unverified".
  expect(typed.message.length).toBeGreaterThan(60);
}

describe('AC2 — every unverified operation throws, naming what to confirm', () => {
  it('GuardTek.poll', async () => {
    const adapter = new GuardTekAdapter();
    // Draining the generator is what triggers the throw — poll() returns a generator.
    const error = await captureError(() => adapter.poll(null, ABORT).next());
    expectUnverified(error, 'guardtek', 'poll');
    expect((error as Error).message).toMatch(/WSDL/);
  });

  it('GuardTek.fetchAttendance', async () => {
    const adapter = new GuardTekAdapter();
    const error = await captureError(() =>
      adapter.fetchAttendance('site', new Date(0), new Date(), ABORT),
    );
    expectUnverified(error, 'guardtek', 'fetchAttendance');
    expect((error as Error).message).toMatch(/attendance/i);
  });

  it('Dahua.verifySignature', async () => {
    const adapter = new DahuaAdapter();
    const error = await captureError(() =>
      adapter.verifySignature(new Uint8Array([1, 2, 3]), { 'x-sig': 'abc' }),
    );
    expectUnverified(error, 'dahua', 'verifySignature');
    expect((error as Error).message).toMatch(/signature scheme/i);
  });

  it('Dahua.handleWebhook', async () => {
    const adapter = new DahuaAdapter();
    const error = await captureError(() => adapter.handleWebhook(new Uint8Array(), {}));
    expectUnverified(error, 'dahua', 'handleWebhook');
    expect((error as Error).message).toMatch(/payload schema/i);
  });

  it('Axxon.start', async () => {
    const adapter = new AxxonAdapter();
    const error = await captureError(() => adapter.start(ABORT));
    expectUnverified(error, 'axxon', 'start');
    expect((error as Error).message).toMatch(/endpoint/i);
  });
});

describe('operations safe to implement without the vendor contract are implemented', () => {
  it('Axxon subscription bookkeeping works and does not leak listeners', () => {
    const adapter = new AxxonAdapter();
    expect(adapter.listenerCount()).toBe(0);

    const received: string[] = [];
    const unsubscribe = adapter.onAlarm((e) => received.push(e.internal_id));
    expect(adapter.listenerCount()).toBe(1);

    adapter.emit({
      internal_id: 'evt-1',
      vendor: 'axxon',
      vendor_event_id: 've-1',
      org_id: 'o',
      client_id: 'c',
      site_id: 's',
      event_type: 'fire',
      severity: 'critical',
      occurred_at: new Date(),
      received_at: new Date(),
      raw_payload: {},
      media_urls: [],
      correlation_id: 'corr',
      vendor_event_code: null,
    });
    expect(received).toEqual(['evt-1']);

    // Returning an Unsubscribe (not `this`) is what keeps a reconnect loop from leaking a
    // listener per reconnect in the dedicated Phase 4 worker.
    unsubscribe();
    expect(adapter.listenerCount()).toBe(0);
  });

  it('Axxon.stop clears listeners without needing the transport contract', async () => {
    const adapter = new AxxonAdapter();
    adapter.onAlarm(() => {});
    expect(adapter.listenerCount()).toBe(1);
    await adapter.stop();
    expect(adapter.listenerCount()).toBe(0);
  });
});
