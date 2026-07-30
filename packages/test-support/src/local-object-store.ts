import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AddressInfo } from 'node:net';
import type { ObjectStore, PutObjectOptions } from '@deepsight/storage-r2';

/**
 * A local, complete implementation of the {@link ObjectStore} contract, backed by a real
 * in-process HTTP server and the filesystem. It is NOT a mock: uploads stream to disk (so a
 * 50 MB object never sits in memory — the property AC2 measures), and `presignGet` returns a
 * URL served by the HTTP server that enforces an HMAC signature and an expiry, answering 403
 * for an expired or tampered URL exactly as R2 would (the property AC4 asserts).
 *
 * This is the same technique the fake adapters use for the ingestion core: exercise the real
 * contract with a real, complete implementation, rather than assert against canned values. The
 * media pipeline under test does not know or care that it is talking to this rather than R2.
 */
export interface LocalObjectStore extends ObjectStore {
  /** Shuts down the HTTP server and removes all stored bytes. */
  close(): Promise<void>;
  /** Byte length stored for a key, for assertions. Throws if the key is absent. */
  sizeOf(key: string): number;
  /** Keys currently stored. */
  keys(): readonly string[];
}

interface StoredObject {
  readonly path: string;
  readonly contentType: string;
  size: number;
}

export async function createLocalObjectStore(): Promise<LocalObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), 'deepsight-obj-'));
  const secret = randomBytes(32);
  const objects = new Map<string, StoredObject>();

  const sign = (key: string, expEpochMs: number): string =>
    createHmac('sha256', secret).update(`${key}\n${expEpochMs}`).digest('hex');

  const signatureValid = (key: string, exp: string, sig: string): boolean => {
    const expected = Buffer.from(sign(key, Number(exp)), 'utf8');
    const provided = Buffer.from(sig, 'utf8');
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  };

  const server: Server = createServer((req, res) => {
    // A signed GET: /get?key=..&exp=..&sig=.. — the shape presignGet issues below.
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== '/get') {
      res.writeHead(404).end();
      return;
    }
    const key = url.searchParams.get('key') ?? '';
    const exp = url.searchParams.get('exp') ?? '';
    const sig = url.searchParams.get('sig') ?? '';

    if (exp === '' || sig === '' || !signatureValid(key, exp, sig)) {
      // A tampered or unsigned URL is forbidden — the same answer R2 gives a bad signature.
      res.writeHead(403).end('forbidden');
      return;
    }
    if (Date.now() > Number(exp)) {
      // Expiry is the whole access-control mechanism: past the deadline, the URL is dead.
      res.writeHead(403).end('expired');
      return;
    }
    const object = objects.get(key);
    if (object === undefined) {
      res.writeHead(404).end('no such key');
      return;
    }
    res.writeHead(200, { 'content-type': object.contentType });
    createReadStream(object.path).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  let counter = 0;
  return {
    async put(key: string, body, options?: PutObjectOptions): Promise<void> {
      counter += 1;
      const path = join(dir, `obj-${counter}`);
      // pipeline streams the body to disk with backpressure — bytes flow through, they are
      // not accumulated. This is what keeps a 50 MB upload's memory profile flat.
      await pipeline(body, createWriteStream(path));
      objects.set(key, {
        path,
        contentType: options?.contentType ?? 'application/octet-stream',
        size: statSync(path).size,
      });
    },

    presignGet(key: string, ttlSeconds: number): Promise<string> {
      const exp = Date.now() + ttlSeconds * 1000;
      const sig = sign(key, exp);
      const search = new URLSearchParams({ key, exp: String(exp), sig });
      return Promise.resolve(`http://127.0.0.1:${port}/get?${search.toString()}`);
    },

    delete(key: string): Promise<void> {
      const object = objects.get(key);
      objects.delete(key);
      // Best-effort byte cleanup; a missing file is not an error (delete is idempotent).
      return object === undefined ? Promise.resolve() : rm(object.path, { force: true });
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },

    sizeOf(key: string): number {
      const object = objects.get(key);
      if (object === undefined) throw new Error(`no stored object for key ${key}`);
      return object.size;
    },

    keys(): readonly string[] {
      return [...objects.keys()];
    },
  };
}
