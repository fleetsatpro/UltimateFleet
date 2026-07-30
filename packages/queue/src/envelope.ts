import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed job envelopes.
 *
 * The brief mandates BullMQ between the AxxonSoft worker and the integration engine, and
 * forbids direct HTTP between them. That means HTTP-level authentication covers none of
 * that traffic: a job placed on the shared Redis instance bypasses it entirely. So every
 * internal job payload is signed and verified — the concrete form of "do not assume
 * network position is a trust boundary" (architecture section 9.3).
 *
 * Rotation uses the same dual-secret scheme as service JWTs: sign with `current`, accept
 * `current` or `previous`, identified by `kid`. Rotation is therefore: previous <- current,
 * current <- new, redeploy. No coordinated restart, no outage window.
 */

export type ServiceName = 'integration-engine' | 'axxon-worker' | 'report-worker';

export interface SignedJobEnvelope<T> {
  readonly payload: T;
  readonly iss: ServiceName;
  readonly iat: number;
  readonly kid: string;
  readonly sig: string;
}

export interface SigningKey {
  readonly kid: string;
  readonly secret: string;
}

export interface EnvelopeSigner {
  sign<T>(payload: T, issuer: ServiceName): SignedJobEnvelope<T>;
  verify<T>(envelope: unknown): VerifyResult<T>;
}

export type VerifyResult<T> =
  | { readonly ok: true; readonly payload: T; readonly iss: ServiceName }
  | { readonly ok: false; readonly reason: string };

/**
 * Deterministic serialization for signing.
 *
 * JSON.stringify key order follows insertion order, so two structurally identical objects
 * can serialize differently and produce different digests. Sorting keys recursively makes
 * the signature depend on the data rather than on how the object happened to be built —
 * the same class of bug as verifying an HMAC against re-serialized JSON (divergence D4).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

function digest(secret: string, signable: string): string {
  return createHmac('sha256', secret).update(signable).digest('hex');
}

function signablePart<T>(payload: T, iss: ServiceName, iat: number): string {
  return canonicalJson({ payload, iss, iat });
}

/** Constant-time comparison, so a signature check cannot be narrowed by timing. */
function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

export interface EnvelopeSignerOptions {
  readonly current: SigningKey;
  readonly previous?: SigningKey | undefined;
  /** Envelopes older than this are rejected, bounding replay. Default 5 minutes. */
  readonly maxAgeMs?: number | undefined;
}

export function createEnvelopeSigner(options: EnvelopeSignerOptions): EnvelopeSigner {
  const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
  const keys = new Map<string, string>([[options.current.kid, options.current.secret]]);
  if (options.previous !== undefined) {
    keys.set(options.previous.kid, options.previous.secret);
  }

  return {
    sign(payload, issuer) {
      const iat = Date.now();
      return {
        payload,
        iss: issuer,
        iat,
        kid: options.current.kid,
        sig: digest(options.current.secret, signablePart(payload, issuer, iat)),
      };
    },

    verify<T>(envelope: unknown): VerifyResult<T> {
      if (envelope === null || typeof envelope !== 'object') {
        return { ok: false, reason: 'envelope is not an object' };
      }
      const candidate = envelope as Partial<SignedJobEnvelope<T>>;
      const { payload, iss, iat, kid, sig } = candidate;

      if (typeof kid !== 'string') return { ok: false, reason: 'missing kid' };
      if (typeof sig !== 'string') return { ok: false, reason: 'missing sig' };
      if (typeof iss !== 'string') return { ok: false, reason: 'missing iss' };
      if (typeof iat !== 'number' || !Number.isFinite(iat)) {
        return { ok: false, reason: 'missing or invalid iat' };
      }

      const secret = keys.get(kid);
      if (secret === undefined) return { ok: false, reason: `unknown kid "${kid}"` };

      const expected = digest(secret, signablePart(payload, iss as ServiceName, iat));
      if (!signaturesMatch(expected, sig)) return { ok: false, reason: 'signature mismatch' };

      // Age is checked only after the signature is valid: rejecting on age first would
      // let an attacker probe timestamps without holding a key.
      const age = Date.now() - iat;
      if (age > maxAgeMs) return { ok: false, reason: `envelope too old (${age}ms)` };
      // Small negative ages are ordinary clock skew between Railway instances.
      if (age < -30_000)
        return { ok: false, reason: `envelope timestamp is in the future (${-age}ms)` };

      return { ok: true, payload: payload as T, iss: iss as ServiceName };
    },
  };
}
