import type { NextFunction, Request, Response } from 'express';
import {
  isRole,
  roleAllows,
  type DashboardUserSession,
  type Role,
  type SessionStore,
} from '@deepsight/auth';
import { readCookie, SESSION_COOKIE } from './cookies.js';

/**
 * Session and RBAC middleware for dashboard routes.
 *
 * Two independent gates, applied in order: `requireSession` proves WHO the request is (a valid,
 * un-revoked server-side session), and `requireRole` proves they MAY do this. Neither is the
 * tenant boundary — that is RLS in the database, enforced separately — so a bug in one of these
 * gates still cannot leak another org's data. That redundancy is the whole point of acceptance
 * criterion 6.
 */

export interface AuthedRequest extends Request {
  session?: DashboardUserSession & { sid: string };
}

export function requireSession(store: SessionStore) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid === undefined || sid === '') {
      res.status(401).json({ error: 'no session' });
      return;
    }
    const session = await store.get(sid);
    if (session === null) {
      // Unknown or destroyed session id — the immediate-logout property depends on this being
      // a fresh Redis lookup every request, never a cached/stateless decode.
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    req.session = { ...session, sid };
    next();
  };
}

/**
 * Requires the session's role to be among `allowed`. Applied AFTER requireSession. A request with
 * no session reaching here is a wiring bug, so it fails closed with 401 rather than assuming.
 */
export function requireRole(...allowed: readonly Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const session = req.session;
    if (session === undefined) {
      res.status(401).json({ error: 'no session' });
      return;
    }
    if (!isRole(session.role) || !roleAllows(allowed, session.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
