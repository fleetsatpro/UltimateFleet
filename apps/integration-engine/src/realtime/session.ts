import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Dashboard session tokens for the realtime layer.
 *
 * This is a DELIBERATELY MINIMAL session, not the RBAC system — that is Phase 7. A token
 * carries only what the socket layer needs to authorize a connection and scope its room: a
 * session id (so it can be revoked), the org (the isolation key, D6), and an optional client
 * narrowing. It is HMAC-signed so a socket cannot forge membership of an org it was not issued
 * for; the socket handshake presents it and the hub verifies before joining any room.
 *
 * Revocation is a separate concern from signing: a signature proves a token was issued, not
 * that it is still valid. The {@link SessionRegistry} is the "still valid" check, consulted on
 * connect and on every heartbeat so a revoked session is dropped, not merely refused at reconnect.
 */
export interface DashboardSession {
  readonly sid: string;
  readonly org_id: string;
  readonly client_id?: string | undefined;
}

export interface SignedSession {
  readonly payload: DashboardSession;
  readonly iat: number;
  readonly sig: string;
}

export type SessionVerification =
  | { readonly ok: true; readonly session: DashboardSession }
  | { readonly ok: false; readonly reason: string };

function canonical(payload: DashboardSession, iat: number): string {
  // Fixed field order so the signature depends on the data, not on object construction order.
  return JSON.stringify({
    sid: payload.sid,
    org_id: payload.org_id,
    client_id: payload.client_id ?? null,
    iat,
  });
}

export interface SessionCodec {
  sign(session: DashboardSession): string;
  verify(token: string): SessionVerification;
}

/** HMAC-signed, base64url-encoded session tokens. */
export function createSessionCodec(secret: string): SessionCodec {
  const digest = (signable: string): string =>
    createHmac('sha256', secret).update(signable).digest('hex');

  return {
    sign(session) {
      const iat = Date.now();
      const signable = canonical(session, iat);
      const signed: SignedSession = { payload: session, iat, sig: digest(signable) };
      return Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
    },

    verify(token) {
      let parsed: SignedSession;
      try {
        parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as SignedSession;
      } catch {
        return { ok: false, reason: 'malformed token' };
      }
      const { payload, iat, sig } = parsed;
      if (
        payload === undefined ||
        typeof payload.sid !== 'string' ||
        typeof payload.org_id !== 'string' ||
        typeof iat !== 'number' ||
        typeof sig !== 'string'
      ) {
        return { ok: false, reason: 'incomplete token' };
      }
      const expected = Buffer.from(digest(canonical(payload, iat)), 'utf8');
      const provided = Buffer.from(sig, 'utf8');
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        return { ok: false, reason: 'signature mismatch' };
      }
      return { ok: true, session: payload };
    },
  };
}

/**
 * Tracks revoked session ids. In-memory here (single instance) — Phase 7 replaces it with a
 * Redis-backed store so a revocation propagates across every engine instance. The interface is
 * the same either way, which is the point: the hub depends on `isRevoked`, not on where the
 * revocation list lives.
 */
export interface SessionRegistry {
  revoke(sid: string): void;
  isRevoked(sid: string): boolean;
  revokedCount(): number;
}

export function createSessionRegistry(): SessionRegistry {
  const revoked = new Set<string>();
  return {
    revoke(sid) {
      revoked.add(sid);
    },
    isRevoked(sid) {
      return revoked.has(sid);
    },
    revokedCount() {
      return revoked.size;
    },
  };
}
