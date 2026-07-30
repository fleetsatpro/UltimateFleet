import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalObjectStore, type LocalObjectStore } from '@deepsight/test-support';

/**
 * Phase 5 acceptance criterion 4, at the object-store contract level: a signed GET URL works
 * until it expires, then returns 403 — and a tampered URL is refused outright. The store here
 * is the local HTTP implementation of the same {@link ObjectStore} interface R2 binds; the
 * property (finite-lifetime access, enforced by the store, not by the caller) is what matters,
 * and it holds identically for R2's presigned URLs.
 */

let store: LocalObjectStore | null = null;
afterEach(async () => {
  if (store !== null) {
    await store.close();
    store = null;
  }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('AC4 — signed URLs are time-limited and tamper-evident', () => {
  it('serves a fresh URL, then 403s the same URL after it expires', async () => {
    store = await createLocalObjectStore();
    await store.put('k/one', Readable.from([Buffer.from('hello media')]), {
      contentType: 'text/plain',
    });

    const url = await store.presignGet('k/one', 1);
    const fresh = await fetch(url);
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toBe('hello media');

    // Past the 1-second lifetime the very same URL is dead — access control is the deadline.
    await sleep(1_200);
    const expired = await fetch(url);
    expect(expired.status).toBe(403);
  });

  it('refuses a URL whose signature has been tampered with', async () => {
    store = await createLocalObjectStore();
    await store.put('k/two', Readable.from([Buffer.from('secret')]), {});
    const url = await store.presignGet('k/two', 60);
    // Flip the signature: a forged URL must not grant access even before expiry.
    const tampered = url.replace(
      /sig=([0-9a-f]+)/,
      (_m, sig: string) => `sig=${sig[0] === '0' ? '1' : '0'}${sig.slice(1)}`,
    );
    const res = await fetch(tampered);
    expect(res.status).toBe(403);
  });

  it('streams an upload to storage and reports its exact size', async () => {
    store = await createLocalObjectStore();
    const bytes = Buffer.alloc(64 * 1024, 7);
    await store.put('k/three', Readable.from([bytes]), {});
    expect(store.sizeOf('k/three')).toBe(bytes.length);
    expect(store.keys()).toContain('k/three');
  });
});
