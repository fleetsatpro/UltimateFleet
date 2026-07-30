import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { closePool, initPool } from '@deepsight/db';
import { createSessionStore } from '@deepsight/auth';
import { createAlerts, createLogger, createMetrics } from '@deepsight/observability';
import { createQueueFactory, QUEUE_NAMES } from '@deepsight/queue';
import { createR2ObjectStore } from '@deepsight/storage-r2';
import { loadEngineEnv, resolveR2Config } from './env.js';
import { createApp } from './http/app.js';
import { createEngineCore } from './core.js';
import { createMediaEnqueuer } from './media/enqueue.js';
import { createMediaFetchHandler } from './media/worker.js';
import type { MediaFetchJob } from './media/job.js';
import type { FanOut, MediaSink } from './ingestion/pipeline.js';
import type { TypedWorker } from '@deepsight/queue';
import { createSessionCodec, createSessionRegistry } from './realtime/session.js';
import { createRealtimeHub, type RealtimeHub } from './realtime/hub.js';
import { startVendorHealthBroadcast, type VendorHealthBroadcaster } from './realtime/fanout.js';
import { createAuthRouter } from './http/auth/routes.js';

/**
 * Service entrypoint.
 *
 * Startup order matters. Validate the environment first, so a misconfiguration fails
 * before any connection is opened. Load the mapping cache before accepting traffic, so
 * the first event is classified correctly rather than landing as 'unknown'. Bind last.
 */
