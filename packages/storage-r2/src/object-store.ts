import type { Readable } from 'node:stream';

/**
 * The object-storage port.
 *
 * The media pipeline depends on this interface, never on Cloudflare R2 directly. That is
 * what lets the acceptance suite run the real pipeline — streaming a 50 MB object, proving
 * the memory profile, exercising signed-URL expiry — against a local implementation over
 * real HTTP, while production binds the same interface to R2's S3 API. Both implementations
 * are complete; neither is a mock that returns canned values.
 *
 * The contract has exactly three operations, and the shapes are chosen deliberately:
 *
 *   - `put` takes a Node `Readable`, never a Buffer. A Buffer parameter would invite a
 *     caller to `await res.arrayBuffer()` a 50 MB vendor response into memory — the exact
 *     buffering the brief forbids. Taking a stream makes streaming the path of least
 *     resistance and buffering the thing you have to go out of your way to do.
 *   - `presignGet` returns a URL that carries its own expiry. The bytes live in R2 with no
 *     row-level authorization of their own, so access control is the signed URL's finite
 *     lifetime — a leaked URL is a time-boxed leak, not a permanent one.
 *   - `delete` exists because right-to-erasure has to reach the bytes, not only the row.
 */
export interface PutObjectOptions {
  /** Stored as the object's Content-Type so a signed GET serves the right media type. */
  readonly contentType?: string | undefined;
  /**
   * The object size when the vendor stated it (a Content-Length). Optional because a
   * chunked vendor response does not carry one; the multipart uploader handles both.
   */
  readonly contentLength?: number | undefined;
}

export interface ObjectStore {
  /** Streams `body` to `key`. Never buffers the whole object. */
  put(key: string, body: Readable, options?: PutObjectOptions): Promise<void>;
  /** A time-limited GET URL for dashboard access. Expired URLs are rejected by the store. */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  /** Removes the object. Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * The object key for a piece of incident media.
 *
 * Keyed by org first so a future per-tenant lifecycle rule or bucket policy has a prefix to
 * target, then by alarm event so all media for one incident sits together, then by the
 * media row's own id so two refs on one event never collide. No file extension: the media
 * type travels as the object's Content-Type, set on upload, so the key stays a stable
 * identifier rather than encoding mutable metadata.
 */
export function objectKeyFor(parts: {
  readonly orgId: string;
  readonly alarmEventId: string;
  readonly mediaId: string;
}): string {
  return `org/${parts.orgId}/alarm/${parts.alarmEventId}/${parts.mediaId}`;
}
