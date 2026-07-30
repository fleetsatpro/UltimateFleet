import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server as IOServer, type Socket } from 'socket.io';
import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import type { Logger, Metrics } from '@deepsight/observability';
import type { VendorHealth } from '../http/app.js';
import type { SessionCodec, SessionRegistry, DashboardSession } from './session.js';

/**
 * The realtime hub: a Socket.io server, fanned out across engine instances by the Redis
 * adapter, that pushes alarm events and vendor health to authorized dashboard clients.
 *
 * Isolation is the load-bearing property. Every socket authenticates on connect and joins
 * EXACTLY ONE room — `org:{org_id}` from its verified session — and alarm broadcasts target
 * that room. So an event for org A is emitted to `org:A` and a socket authenticated for org B
 * is not in that room; the isolation is enforced by room membership at the socket layer, not by
 * a filter the client is trusted to apply. The Redis adapter makes the room span instances, so
 * two dashboards on two engines behind a load balancer still see only their own org.
 *
 * Revocation is enforced by a heartbeat sweep rather than only at connect: a session revoked
 * mid-connection is dropped on the next sweep, so revoking access actually ends live sessions.
 */
export interface RealtimeHubDeps {
  readonly httpServer: HttpServer;
  readonly redisUrl: string;
  readonly codec: SessionCodec;
  readonly registry: SessionRegistry;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** How often to drop revoked sockets. Default 1s — "disconnected on its next heartbeat". */
  readonly heartbeatMs?: number | undefined;
  /** Allowed browser origin for the dashboard. Default reflects the request origin. */
  readonly corsOrigin?: string | undefined;
}

export interface RealtimeHub {
  /** Emits an alarm to its org's room only. */
  broadcastAlarm(event: NormalizedAlarmEvent): void;
  /** Emits vendor health to every dashboard — vendor state is operator-wide, not tenant data. */
  broadcastVendorHealth(health: readonly VendorHealth[]): void;
  /** Locally-connected socket count, for tests and metrics. */
  connectionCount(): number;
  close(): Promise<void>;
}

interface SocketData {
  session: DashboardSession;
}

export function roomFor(orgId: string): string {
  return `org:${orgId}`;
}

export function createRealtimeHub(deps: RealtimeHubDeps): RealtimeHub {
  const heartbeatMs = deps.heartbeatMs ?? 1_000;

  const io = new IOServer(deps.httpServer, {
    cors: { origin: deps.corsOrigin ?? true, credentials: true },
    // Keep the server's own ping tight so a dead client is noticed quickly; the revocation
    // sweep below is separate and runs on its own interval.
    pingInterval: Math.min(heartbeatMs, 10_000),
  });

  // maxRetriesPerRequest: null — the adapter issues blocking subscribe commands, and the
  // default retry budget would kill the connection under a brief Redis blip.
  const pub = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));

  // Authenticate on connect: verify the token, reject a forged or revoked session, and pin the
  // socket to its org room. A socket that fails here never joins a room, so it receives nothing.
  io.use((socket: Socket, next: (err?: Error) => void) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string') {
      next(new Error('unauthorized: no session token'));
      return;
    }
    const verdict = deps.codec.verify(token);
    if (!verdict.ok) {
      deps.metrics.counter('dashboard_auth_rejected_total', 1, { reason: verdict.reason });
      next(new Error(`unauthorized: ${verdict.reason}`));
      return;
    }
    if (deps.registry.isRevoked(verdict.session.sid)) {
      deps.metrics.counter('dashboard_auth_rejected_total', 1, { reason: 'revoked' });
      next(new Error('unauthorized: session revoked'));
      return;
    }
    (socket.data as SocketData).session = verdict.session;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const { session } = socket.data as SocketData;
    void socket.join(roomFor(session.org_id));
    deps.metrics.counter('dashboard_connections_total', 1);
    deps.logger.debug({ sid: session.sid, orgId: session.org_id }, 'dashboard socket connected');
    socket.on('disconnect', (reason) => {
      deps.logger.debug({ sid: session.sid, reason }, 'dashboard socket disconnected');
    });
  });

  // Drop revoked sockets on a heartbeat. This is what makes revocation end LIVE sessions, not
  // just block reconnects — the property AC5 asserts.
  const sweep = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      const data = socket.data as SocketData;
      if (data.session !== undefined && deps.registry.isRevoked(data.session.sid)) {
        deps.metrics.counter('dashboard_revoked_disconnects_total', 1);
        socket.disconnect(true);
      }
    }
  }, heartbeatMs);
  // Do not keep the event loop alive for the sweep alone.
  sweep.unref();

  return {
    broadcastAlarm(event) {
      io.to(roomFor(event.org_id)).emit('alarm', event);
      deps.metrics.counter('dashboard_alarm_broadcasts_total', 1);
    },
    broadcastVendorHealth(health) {
      io.emit('vendor:health', health);
    },
    connectionCount() {
      return io.sockets.sockets.size;
    },
    async close() {
      clearInterval(sweep);
      await io.close();
      pub.disconnect();
      sub.disconnect();
    },
  };
}