async function main(): Promise<void> {
  const env = loadEngineEnv();

  const logger = createLogger({ service: 'integration-engine', level: env.LOG_LEVEL });
  const metrics = createMetrics();
  const alerts = createAlerts(logger);
  const startedAt = new Date();

  initPool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });

  const queues = createQueueFactory({
    redisUrl: env.REDIS_URL,
    service: 'integration-engine',
    signing: {
      current: { kid: env.SERVICE_SECRET_CURRENT_KID, secret: env.SERVICE_SECRET_CURRENT },
      ...(env.SERVICE_SECRET_PREVIOUS !== undefined
        ? {
            previous: {
              kid: env.SERVICE_SECRET_PREVIOUS_KID ?? 'previous',
              secret: env.SERVICE_SECRET_PREVIOUS,
            },
          }
        : {}),
    },
    logger,
    metrics,
    alerts,
  });

  /**
   * The media pipeline is wired only when R2 is configured. R2 is not provisioned yet
   * (Open Item 10), so its absence is a supported runtime state — the engine ingests and
   * fans out as normal, just without fetching media — rather than a boot failure. A partial
   * R2 config was already rejected at env-parse time.
   */
  const r2Config = resolveR2Config(env);
  let mediaSink: MediaSink | undefined;
  let mediaWorker: TypedWorker | undefined;
  if (r2Config !== null) {
    const objectStore = createR2ObjectStore(r2Config);
    const mediaQueue = queues.queue<MediaFetchJob>(QUEUE_NAMES.mediaFetch);
    mediaSink = createMediaEnqueuer({ queue: mediaQueue, logger, metrics, alerts });
    const handleMedia = createMediaFetchHandler({ objectStore, logger, metrics, alerts });
    mediaWorker = queues.worker<MediaFetchJob>(
      QUEUE_NAMES.mediaFetch,
      (payload) => handleMedia(payload),
      { concurrency: 4 },
    );
    logger.info({ bucket: r2Config.bucket }, 'media pipeline enabled');
  } else {
    logger.warn({}, 'media pipeline disabled: R2 not configured (Open Item 10)');
  }

  // A deferred fan-out breaks the wiring cycle: the core needs a fan-out, the realtime hub
  // needs the HTTP server, the server needs the app, and the app needs the core. The core is
  // built with a closure that forwards to the hub once it exists (and logs until then / when
  // realtime is disabled). publish() only runs per persisted event at runtime, long after wiring.
  let hub: RealtimeHub | null = null;
  const fanOut: FanOut = {
    publish(event) {
      if (hub !== null) hub.broadcastAlarm(event);
      else logger.debug({ internalId: event.internal_id }, 'alarm event (no dashboard attached)');
      return Promise.resolve();
    },
  };

  const core = await createEngineCore({
    logger,
    metrics,
    alerts,
    fanOut,
    ...(mediaSink !== undefined ? { media: mediaSink } : {}),
  });

  /**
   * The alarm.ingest consumer. The AxxonSoft worker publishes here rather than calling
   * the engine over HTTP, which makes the queue an auth boundary — so the envelope is
   * verified inside the worker factory, before this handler is ever reached.
   */
  const alarmWorker = queues.worker<{ events: readonly unknown[] }>(
    QUEUE_NAMES.alarmIngest,
    async (payload) => {
      await core.ingest(payload.events);
    },
  );

  // The auth surface (Phase 7) is mounted only when a guard access secret is configured, the
  // same boot-optional posture as R2 and the realtime hub. Its session store needs its own Redis
  // client — the queue factory's connections are not exposed — closed on shutdown.
  let authRedis: Redis | null = null;
  let authRouter = undefined;
  if (env.GUARD_ACCESS_SECRET !== undefined) {
    authRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    authRouter = createAuthRouter({
      sessionStore: createSessionStore(authRedis),
      guardAccessSecret: env.GUARD_ACCESS_SECRET,
      logger,
      metrics,
      alerts,
      // Anything but a local IPv4 bind is a real deployment behind TLS, so mark cookies Secure.
      secureCookies: env.BIND_HOST !== '127.0.0.1',
    });
    logger.info({}, 'auth surface enabled');
  } else {
    logger.warn({}, 'auth surface disabled: GUARD_ACCESS_SECRET not set');
  }

  const app = createApp({
    logger,
    metrics,
    alerts,
    mappings: core.mappings,
    startedAt,
    webhooks: core.webhooks,
    vendorHealth: core.vendorHealth,
    ...(authRouter !== undefined ? { authRouter } : {}),
    ...(env.ADMIN_API_TOKEN !== undefined ? { adminToken: env.ADMIN_API_TOKEN } : {}),
  });

  // Explicit http.Server (rather than app.listen) so the realtime hub can attach to it.
  const server = createServer(app);

  /**
   * The realtime hub is started only when a dashboard session secret is configured — otherwise
   * the engine runs headless. When on, it binds the deferred fan-out above to the socket layer
   * and starts pushing vendor health to dashboards.
   */
  let healthBroadcast: VendorHealthBroadcaster | null = null;
  if (env.DASHBOARD_SESSION_SECRET !== undefined) {
    hub = createRealtimeHub({
      httpServer: server,
      redisUrl: env.REDIS_URL,
      codec: createSessionCodec(env.DASHBOARD_SESSION_SECRET),
      registry: createSessionRegistry(),
      logger,
      metrics,
      ...(env.DASHBOARD_ORIGIN !== undefined ? { corsOrigin: env.DASHBOARD_ORIGIN } : {}),
    });
    healthBroadcast = startVendorHealthBroadcast({ hub, source: core.vendorHealth, logger });
    logger.info({}, 'realtime dashboard hub enabled');
  } else {
    logger.warn({}, 'realtime dashboard disabled: DASHBOARD_SESSION_SECRET not set');
  }

  server.listen(env.PORT, env.BIND_HOST, () => {
    logger.info(
      { port: env.PORT, host: env.BIND_HOST, mappings: core.mappings.size() },
      'integration engine listening',
    );
  });

  /**
   * Without this handler a bind failure surfaces as an unhandled 'error' event: a raw
   * stack trace on stderr, no structured log line, and a confusing exit. The most likely
   * cause in practice is BIND_HOST — Railway needs the IPv6 wildcard `::`, and an
   * environment without IPv6 rejects it with EAFNOSUPPORT — so the message says so.
   */
  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error(
      { err: error.message, code: error.code, host: env.BIND_HOST, port: env.PORT },
      error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL'
        ? 'failed to bind: BIND_HOST is not available in this environment ' +
            '(Railway requires "::"; set BIND_HOST=127.0.0.1 for a local IPv4-only host)'
        : 'failed to bind',
    );
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // Railway can deliver SIGTERM more than once during a redeploy; draining twice
    // concurrently closes connections out from under in-flight work.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');
    healthBroadcast?.close();
    core.dispose();
    await alarmWorker.close();
    if (mediaWorker !== undefined) await mediaWorker.close();
    // The hub owns the socket server and, through it, the HTTP server; close it so both go
    // down cleanly. With no hub, close the HTTP server directly.
    if (hub !== null) await hub.close();
    else server.close();
    if (authRedis !== null) authRedis.disconnect();
    await queues.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

await main();
