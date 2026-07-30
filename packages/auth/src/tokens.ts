import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque bearer tokens (enrollment tokens, refresh tokens).
 *
 * The plaintext is 256 bits of CSPRNG output, base64url-encoded, returned to the caller ONCE.
 * Only its SHA-256 hash is ever persisted, so a database dump yields no redeemable token — the
 * whole reason these are stored hashed rather than encrypted. SHA-256 (not Argon2) is correct
 * here precisely because the input is already high-entropy random: there is nothing to
 * brute-force, so the slow, memory-hard hashing that passwords need would only add latency.
 *
 * Lookups compare hashes, so they are constant-time in the database (an index probe on a fixed
 * 64-hex string), not a byte-by-byte compare in application code.
 */
export interface OpaqueToken {
  /** The value handed to the client. Never stored. */
  readonly plaintext: string;
  /** SHA-256 hex of the plaintext. The only thing persisted. */
  readonly hash: string;
}

export function generateOpaqueToken(): OpaqueToken {
  const plaintext = randomBytes(32).toString('base64url');
  return { plaintext, hash: hashToken(plaintext) };
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * An org-SCOPED opaque token: `{orgId}.{secret}`.
 *
 * Enrollment and refresh tokens are redeemed by a device that does not yet know (and should not
 * have to send separately) which org it belongs to. Prefixing the org id — which is a routing
 * hint, not a secret — lets the redemption endpoint resolve the tenant from the token itself and
 * then do the actual lookup UNDER that org's RLS, instead of a cross-org read. The security still
 * rests entirely on the 256-bit random secret; the hash covers the whole value.
 */
export function generateScopedToken(orgId: string): OpaqueToken {
  const plaintext = `${orgId}.${randomBytes(32).toString('base64url')}`;
  return { plaintext, hash: hashToken(plaintext) };
}

/** Extracts the org id a scoped token routes to, or null if it is not scoped. */
export function orgFromScopedToken(token: string): string | null {
  const dot = token.indexOf('.');
  return dot > 0 ? token.slice(0, dot) : null;
}
