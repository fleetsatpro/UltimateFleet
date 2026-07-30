import { closePool, initPool } from '@deepsight/db';
import { createAlerts, createLogger, createMetrics } from '@deepsight/observability';
import { createQueueFactory, QUEUE_NAMES } from '@deepsight/queue';
import { loadEngineEnv } from './env.js';
import { createApp } from './http/app.js';
import { createEngineCore } from './core.js';

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

  const core = await createEngineCore({ logger, metrics, alerts });

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

  const app = createApp({
    logger,
    metrics,
    alerts,
    mappings: core.mappings,
    startedAt,
    webhooks: core.webhooks,
    vendorHealth: core.vendorHealth,
    ...(env.ADMIN_API_TOKEN !== undefined ? { adminToken: env.ADMIN_API_TOKEN } : {}),
  });

  const server = app.listen(env.PORT, env.BIND_HOST, () => {
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
    server.close();
    core.dispose();
    await alarmWorker.close();
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
