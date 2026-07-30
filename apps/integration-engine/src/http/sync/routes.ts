import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { verifyGuardAccessToken, type GuardAccessClaims } from '@deepsight/auth';
import {
  findSiteGeofence,
  insertAlarmClosure,
  insertAttendanceEvent,
  insertPatrolScan,
  withOrg,
  type SiteGeofence,
} from '@deepsight/db';
import {
  currentCorrelation,
  type Alerts,
  type Logger,
  type Metrics,
} from '@deepsight/observability';
import { evaluateGeofence } from './geofence.js';

/**
 * The guard mobile sync surface. The device pushes its offline-recorded events here; the engine
 * ingests them idempotently into the append-only tables. Two properties are load-bearing:
 *
 *   - Idempotency on (device_id, client_event_id): a retried push inserts nothing new, so a sync
 *     interrupted mid-flight and retried leaves the server row count unchanged (AC2).
 *   - Partial failure never fails the batch: a single malformed or unresolvable event is counted
 *     as rejected and the rest still land. A phone with 24 events must not lose 23 because one
 *     referenced a stale site.
 *
 * device_id, org and guard come from the verified access token, never the request body, so a
 * device cannot write events as another device or guard.
 */

interface GuardRequest extends Request {
  guard?: GuardAccessClaims;
}

export interface SyncRouterConfig {
  readonly guardAccessSecret: string;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}
function toDate(v: unknown): Date | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function createSyncRouter(config: SyncRouterConfig): Router {
  const router = Router();
  router.use(express.json({ limit: '1mb' }));

  // Guard access-token gate. An expired token is 401 so the device refreshes and retries — but
  // note the offline write already happened on the phone; sync is where the token matters (AC5).
  const requireGuard = async (
    req: GuardRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token === '') {
      res.status(401).json({ error: 'no access token' });
      return;
    }
    const verdict = await verifyGuardAccessToken(token, config.guardAccessSecret);
    if (!verdict.ok) {
      config.metrics.counter('guard_sync_unauthorized_total', 1, { reason: verdict.reason });
      res.status(401).json({ error: 'invalid access token' });
      return;
    }
    req.guard = verdict.claims;
    next();
  };

  router.post('/guard/sync/push', (req: GuardRequest, res) => {
    void requireGuard(req, res, () => {
      void handlePush(req, res).catch((error: unknown) => {
        config.logger.error(
          { err: error instanceof Error ? error.message : error },
          'guard sync push failed',
        );
        if (!res.headersSent) res.status(500).json({ error: 'sync failed' });
      });
    });
  });

  async function handlePush(req: GuardRequest, res: Response): Promise<void> {
    const claims = req.guard!;
    const correlationId = currentCorrelation()?.correlationId ?? 'guard-sync';
    const body = (req.body ?? {}) as {
      attendance?: unknown[];
      patrols?: unknown[];
      closures?: unknown[];
    };

    const counts = { accepted: 0, duplicates: 0, rejected: 0 };
    const rejections: string[] = [];
    const reject = (why: string): void => {
      counts.rejected += 1;
      rejections.push(why);
    };

    await withOrg(claims.orgId, async (tx) => {
      const siteCache = new Map<string, SiteGeofence | null>();
      const siteFor = async (id: string): Promise<SiteGeofence | null> => {
        if (!siteCache.has(id)) siteCache.set(id, await findSiteGeofence(tx, id));
        return siteCache.get(id) ?? null;
      };

      for (const raw of body.attendance ?? []) {
        const a = raw as Record<string, unknown>;
        const occurredAt = toDate(a['occurred_at']);
        if (
          !isUuid(a['client_event_id']) ||
          !isUuid(a['site_id']) ||
          (a['event_type'] !== 'sign_in' && a['event_type'] !== 'sign_out') ||
          occurredAt === null
        ) {
          reject('malformed attendance event');
          continue;
        }
        const site = await siteFor(a['site_id']);
        if (site === null) {
          reject('unknown site for attendance');
          continue;
        }
        const gps = { lat: numOrNull(a['gps_latitude']), lon: numOrNull(a['gps_longitude']) };
        const geo =
          a['event_type'] === 'sign_in'
            ? evaluateGeofence(gps, site)
            : { violation: false, distanceM: null };
        const inserted = await insertAttendanceEvent(tx, {
          orgId: claims.orgId,
          guardId: claims.guardId,
          deviceId: claims.deviceId,
          event: {
            clientEventId: a['client_event_id'],
            siteId: a['site_id'],
            clientId: site.client_id,
            eventType: a['event_type'],
            occurredAt,
            gpsLatitude: gps.lat,
            gpsLongitude: gps.lon,
            geofenceViolation: geo.violation,
            geofenceDistanceM: geo.distanceM,
            correlationId,
          },
        });
        if (inserted) counts.accepted += 1;
        else counts.duplicates += 1;
      }

      for (const raw of body.patrols ?? []) {
        const p = raw as Record<string, unknown>;
        const occurredAt = toDate(p['occurred_at']);
        if (
          !isUuid(p['client_event_id']) ||
          !isUuid(p['site_id']) ||
          !isUuid(p['checkpoint_id']) ||
          (p['scan_method'] !== 'nfc' && p['scan_method'] !== 'qr') ||
          occurredAt === null
        ) {
          reject('malformed patrol scan');
          continue;
        }
        const site = await siteFor(p['site_id']);
        if (site === null) {
          reject('unknown site for patrol');
          continue;
        }
        const inserted = await insertPatrolScan(tx, {
          orgId: claims.orgId,
          guardId: claims.guardId,
          deviceId: claims.deviceId,
          event: {
            clientEventId: p['client_event_id'],
            siteId: p['site_id'],
            clientId: site.client_id,
            checkpointId: p['checkpoint_id'],
            occurredAt,
            scanMethod: p['scan_method'],
            gpsLatitude: numOrNull(p['gps_latitude']),
            gpsLongitude: numOrNull(p['gps_longitude']),
            correlationId,
          },
        });
        if (inserted) counts.accepted += 1;
        else counts.duplicates += 1;
      }

      for (const raw of body.closures ?? []) {
        const c = raw as Record<string, unknown>;
        const occurredAt = toDate(c['occurred_at']);
        if (!isUuid(c['client_event_id']) || !isUuid(c['alarm_event_id']) || occurredAt === null) {
          reject('malformed closure');
          continue;
        }
        // The closure's client is the alarm's client — derived, never trusted from the body.
        const alarm = await tx.query<{ client_id: string }>(
          `SELECT client_id FROM alarm_events WHERE internal_id = $1`,
          [c['alarm_event_id']],
        );
        const clientId = alarm.rows[0]?.client_id;
        if (clientId === undefined) {
          reject('unknown alarm for closure');
          continue;
        }
        const inserted = await insertAlarmClosure(tx, {
          orgId: claims.orgId,
          guardId: claims.guardId,
          deviceId: claims.deviceId,
          event: {
            clientEventId: c['client_event_id'],
            alarmEventId: c['alarm_event_id'],
            clientId,
            occurredAt,
            notes: typeof c['notes'] === 'string' ? c['notes'] : null,
            correlationId,
          },
        });
        if (inserted) counts.accepted += 1;
        else counts.duplicates += 1;
      }
    });

    config.metrics.counter('guard_sync_accepted_total', counts.accepted);
    config.metrics.counter('guard_sync_duplicate_total', counts.duplicates);
    if (counts.rejected > 0) {
      config.metrics.counter('guard_sync_rejected_total', counts.rejected);
      config.logger.warn({ rejections }, 'guard sync rejected some events');
    }
    res.status(200).json(counts);
  }

  return router;
}
