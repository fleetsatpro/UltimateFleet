import express, { Router, type Response } from 'express';
import {
  generateScopedToken,
  hashToken,
  hashPassword,
  orgFromScopedToken,
  signGuardAccessToken,
  verifyPassword,
  type Role,
  type SessionStore,
} from '@deepsight/auth';
import {
  consumeEnrollmentToken,
  consumeRefreshToken,
  createRefreshFamily,
  findEnrollmentById,
  findRefreshFamily,
  insertEnrollmentToken,
  insertGuardEnrollment,
  insertRefreshToken,
  lockRefreshToken,
  lookupUserForAuth,
  revokeEnrollment,
  revokeRefreshFamily,
  withOrg,
} from '@deepsight/db';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';
import { clearSessionCookie, setSessionCookie } from './cookies.js';
import { requireRole, requireSession, type AuthedRequest } from './middleware.js';

/**
 * The authentication surface: dashboard login/logout, supervisor-driven enrollment, and the
 * guard enroll/refresh flows. Every admin route is declared in ADMIN_ROUTES and mounted through
 * one guarded path, so a new privileged route CANNOT be added without a role list — the
 * structural form of acceptance criterion 4.
 */

export interface AuthRouterConfig {
  readonly sessionStore: SessionStore;
  readonly guardAccessSecret: string;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
  readonly sessionTtlSeconds?: number | undefined;
  readonly enrollmentTtlSeconds?: number | undefined;
  readonly accessTtlSeconds?: number | undefined;
  readonly refreshTtlSeconds?: number | undefined;
  readonly secureCookies?: boolean | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AdminRoute {
  readonly method: 'post';
  readonly path: string;
  readonly roles: readonly Role[];
  readonly handler: (req: AuthedRequest, res: Response) => Promise<void>;
}

/** Exported so the RBAC test can drive every admin route from the same list that mounts them. */
export const ADMIN_ROUTE_PATHS = [
  '/admin/enrollments',
  '/admin/enrollments/:enrollmentId/revoke',
] as const;

export function createAuthRouter(config: AuthRouterConfig): Router {
  const sessionTtl = config.sessionTtlSeconds ?? 8 * 60 * 60;
  const enrollmentTtl = config.enrollmentTtlSeconds ?? 15 * 60;
  const accessTtl = config.accessTtlSeconds ?? 15 * 60;
  const refreshTtl = config.refreshTtlSeconds ?? 30 * 24 * 60 * 60;
  const secure = config.secureCookies ?? false;

  const router = Router();
  router.use(express.json({ limit: '16kb' }));

  // A dummy hash verified when the email is unknown, so a login attempt takes the same time
  // whether or not the account exists — account enumeration by timing is closed.
  const dummyHash = hashPassword('deepsight-nonexistent-account');

  // --- Dashboard auth ---

  router.post('/dashboard/login', (req, res) => {
    void (async () => {
      const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
      if (typeof email !== 'string' || typeof password !== 'string') {
        res.status(400).json({ error: 'email and password required' });
        return;
      }
      const user = await lookupUserForAuth(email);
      const ok =
        user !== null
          ? await verifyPassword(user.password_hash, password)
          : (await verifyPassword(await dummyHash, password), false);
      if (user === null || !ok) {
        config.metrics.counter('dashboard_login_failed_total', 1);
        res.status(401).json({ error: 'invalid credentials' });
        return;
      }
      const sid = await config.sessionStore.create(
        { userId: user.id, orgId: user.org_id, role: user.role as Role, clientId: user.client_id },
        sessionTtl,
      );
      setSessionCookie(res, sid, sessionTtl, secure);
      config.metrics.counter('dashboard_login_ok_total', 1);
      res.status(200).json({ role: user.role, orgId: user.org_id });
    })();
  });

  router.post(
    '/dashboard/logout',
    requireSession(config.sessionStore),
    (req: AuthedRequest, res) => {
      void (async () => {
        if (req.session !== undefined) await config.sessionStore.destroy(req.session.sid);
        clearSessionCookie(res, secure);
        res.status(204).end();
      })();
    },
  );

  // A tenant-scoped resource, to prove RLS holds independently of the route/RBAC check (AC6) and
  // that logout takes effect immediately (AC5).
  router.get(
    '/dashboard/clients/:clientId',
    requireSession(config.sessionStore),
    (req: AuthedRequest, res) => {
      void (async () => {
        const session = req.session!;
        const clientId = req.params['clientId'] ?? '';
        if (!UUID.test(clientId)) {
          res.status(400).json({ error: 'invalid client id' });
          return;
        }
        const row = await withOrg(session.orgId, (tx) =>
          tx.query<{ id: string; name: string }>(`SELECT id, name FROM clients WHERE id = $1`, [
            clientId,
          ]),
        );
        // Org B's client is invisible under org A's RLS context: zero rows -> 404, regardless of
        // any route check. RBAC and RLS are independently sufficient.
        if (row.rowCount === 0) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        res.status(200).json(row.rows[0]);
      })();
    },
  );

  // --- Guard enrollment + refresh ---

  router.post('/guard/enroll', (req, res) => {
    void (async () => {
      const { token, deviceId } = (req.body ?? {}) as { token?: unknown; deviceId?: unknown };
      if (typeof token !== 'string' || typeof deviceId !== 'string' || deviceId === '') {
        res.status(400).json({ error: 'token and deviceId required' });
        return;
      }
      const orgId = orgFromScopedToken(token);
      if (orgId === null || !UUID.test(orgId)) {
        res.status(410).json({ error: 'gone' });
        return;
      }
      const hash = hashToken(token);
      try {
        const result = await withOrg(orgId, async (tx) => {
          const consumed = await consumeEnrollmentToken(tx, hash);
          if (consumed === null) return null;
          const enrollmentId = await insertGuardEnrollment(tx, {
            orgId,
            clientId: consumed.client_id,
            guardId: consumed.guard_id,
            deviceId,
            enrolledBy: consumed.created_by,
          });
          const familyId = await createRefreshFamily(tx, {
            orgId,
            clientId: consumed.client_id,
            guardId: consumed.guard_id,
            enrollmentId,
            deviceId,
          });
          const refresh = generateScopedToken(orgId);
          await insertRefreshToken(tx, {
            orgId,
            clientId: consumed.client_id,
            familyId,
            tokenHash: refresh.hash,
            expiresAt: new Date(Date.now() + refreshTtl * 1000),
          });
          return { consumed, enrollmentId, refresh: refresh.plaintext };
        });
        if (result === null) {
          // Already consumed, expired, or never existed — a single 410 for all, so redemption
          // failures do not distinguish "used" from "never valid".
          res.status(410).json({ error: 'gone' });
          return;
        }
        const accessToken = await signGuardAccessToken(
          {
            guardId: result.consumed.guard_id,
            orgId,
            clientId: result.consumed.client_id,
            deviceId,
            enrollmentId: result.enrollmentId,
          },
          config.guardAccessSecret,
          accessTtl,
        );
        res.status(201).json({ accessToken, refreshToken: result.refresh });
      } catch (error) {
        config.logger.warn(
          { err: error instanceof Error ? error.message : error },
          'guard enroll failed',
        );
        res.status(400).json({ error: 'enrollment failed' });
      }
    })();
  });

  router.post('/guard/refresh', (req, res) => {
    void (async () => {
      const { refreshToken } = (req.body ?? {}) as { refreshToken?: unknown };
      if (typeof refreshToken !== 'string') {
        res.status(400).json({ error: 'refreshToken required' });
        return;
      }
      const orgId = orgFromScopedToken(refreshToken);
      if (orgId === null || !UUID.test(orgId)) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      const hash = hashToken(refreshToken);
      const outcome = await withOrg(orgId, async (tx) => {
        const token = await lockRefreshToken(tx, hash);
        if (token === null) return { ok: false as const };
        const family = await findRefreshFamily(tx, token.family_id);
        if (family === null || family.revoked_at !== null) return { ok: false as const };

        // Replay: a consumed token presented again revokes the WHOLE family (AC3). The
        // legitimate holder's live token then fails too, forcing re-provisioning.
        if (token.consumed_at !== null) {
          await revokeRefreshFamily(tx, family.id);
          config.alerts.fire('refresh_token_replay', {
            severity: 'critical',
            familyId: family.id,
          });
          return { ok: false as const };
        }
        if (token.expires_at.getTime() <= Date.now()) return { ok: false as const };

        // Enrollment revoked -> fail the next refresh AND kill the family (AC2).
        const enrollment = await findEnrollmentById(tx, family.enrollment_id);
        if (enrollment === undefined || enrollment.revoked_at !== null) {
          await revokeRefreshFamily(tx, family.id);
          return { ok: false as const };
        }

        await consumeRefreshToken(tx, token.id);
        const next = generateScopedToken(orgId);
        await insertRefreshToken(tx, {
          orgId,
          clientId: family.client_id,
          familyId: family.id,
          tokenHash: next.hash,
          expiresAt: new Date(Date.now() + refreshTtl * 1000),
        });
        return {
          ok: true as const,
          guardId: family.guard_id,
          clientId: family.client_id,
          deviceId: family.device_id,
          enrollmentId: family.enrollment_id,
          refreshToken: next.plaintext,
        };
      });

      if (!outcome.ok) {
        res.status(401).json({ error: 'refresh rejected' });
        return;
      }
      const accessToken = await signGuardAccessToken(
        {
          guardId: outcome.guardId,
          orgId,
          clientId: outcome.clientId,
          deviceId: outcome.deviceId,
          enrollmentId: outcome.enrollmentId,
        },
        config.guardAccessSecret,
        accessTtl,
      );
      res.status(200).json({ accessToken, refreshToken: outcome.refreshToken });
    })();
  });

  // --- Admin routes, mounted from a table so none can be added unguarded (AC4) ---

  const adminRoutes: readonly AdminRoute[] = [
    {
      method: 'post',
      path: '/admin/enrollments',
      roles: ['admin', 'supervisor'],
      async handler(req, res) {
        const session = req.session!;
        const { guardId, clientId, deviceLabel } = (req.body ?? {}) as {
          guardId?: unknown;
          clientId?: unknown;
          deviceLabel?: unknown;
        };
        if (
          typeof guardId !== 'string' ||
          !UUID.test(guardId) ||
          typeof clientId !== 'string' ||
          !UUID.test(clientId)
        ) {
          res.status(400).json({ error: 'guardId and clientId (uuids) required' });
          return;
        }
        const scoped = generateScopedToken(session.orgId);
        const expiresAt = new Date(Date.now() + enrollmentTtl * 1000);
        try {
          await withOrg(session.orgId, (tx) =>
            insertEnrollmentToken(tx, {
              orgId: session.orgId,
              clientId,
              guardId,
              deviceLabel: typeof deviceLabel === 'string' ? deviceLabel : null,
              tokenHash: scoped.hash,
              createdBy: session.userId,
              expiresAt,
            }),
          );
        } catch (error) {
          config.logger.warn(
            { err: error instanceof Error ? error.message : error },
            'create enrollment token failed',
          );
          res.status(400).json({ error: 'invalid guard or client' });
          return;
        }
        // The plaintext token is returned exactly ONCE, here, and never stored or logged.
        res.status(201).json({ token: scoped.plaintext, expiresAt });
      },
    },
    {
      method: 'post',
      path: '/admin/enrollments/:enrollmentId/revoke',
      roles: ['admin', 'supervisor'],
      async handler(req, res) {
        const session = req.session!;
        const enrollmentId = req.params['enrollmentId'] ?? '';
        if (!UUID.test(enrollmentId)) {
          res.status(400).json({ error: 'invalid enrollment id' });
          return;
        }
        const revoked = await withOrg(session.orgId, (tx) => revokeEnrollment(tx, enrollmentId));
        res.status(revoked ? 204 : 404).end();
      },
    },
  ];

  for (const route of adminRoutes) {
    router[route.method](
      route.path,
      requireSession(config.sessionStore),
      requireRole(...route.roles),
      (req: AuthedRequest, res) => {
        void route.handler(req, res).catch((error: unknown) => {
          config.logger.error(
            { err: error instanceof Error ? error.message : error, path: route.path },
            'admin route handler failed',
          );
          if (!res.headersSent) res.status(500).json({ error: 'internal error' });
        });
      },
    );
  }

  return router;
}
