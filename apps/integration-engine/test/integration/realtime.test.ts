import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createCapturingLogger, createMetrics } from '@deepsight/observability';
import { makeFakeEvent } from '@deepsight/test-support';
import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import { createRealtimeHub, type RealtimeHub } from '../../src/realtime/hub.js';
import {
  createSessionCodec,
  createSessionRegistry,
  type SessionCodec,
  type SessionRegistry,
} from '../../src/realtime/session.js';
import { startVendorHealthBroadcast } from '../../src/realtime/fanout.js';
import type { VendorHealth, VendorHealthSource } from '../../src/http/app.js';

/**
 * Phase 6 acceptance suite for the realtime transport. Every criterion is asserted at the
 * SOCKET level — what a connected client does and does not receive — not visually.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const ORG_B = '0b000000-0000-4000-8000-000000000002';
const SECRET = 'phase6-dashboard-secret-value';

function redisUrl(): string {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url === '') throw new Error('Phase 6 tests require REDIS_URL.');
  return url;
}

const logger = createCapturingLogger('phase6').logger;
const metrics = createMetrics();

interface HubHandle {
  hub: RealtimeHub;
  port: number;
  codec: SessionCodec;
  registry: SessionRegistry;
}

const hubs: RealtimeHub[] = [];
const clients: ClientSocket[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  for (const h of hubs.splice(0)) await h.close();
});

async function startHub(options?: {
  registry?: SessionRegistry;
  codec?: SessionCodec;
  heartbeatMs?: number;
}): Promise<HubHandle> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const codec = options?.codec ?? createSessionCodec(SECRET);
  const registry = options?.registry ?? createSessionRegistry();
  const hub = createRealtimeHub({
    httpServer: server,
    redisUrl: redisUrl(),
    codec,
    registry,
    logger,
    metrics,
    heartbeatMs: options?.heartbeatMs ?? 200,
  });
  hubs.push(hub);
  return { hub, port: (server.address() as AddressInfo).port, codec, registry };
}

function connect(port: number, token: string): Promise<ClientSocket> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('connect timed out')), 5_000);
  });
}

function alarmFor(orgId: string, id: string): NormalizedAlarmEvent {
  return makeFakeEvent({
    orgId,
    clientId: '0a000000-0000-4000-8000-0000000000c1',
    siteId: '0a000000-0000-4000-8000-0000000000f1',
    vendor: 'axxon',
    vendorEventId: id,
    correlationId: 'phase6',
  });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('AC1 — an event for one org never reaches another org’s socket', () => {
  it('routes an alarm only to its org room', async () => {
    const { hub, port, codec } = await startHub();
    const a = await connect(port, codec.sign({ sid: 'sa', org_id: ORG_A }));
    const b = await connect(port, codec.sign({ sid: 'sb', org_id: ORG_B }));

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    a.on('alarm', (e: NormalizedAlarmEvent) => receivedA.push(e.vendor_event_id));
    b.on('alarm', (e: NormalizedAlarmEvent) => receivedB.push(e.vendor_event_id));

    hub.broadcastAlarm(alarmFor(ORG_A, 'only-for-a'));
    await wait(300);

    expect(receivedA).toEqual(['only-for-a']);
    // The isolation assertion: org B's socket never saw org A's event.
    expect(receivedB).toEqual([]);
  });

  it('refuses a connection with a forged token', async () => {
    const { port } = await startHub();
    const forged = createSessionCodec('the-wrong-secret').sign({ sid: 'x', org_id: ORG_A });
    await expect(connect(port, forged)).rejects.toThrow(/unauthorized/);
  });
});

describe('AC2 — ingestion→dashboard latency stays under 2s at p95 over 100 events', () => {
  it('delivers 100 events with p95 latency well under 2s', async () => {
    const { hub, port, codec } = await startHub();
    const client = await connect(port, codec.sign({ sid: 'sl', org_id: ORG_A }));

    const sentAt = new Map<string, number>();
    const latencies: number[] = [];
    await new Promise<void>((resolve) => {
      client.on('alarm', (e: NormalizedAlarmEvent) => {
        const t0 = sentAt.get(e.vendor_event_id);
        if (t0 !== undefined) latencies.push(Date.now() - t0);
        if (latencies.length === 100) resolve();
      });
      for (let i = 0; i < 100; i += 1) {
        const id = `lat-${i}`;
        sentAt.set(id, Date.now());
        hub.broadcastAlarm(alarmFor(ORG_A, id));
      }
    });

    latencies.sort((x, y) => x - y);
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? Infinity;
    expect(latencies).toHaveLength(100);
    expect(p95).toBeLessThan(2_000);
  });
});

describe('AC3 — the Redis adapter fans out across engine instances', () => {
  it('delivers an event emitted on one instance to a client connected to another', async () => {
    const instance1 = await startHub();
    const instance2 = await startHub({ codec: instance1.codec });

    // Client is connected to instance 1 only.
    const client = await connect(
      instance1.port,
      instance1.codec.sign({ sid: 's1', org_id: ORG_A }),
    );
    const received: string[] = [];
    client.on('alarm', (e: NormalizedAlarmEvent) => received.push(e.vendor_event_id));

    // ...but the event is broadcast from instance 2. Only the Redis adapter can bridge them.
    await wait(150); // let the adapter's subscription settle
    instance2.hub.broadcastAlarm(alarmFor(ORG_A, 'from-instance-2'));

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = setInterval(() => {
        if (received.includes('from-instance-2')) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error('cross-instance event not received within 10s'));
        }
      }, 50);
    });

    expect(received).toContain('from-instance-2');
  });
});

describe('AC4 — a tripped breaker shows on the dashboard within 5s', () => {
  it('pushes updated vendor health to connected clients', async () => {
    const { hub, port, codec } = await startHub();
    const client = await connect(port, codec.sign({ sid: 'sv', org_id: ORG_A }));

    // A health source whose axxon breaker starts closed, then trips open.
    let axxonBreaker: VendorHealth['breaker_state'] = 'closed';
    const source: VendorHealthSource = {
      snapshot: () =>
        Promise.resolve([
          {
            vendor: 'axxon',
            status: axxonBreaker === 'open' ? 'offline' : 'connected',
            breaker_state: axxonBreaker,
          },
        ]),
    };

    const updates: VendorHealth['breaker_state'][] = [];
    client.on('vendor:health', (health: readonly VendorHealth[]) => {
      const axxon = health.find((h) => h.vendor === 'axxon');
      if (axxon !== undefined) updates.push(axxon.breaker_state);
    });

    const broadcaster = startVendorHealthBroadcast({ hub, source, logger, intervalMs: 200 });
    try {
      await wait(300); // a couple of ticks showing 'closed'
      axxonBreaker = 'open'; // the breaker trips
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        const poll = setInterval(() => {
          if (updates.includes('open')) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error('breaker-open never reached the dashboard within 5s'));
          }
        }, 50);
      });
      expect(updates).toContain('open');
    } finally {
      broadcaster.close();
    }
  });
});

describe('AC5 — a revoked session is disconnected on its next heartbeat', () => {
  it('drops a live socket once its session is revoked', async () => {
    const registry = createSessionRegistry();
    const { port, codec } = await startHub({ registry, heartbeatMs: 200 });
    const client = await connect(port, codec.sign({ sid: 'to-revoke', org_id: ORG_A }));

    const disconnected = new Promise<string>((resolve) => {
      client.on('disconnect', (reason: string) => resolve(reason));
    });

    // Revoke the live session; the heartbeat sweep must drop it, not merely block reconnects.
    registry.revoke('to-revoke');
    const reason = await Promise.race([disconnected, wait(3_000).then(() => 'NOT-DISCONNECTED')]);
    expect(reason).not.toBe('NOT-DISCONNECTED');
  });
});
