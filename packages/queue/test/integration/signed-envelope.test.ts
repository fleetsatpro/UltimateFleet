import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  createAlerts,
  createCapturingLogger,
  createMetrics,
  type Alerts,
  type Metrics,
} from '@deepsight/observability';
import { QUEUE_NAMES, createQueueFactory, type QueueFactory } from '../../src/factory.js';
import { canonicalJson, createEnvelopeSigner } from '../../src/envelope.js';

/**
 * Phase 2 acceptance criterion 6: a tampered job envelope is rejected BEFORE its handler
 * runs.
 *
 * The brief mandates BullMQ between the AxxonSoft worker and the engine and forbids direct
 * HTTP, so HTTP-level auth covers none of that traffic — a job written straight into the
 * shared Redis bypasses it entirely. Verification therefore lives inside the worker
 * factory, which is what makes "the handler never sees an unverified payload" a structural
 * fact rather than a convention someone can forget.
 */

function redisUrl(): string {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url === '') {
    throw new Error('Queue integration tests require REDIS_URL (see .env.example).');
  }
  return url;
}

const SIGNING = {
  current: { kid: 'k2', secret: 'current-secret-value' },
  previous: { kid: 'k1', secret: 'previous-secret-value' },
} as const;

let factory: QueueFactory | null = null;
let attackerConnection: Redis | null = null;
let attackerQueue: Queue | null = null;
let metrics: Metrics;
let alerts: Alerts;

function makeFactory(): QueueFactory {
  const capture = createCapturingLogger('queue-test');
  metrics = createMetrics();
  alerts = createAlerts(capture.logger);
  const created = createQueueFactory({
    redisUrl: redisUrl(),
    service: 'axxon-worker',
    signing: SIGNING,
    logger: capture.logger,
    metrics,
    alerts,
  });
  factory = created;
  return created;
}

afterEach(async () => {
  vi.useRealTimers();
  if (attackerQueue !== null) {
    await attackerQueue.close();
    attackerQueue = null;
  }
  if (attackerConnection !== null) {
    attackerConnection.disconnect();
    attackerConnection = null;
  }
  if (factory !== null) {
    await factory.close();
    factory = null;
  }
});

