import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Role } from './rbac.js';

/**
 * Server-side dashboard sessions, held in Redis.
 *
 * Server-side (not a self-contained JWT cookie) for one reason: logout and revocation must take
 * effect IMMEDIATELY. A stateless JWT cannot be invalidated before it expires; a Redis session
 * is deleted and the very next request with the same cookie fails (acceptance criterion 5). The
 * cookie carries only an opaque, high-entropy session id — never the identity — so it discloses
 * nothing and cannot be forged into a different org or role.
 */
export interface DashboardUserSession {
  readonly userId: string;
  readonly orgId: string;
  readonly role: Role;
  /** Only report_viewer carries a client narrowing; null for admin/supervisor. */
  readonly clientId: string | null;
}

export interface SessionStore {
  /** Creates a session, returns the opaque id to put in the cookie. */
  create(session: DashboardUserSession, ttlSeconds: number): Promise<string>;
  get(sessionId: string): Promise<DashboardUserSession | null>;
  /** Idempotent: destroying an unknown or already-destroyed session is not an error. */
  destroy(sessionId: string): Promise<void>;
}

const KEY_PREFIX = 'dashboard:session:';

export function createSessionStore(redis: Redis): SessionStore {
  return {
    async create(session, ttlSeconds) {
      const sessionId = randomBytes(32).toString('base64url');
      await redis.set(
        KEY_PREFIX + sessionId,
        JSON.stringify(session),
        'EX',
        Math.max(1, Math.floor(ttlSeconds)),
      );
      return sessionId;
    },

    async get(sessionId) {
      if (sessionId === '') return null;
      const raw = await redis.get(KEY_PREFIX + sessionId);
      if (raw === null) return null;
      return JSON.parse(raw) as DashboardUserSession;
    },

    async destroy(sessionId) {
      await redis.del(KEY_PREFIX + sessionId);
    },
  };
}
