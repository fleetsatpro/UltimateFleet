import { closePool, initPool } from '@deepsight/db';
import { createAlerts, createLogger, createMetrics } from '@deepsight/observability';
import { createQueueFactory, QUEUE_NAMES } from '@deepsight/queue';
import { createR2ObjectStore, type ObjectStore } from '@deepsight/storage-r2';
import { loadReportEnv } from './env.js';
import { createBrowserPool } from './pool.js';
import { defaultReportSources } from './aggregate.js';
import { runReport } from './run.js';

/**
 * The report worker service. It consumes signed `report.run` jobs, renders each client's report to
 * a PDF through the bounded browser pool, archives it to R2 when configured, and records the
 * outcome on `report_runs`. It is a separate app from the engine because Chromium's memory and CPU
 * profile is spiky and must not share a process with low-latency ingestion.
 */
interface ReportJobPayload {
  readonly orgId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

async function main(): Promise<void> {
  const env = loadReportEnv();
  const logger = createLogger({ service: 'report-worker', level: env.LOG_LEVEL });
  const metrics = createMetrics();
  const alerts = createAlerts(logger);

  initPool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });

  const queues = createQueueFactory({
    redisUrl: env.REDIS_URL,
    service: 'report-worker',
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

  const pool = createBrowserPool({
    executablePath: env.CHROMIUM_EXECUTABLE_PATH,
    maxBrowsers: env.POOL_MAX_BROWSERS,
    maxRendersPerBrowser: env.POOL_MAX_RENDERS,
    ...(env.POOL_RSS_CEILING_MB > 0
      ? { rssCeilingBytes: env.POOL_RSS_CEILING_MB * 1024 * 1024 }
      : {}),
  });

  let objectStore: ObjectStore | undefined;
  if (
    env.R2_ENDPOINT !== undefined &&
    env.R2_BUCKET !== undefined &&
    env.R2_ACCESS_KEY_ID !== undefined &&
    env.R2_SECRET_ACCESS_KEY !== undefined
  ) {
    objectStore = createR2ObjectStore({
      endpoint: env.R2_ENDPOINT,
      region: env.R2_REGION,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });
    logger.info({ bucket: env.R2_BUCKET }, 'report archival to R2 enabled');
  } else {
    logger.warn({}, 'report archival disabled: R2 not configured (Open Item 10)');
  }

  const worker = queues.worker<ReportJobPayload>(
    QUEUE_NAMES.reportRun,
    async (payload, job) => {
      const periodStart = new Date(payload.periodStart);
      const periodEnd = new Date(payload.periodEnd);
      await runReport(
        { pool, ...(objectStore !== undefined ? { objectStore } : {}), logger, metrics, alerts },
        {
          orgId: payload.orgId,
          clientId: payload.clientId,
          clientName: payload.clientName,
          periodStart,
          periodEnd,
          correlationId: job.id ?? 'report',
          sources: defaultReportSources(periodStart, periodEnd),
        },
      );
    },
    { concurrency: env.POOL_MAX_BROWSERS },
  );

  logger.info({ maxBrowsers: env.POOL_MAX_BROWSERS }, 'report worker started');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await worker.close();
    await pool.close();
    await queues.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