/** Waits for a condition instead of sleeping — a bare sleep is either flaky or slow. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('AC6 — signature verification precedes handling', () => {
  it('delivers a correctly signed payload to the handler', async () => {
    const queues = makeFactory();
    const queue = queues.queue<{ value: string }>(QUEUE_NAMES.alarmIngest);
    await queue.drain();

    const handled: string[] = [];
    queues.worker<{ value: string }>(QUEUE_NAMES.alarmIngest, async (payload) => {
      handled.push(payload.value);
    });

    await queue.add('probe', { value: 'signed-ok' });
    await until(() => handled.length === 1);

    expect(handled).toEqual(['signed-ok']);
    expect(alerts.fired()).toEqual([]);
  });

  it('never invokes the handler for a tampered signature', async () => {
    const queues = makeFactory();
    const queue = queues.queue<{ value: string }>(QUEUE_NAMES.mediaFetch);
    await queue.drain();

    const handled: string[] = [];
    queues.worker<{ value: string }>(QUEUE_NAMES.mediaFetch, async (payload) => {
      handled.push(payload.value);
    });

    // Models the actual threat: someone with Redis access writing a job directly, bypassing
    // our signing path entirely. Using the factory's own queue here would re-sign the
    // forged payload and prove nothing.
    attackerConnection = new Redis(redisUrl(), { maxRetriesPerRequest: null });
    attackerQueue = new Queue(QUEUE_NAMES.mediaFetch, { connection: attackerConnection });

    const legitimate = queues.signer.sign({ value: 'original' }, 'axxon-worker');
    const forged = { ...legitimate, payload: { value: 'tampered' } };
    await attackerQueue.add('forged', forged, { attempts: 1 });

    await until(() => alerts.fired().some((a) => a.name === 'queue_job_signature_invalid'));

    // The decisive assertion: the handler was never reached.
    expect(handled).toEqual([]);

    const alert = alerts.fired().find((a) => a.name === 'queue_job_signature_invalid');
    expect(alert?.severity).toBe('critical');
    expect(alert?.context['reason']).toMatch(/signature mismatch/);
    expect(metrics.snapshot().some((s) => s.name === 'queue_jobs_rejected_total')).toBe(true);
  });

  it('rejects a job carrying no envelope at all', async () => {
    const queues = makeFactory();
    const queue = queues.queue<{ value: string }>(QUEUE_NAMES.reportRun);
    await queue.drain();

    const handled: unknown[] = [];
    queues.worker<{ value: string }>(QUEUE_NAMES.reportRun, async (payload) => {
      handled.push(payload);
    });

    attackerConnection = new Redis(redisUrl(), { maxRetriesPerRequest: null });
    attackerQueue = new Queue(QUEUE_NAMES.reportRun, { connection: attackerConnection });
    await attackerQueue.add('bare', { value: 'no envelope' }, { attempts: 1 });

    await until(() => alerts.fired().some((a) => a.name === 'queue_job_signature_invalid'));
    expect(handled).toEqual([]);
  });
});

describe('envelope signing semantics', () => {
  const signer = createEnvelopeSigner(SIGNING);

  it('accepts a payload signed with the previous key during rotation', () => {
    const previousOnly = createEnvelopeSigner({ current: SIGNING.previous });
    const envelope = previousOnly.sign({ hello: 'world' }, 'report-worker');

    // Rotation is: previous <- current, current <- new, redeploy. Accepting both keys is
    // what removes the need for a coordinated restart or an outage window.
    const verdict = signer.verify<{ hello: string }>(envelope);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.payload.hello).toBe('world');
  });

  it('rejects an unknown kid', () => {
    const foreign = createEnvelopeSigner({ current: { kid: 'attacker', secret: 'nope' } });
    expect(signer.verify(foreign.sign({ a: 1 }, 'axxon-worker'))).toEqual({
      ok: false,
      reason: 'unknown kid "attacker"',
    });
  });

  it('rejects a replayed envelope once past the age window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));

    const shortLived = createEnvelopeSigner({ current: SIGNING.current, maxAgeMs: 60_000 });
    const envelope = shortLived.sign({ a: 1 }, 'axxon-worker');

    // Still fresh.
    expect(shortLived.verify(envelope).ok).toBe(true);

    // A captured job replayed later: the signature is still perfectly valid, which is
    // precisely why `iat` and a max age are needed to bound replay.
    vi.setSystemTime(new Date('2026-06-01T12:05:00Z'));
    const verdict = shortLived.verify(envelope);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/too old/);
  });

  it('signs the data, not the key insertion order', () => {
    // JSON.stringify follows insertion order, so two structurally identical objects can
    // serialize differently and produce different digests. Canonical JSON makes the
    // signature depend on the data — the same class of bug as verifying an HMAC against
    // re-serialized JSON (divergence D4).
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));

    const envelope = signer.sign({ b: 1, a: 2 }, 'axxon-worker');
    const reordered = { ...envelope, payload: { a: 2, b: 1 } };

    // Same data, different key order, same signature: verification survives a round trip
    // through any JSON serializer that does not preserve ordering.
    expect(signer.verify(reordered).ok).toBe(true);
  });

  it('rejects a payload whose content changed even by one character', () => {
    const envelope = signer.sign({ value: 'original' }, 'axxon-worker');
    expect(signer.verify({ ...envelope, payload: { value: 'originaI' } }).ok).toBe(false);
  });

  it('rejects a non-object envelope', () => {
    expect(signer.verify('not-an-envelope')).toEqual({
      ok: false,
      reason: 'envelope is not an object',
    });
  });
});
