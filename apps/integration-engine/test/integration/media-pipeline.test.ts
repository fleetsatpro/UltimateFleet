import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  getIncidentMedia,
  initPool,
  insertAlarmEvent,
  insertPendingMedia,
  withOrg,
  type MediaRefInput,
} from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { QUEUE_NAMES, createQueueFactory, type QueueFactory } from '@deepsight/queue';
import {
  appDatabaseUrl,
  createLocalObjectStore,
  makeFakeEvent,
  type LocalObjectStore,
} from '@deepsight/test-support';
import type { ObjectStore } from '@deepsight/storage-r2';
import { createEngineCore } from '../../src/core.js';
import { createMediaEnqueuer } from '../../src/media/enqueue.js';
import { createMediaUrlIssuer } from '../../src/media/access.js';
import { createMediaFetchHandler } from '../../src/media/worker.js';
import type { MediaFetchJob } from '../../src/media/job.js';

/**
 * Phase 5 acceptance suite: the media pipeline fetches expiring vendor URLs and streams them
 * into object storage, records the outcome on incident_media, orders work by expiry, and never
 * lets a media failure touch the parent alarm event — all against a real object store (the
 * local HTTP implementation of the R2 interface) and a real database.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';
const SIGNING = { current: { kid: 'k1', secret: 'phase5-secret' } } as const;

function redisUrl(): string {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url === '') throw new Error('Phase 5 tests require REDIS_URL.');
  return url;
}

const capture = createCapturingLogger('phase5');
const metrics = createMetrics();
const alerts = createAlerts(capture.logger);

let store: LocalObjectStore | null = null;
let queues: QueueFactory | null = null;
const vendors: Server[] = [];

beforeAll(() => {
  initPool({ connectionString: appDatabaseUrl(), max: 8 });
});

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  if (store !== null) {
    await store.close();
    store = null;
  }
  if (queues !== null) {
    await queues.close();
    queues = null;
  }
  for (const v of vendors.splice(0)) await new Promise<void>((r) => v.close(() => r()));
  // incident_media before alarm_events: the media rows carry the FK to the event.
  await withOrg(ORG_A, async (tx) => {
    await tx.query(
      `DELETE FROM incident_media WHERE org_id = $1 AND alarm_event_id IN
                      (SELECT internal_id FROM alarm_events WHERE correlation_id = 'phase5')`,
      [ORG_A],
    );
    await tx.query(`DELETE FROM alarm_events WHERE correlation_id = 'phase5'`);
  });
});

async function startVendor(
  handler: (path: string, res: import('node:http').ServerResponse) => void,
): Promise<string> {
  const server = createServer((req, res) => handler(req.url ?? '/', res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vendors.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function seedAlarm(internalId: string, vendorEventId: string): Promise<void> {
  const event = makeFakeEvent({
    orgId: ORG_A,
    clientId: CLIENT_A1,
    siteId: SITE_A1_1,
    vendor: 'axxon',
    vendorEventId,
    internalId,
    correlationId: 'phase5',
    vendorEventCode: null,
    eventType: 'intrusion',
  });
  await withOrg(ORG_A, (tx) => insertAlarmEvent(tx, event));
}

async function seedPending(
  alarmEventId: string,
  refs: readonly MediaRefInput[],
): Promise<readonly { id: string; source_url: string; expires_at: Date | null }[]> {
  return withOrg(ORG_A, (tx) =>
    insertPendingMedia(tx, { orgId: ORG_A, clientId: CLIENT_A1, alarmEventId, refs }),
  );
}

function jobFor(
  row: { id: string; source_url: string },
  alarmEventId: string,
  kind: MediaFetchJob['kind'] = 'image',
): MediaFetchJob {
  return {
    media_id: row.id,
    org_id: ORG_A,
    client_id: CLIENT_A1,
    alarm_event_id: alarmEventId,
    source_url: row.source_url,
    kind,
    correlation_id: 'phase5',
  };
}

describe('AC1 — an expiring vendor URL is fetched and persisted, key recorded, no bytes in PG', () => {
  it('stores the object within the URL lifetime and records only its key', async () => {
    const vendor = await startVendor((path, res) => {
      if (path === '/img') {
        res.writeHead(200, { 'content-type': 'image/jpeg' }).end(Buffer.from('a tiny image'));
      } else res.writeHead(404).end();
    });
    const alarm = '05000000-0000-4000-8000-000000000001';
    await seedAlarm(alarm, 'phase5-ac1');
    const [row] = await seedPending(alarm, [
      { source_url: `${vendor}/img`, kind: 'image', expires_at: new Date(Date.now() + 30_000) },
    ]);

    store = await createLocalObjectStore();
    const handle = createMediaFetchHandler({
      objectStore: store,
      logger: capture.logger,
      metrics,
      alerts,
    });

    const started = Date.now();
    await handle(jobFor(row!, alarm));
    expect(Date.now() - started).toBeLessThan(30_000);

    const stored = await withOrg(ORG_A, (tx) => getIncidentMedia(tx, row!.id));
    expect(stored?.status).toBe('stored');
    expect(stored?.r2_object_key).toBeTruthy();
    expect(store.keys()).toContain(stored?.r2_object_key);
  });

  it('has no binary column on incident_media (checked against information_schema)', async () => {
    const cols = await withOrg(ORG_A, (tx) =>
      tx.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = 'incident_media'`,
      ),
    );
    expect(cols.rows.length).toBeGreaterThan(0);
    // The bytes live in R2; PostgreSQL holds the key. A bytea column here would be the bug.
    expect(cols.rows.some((c) => c.data_type === 'bytea')).toBe(false);
  });
});

describe('AC2 — a large object streams through with a flat memory profile', () => {
  it('moves 50 MB through the worker in bounded chunks, never one buffer', async () => {
    const SIZE = 50 * 1024 * 1024;
    const CHUNK = Buffer.alloc(64 * 1024, 1);
    const vendor = await startVendor((path, res) => {
      if (path !== '/big') {
        res.writeHead(404).end();
        return;
      }
      let sent = 0;
      const source = new Readable({
        read() {
          if (sent >= SIZE) {
            this.push(null);
            return;
          }
          const n = Math.min(CHUNK.length, SIZE - sent);
          sent += n;
          this.push(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n));
        },
      });
      res.writeHead(200, { 'content-type': 'video/mp4' });
      source.pipe(res);
    });

    const alarm = '05000000-0000-4000-8000-000000000002';
    await seedAlarm(alarm, 'phase5-ac2');
    const [row] = await seedPending(alarm, [
      { source_url: `${vendor}/big`, kind: 'video', expires_at: null },
    ]);

    // A counting store observes exactly how the worker hands over the object. Measuring the
    // handover deterministically beats measuring process RSS, which is dominated by transient
    // chunk garbage and undici pool buffers that survive a GC — noisy enough to be useless. The
    // property is unambiguous here: a worker that buffered (an `await res.arrayBuffer()`) would
    // deliver the whole 50 MB as ONE chunk. A streaming worker delivers many bounded chunks and
    // never materialises the object. That distinction is what "streaming, not buffering" means.
    let chunkCount = 0;
    let maxChunk = 0;
    let total = 0;
    const countingStore: ObjectStore = {
      async put(_key, body) {
        for await (const chunk of body as AsyncIterable<Buffer>) {
          chunkCount += 1;
          maxChunk = Math.max(maxChunk, chunk.length);
          total += chunk.length;
        }
      },
      presignGet: () => Promise.resolve('unused'),
      delete: () => Promise.resolve(),
    };

    const handle = createMediaFetchHandler({
      objectStore: countingStore,
      logger: capture.logger,
      metrics,
      alerts,
    });
    await handle(jobFor(row!, alarm, 'video'));

    // The whole object really moved through...
    expect(total).toBe(SIZE);
    // ...as a stream of many bounded chunks, none anywhere near the object's size. A buffering
    // worker would show chunkCount === 1 and maxChunk === SIZE.
    expect(chunkCount).toBeGreaterThan(100);
    expect(maxChunk).toBeLessThan(5 * 1024 * 1024);

    const stored = await withOrg(ORG_A, (tx) => getIncidentMedia(tx, row!.id));
    expect(stored?.status).toBe('stored');
    expect(stored?.r2_object_key).toBeTruthy();
  });
});

describe('AC3 — a 404 fails the media row without touching the parent event', () => {
  it('marks the row failed with structured detail and leaves ingestion intact', async () => {
    const vendor = await startVendor((_path, res) => {
      res.writeHead(404).end('gone');
    });
    const alarm = '05000000-0000-4000-8000-000000000003';
    await seedAlarm(alarm, 'phase5-ac3');
    const [row] = await seedPending(alarm, [
      { source_url: `${vendor}/missing`, kind: 'image', expires_at: null },
    ]);

    store = await createLocalObjectStore();
    const handle = createMediaFetchHandler({
      objectStore: store,
      logger: capture.logger,
      metrics,
      alerts,
    });

    // The handler records the failure; it does NOT throw — a media failure is terminal, not a
    // retry storm, and must not propagate to the parent.
    await expect(handle(jobFor(row!, alarm))).resolves.toBeUndefined();

    const failed = await withOrg(ORG_A, (tx) => getIncidentMedia(tx, row!.id));
    expect(failed?.status).toBe('failed');
    expect(failed?.error_detail).toMatchObject({ reason: 'vendor_http_status', status: 404 });
    expect(store.keys()).toHaveLength(0);

    // The parent alarm event is untouched — it committed long before this job ran.
    const parent = await withOrg(ORG_A, (tx) =>
      tx.query(`SELECT internal_id FROM alarm_events WHERE internal_id = $1`, [alarm]),
    );
    expect(parent.rows).toHaveLength(1);
  });
});

describe('AC5 — media is fetched in ascending-expiry order', () => {
  it('delivers the soonest-to-expire URL first over the real queue', async () => {
    const now = new Date();
    queues = createQueueFactory({
      redisUrl: redisUrl(),
      service: 'integration-engine',
      signing: SIGNING,
      logger: capture.logger,
      metrics,
      alerts,
    });
    const mediaQueue = queues.queue<MediaFetchJob>(QUEUE_NAMES.mediaFetch);
    await mediaQueue.drain();

    const enqueuer = createMediaEnqueuer({
      queue: mediaQueue,
      logger: capture.logger,
      metrics,
      alerts,
      now: () => now,
    });
    const core = await createEngineCore({
      logger: capture.logger,
      metrics,
      alerts,
      media: enqueuer,
    });

    const alarm = '05000000-0000-4000-8000-000000000005';
    // Three refs, inserted in scrambled order; expiries late < mid < soon reversed.
    const event = makeFakeEvent({
      orgId: ORG_A,
      clientId: CLIENT_A1,
      siteId: SITE_A1_1,
      vendor: 'axxon',
      vendorEventId: 'phase5-ac5',
      internalId: alarm,
      correlationId: 'phase5',
      vendorEventCode: null,
      eventType: 'intrusion',
      mediaUrls: [
        {
          url: 'https://vendor.example/late',
          kind: 'image',
          expires_at: new Date(now.getTime() + 1_000_000),
        },
        {
          url: 'https://vendor.example/soon',
          kind: 'image',
          expires_at: new Date(now.getTime() + 10_000),
        },
        {
          url: 'https://vendor.example/mid',
          kind: 'image',
          expires_at: new Date(now.getTime() + 100_000),
        },
      ],
    });

    await core.ingest([event]);

    // All three jobs are now waiting with expiry-derived priorities. A concurrency-1 worker
    // therefore delivers them strictly by priority — soonest expiry first.
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      queues!.worker<MediaFetchJob>(
        QUEUE_NAMES.mediaFetch,
        (payload) => {
          order.push(payload.source_url);
          if (order.length === 3) resolve();
          return Promise.resolve();
        },
        { concurrency: 1 },
      );
    });

    expect(order).toEqual([
      'https://vendor.example/soon',
      'https://vendor.example/mid',
      'https://vendor.example/late',
    ]);
  });
});

describe('signed-URL issuance is gated on a stored row', () => {
  it('issues a working URL for stored media and null for a pending row', async () => {
    const vendor = await startVendor((path, res) => {
      if (path === '/img')
        res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from('img'));
      else res.writeHead(404).end();
    });
    const alarm = '05000000-0000-4000-8000-000000000006';
    await seedAlarm(alarm, 'phase5-issuer');
    const [stored, pending] = await seedPending(alarm, [
      { source_url: `${vendor}/img`, kind: 'image', expires_at: null },
      { source_url: `${vendor}/img`, kind: 'image', expires_at: null },
    ]);

    store = await createLocalObjectStore();
    const handle = createMediaFetchHandler({
      objectStore: store,
      logger: capture.logger,
      metrics,
      alerts,
    });
    await handle(jobFor(stored!, alarm));

    const issuer = createMediaUrlIssuer({ objectStore: store, ttlSeconds: 60 });
    const url = await issuer.presignStored(ORG_A, stored!.id);
    expect(url).not.toBeNull();
    expect((await fetch(url!)).status).toBe(200);

    // A row that was never stored yields no URL — the dashboard shows "no media", not a 404.
    expect(await issuer.presignStored(ORG_A, pending!.id)).toBeNull();
  });
});
