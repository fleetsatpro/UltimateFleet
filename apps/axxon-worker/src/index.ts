import express from 'express';
import { createAlerts, createLogger, createMetrics } from '@deepsight/observability';
import { createQueueFactory, QUEUE_NAMES } from '@deepsight/queue';
import { AxxonAdapter } from '@deepsight/vendor-adapters';
import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import { loadAxxonEnv } from './env.js';
import { createReconnectingConsumer } from './consumer.js';

/**
 * The AxxonSoft worker: a dedicated Railway service that holds the long-poll/stream
 * connection, isolated from the integration engine so its reconnect lifecycle and memory
 * profile cannot affect ingestion. It publishes signed alarm jobs to BullMQ and never
 * touches the database — the env schema rejects DATABASE_URL to enforce that.
 */
async function main(): Promise<void> {
  const env = loadAxxonEnv();

  const logger = createLogger({ service: 'axxon-worker', level: env.LOG_LEVEL });
  const metrics = createMetrics();
  const alerts = createAlerts(logger);
  const startedAt = new Date();

  const queues = createQueueFactory({
    redisUrl: env.REDIS_URL,
    service: 'axxon-worker',
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

  // Each alarm becomes one signed job on alarm.ingest. The engine's alarm worker verifies
  // the envelope and ingests — the queue is the trust boundary between the two services.
  const alarmQueue = queues.queue<{ events: readonly NormalizedAlarmEvent[] }>(
    QUEUE_NAMES.alarmIngest,
  );

  const adapter = new AxxonAdapter();
  const consumer = createReconnectingConsumer(
    {
      adapter,
      publish: async (event) => {
        await alarmQueue.add('axxon-alarm', { events: [event] });
      },
      logger,
      metrics,
      alerts,
    },
    { initialBackoffMs: env.RECONNECT_INITIAL_MS, maxBackoffMs: env.RECONNECT_MAX_MS },
  );

  // A minimal HTTP surface: /health only. The worker is not a public service.
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'axxon-worker',
      startedAt: startedAt.toISOString(),
      reconnects: consumer.reconnectCount(),
      listeners: consumer.listenerCount(),
    });
  });

  const server = app.listen(env.PORT, env.BIND_HOST, () => {
    logger.info({ port: env.PORT, host: env.BIND_HOST }, 'axxon worker listening');
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error(
      { err: error.message, code: error.code, host: env.BIND_HOST },
      error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL'
        ? 'failed to bind: BIND_HOST unavailable (Railway needs "::"; use 127.0.0.1 locally)'
        : 'failed to bind',
    );
    process.exit(1);
  });

  // The stream consumer runs for the life of the process. It is expected to reject only
  // when it has fully stopped and drained.
  const running = consumer.run().catch((error: unknown) => {
    logger.error(
      { err: error instanceof Error ? error.message : error },
      'stream consumer exited unexpectedly',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down; draining in-flight publishes');
    server.close();
    // stop() aborts the stream and drains in-flight publishes, so a SIGTERM mid-stream
    // loses nothing.
    await consumer.stop();
    await running;
    await queues.close();
    logger.info({}, 'axxon worker stopped cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
