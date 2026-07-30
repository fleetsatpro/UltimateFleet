/**
 * @deepsight/storage-r2 — the object-storage port and its Cloudflare R2 binding.
 *
 * Application code (the media worker) imports the {@link ObjectStore} interface and the key
 * builder; only the service entrypoint constructs {@link createR2ObjectStore}, and only when
 * the R2 environment is present. Tests bind the same interface to a local HTTP store, so the
 * pipeline's streaming and signed-URL-expiry properties are proven without a live bucket.
 */
export { objectKeyFor, type ObjectStore, type PutObjectOptions } from './object-store.js';
export { createR2ObjectStore, type R2Config } from './r2.js';
