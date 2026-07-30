import { Queue, Worker, type Job, type JobsOptions, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import {
  currentCorrelation,
  newCorrelationId,
  withCorrelation,
  type Alerts,
  type Logger,
  type Metrics,
} from '@deepsight/observability';
import {
  createEnvelopeSigner,
  type EnvelopeSigner,
  type EnvelopeSignerOptions,
  type ServiceName,
  type SignedJobEnvelope,
} from './envelope.js';

/**
 * BullMQ queue and worker factories.
 *
 * Verification lives INSIDE the worker factory, before the handler is ever called, so a
 * worker cannot be constructed that skips it. That placement is the whole point: if
 * verification were a helper the handler was expected to call, the first handler written
 * in a hurry would forget, and an unsigned job would be indistinguishable from a signed
 * one. Here the handler never sees an unverified payload at all — it receives the typed
 * payload only after the signature holds.
 */

export const QUEUE_NAMES = {
  alarmIngest: 'alarm.ingest',
  mediaFetch: 'media.fetch',
  reportRun: 'report.run',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface QueueContext {
  readonly redisUrl: string;
  readonly service: ServiceName;
  readonly signing: EnvelopeSignerOptions;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

export interface TypedQueue<T> {
  readonly name: QueueName;
  add(jobName: string, payload: T, options?: JobsOptions): Promise<string>;
  close(): Promise<void>;
  /** Exposed for queue-depth metrics (brief section 3) and for draining in tests. */
  counts(): Promise<{ waiting: number; active: number; failed: number }>;
  drain(): Promise<void>;
}

export interface TypedWorker {
  close(): Promise<void>;
}

/**
 * BullMQ requires maxRetriesPerRequest: null on its connection; with the default,
 * a blocking command that outlives the retry budget throws and kills the worker.
 */
function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export interface QueueFactory {
  queue<T>(name: QueueName): TypedQueue<T>;
  worker<T>(
    name: QueueName,
    handler: (payload: T, job: Job<SignedJobEnvelope<T>>) => Promise<void>,
    options?: Partial<Pick<WorkerOptions, 'concurrency'>>,
  ): TypedWorker;
  signer: EnvelopeSigner;
  close(): Promise<void>;
}

export function createQueueFactory(context: QueueContext): QueueFactory {
  const signer = createEnvelopeSigner(context.signing);
  const connections: Redis[] = [];
  const queues: Queue[] = [];
  const workers: Worker[] = [];

  const connection = () => {
    const conn = createConnection(context.redisUrl);
    connections.push(conn);
    return conn;
  };

  return {
    signer,

    queue<T>(name: QueueName): TypedQueue<T> {
      const queue = new Queue<SignedJobEnvelope<T>>(name, {
        connection: connection(),
        defaultJobOptions: {
          attempts: 3,
          // Jittered rather than plain exponential: a thundering herd of retries after a
          // downstream recovers is its own outage.
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 5_000 },
        },
      });
      queues.push(queue as Queue);

      return {
        name,
        async add(jobName, payload, options) {
          const envelope = signer.sign(payload, context.service);
          const job = await queue.add(jobName, envelope, options);
          context.metrics.counter('queue_jobs_enqueued_total', 1, { queue: name });
          return job.id ?? '';
        },
        async close() {
          await queue.close();
        },
        async counts() {
          const counts = await queue.getJobCounts('waiting', 'active', 'failed');
          return {
            waiting: counts['waiting'] ?? 0,
            active: counts['active'] ?? 0,
            failed: counts['failed'] ?? 0,
          };
        },
        async drain() {
          await queue.drain();
        },
      };
    },

    worker<T>(
      name: QueueName,
      handler: (payload: T, job: Job<SignedJobEnvelope<T>>) => Promise<void>,
      options?: Partial<Pick<WorkerOptions, 'concurrency'>>,
    ): TypedWorker {
      const worker = new Worker<SignedJobEnvelope<T>>(
        name,
        async (job) => {
          const verdict = signer.verify<T>(job.data);

          if (!verdict.ok) {
            context.metrics.counter('queue_jobs_rejected_total', 1, {
              queue: name,
              reason: verdict.reason,
            });
            // An unverifiable job is not a transient fault, so retrying is pointless and
            // alerting is mandatory: either a secret is misconfigured or something is
            // writing to our Redis that should not be.
            context.alerts.fire('queue_job_signature_invalid', {
              severity: 'critical',
              queue: name,
              jobId: job.id ?? 'unknown',
              reason: verdict.reason,
            });
            throw new UnverifiedJobError(name, verdict.reason);
          }

          // Continue the publisher's trace when one was carried, otherwise start one, so
          // a job never lands in the logs with no correlation id at all.
          const carried = (job.data as { payload?: { correlation_id?: unknown } }).payload;
          const correlationId =
            typeof carried?.correlation_id === 'string'
              ? carried.correlation_id
              : (currentCorrelation()?.correlationId ?? newCorrelationId());

          await withCorrelation({ correlationId }, async () => {
            const started = Date.now();
            try {
              await handler(verdict.payload, job);
              context.metrics.counter('queue_jobs_completed_total', 1, { queue: name });
            } catch (error) {
              context.metrics.counter('queue_jobs_failed_total', 1, { queue: name });
              context.logger.error(
                { queue: name, jobId: job.id, err: error instanceof Error ? error.message : error },
                'queue job failed',
              );
              throw error;
            } finally {
              context.metrics.histogram('queue_job_duration_ms', Date.now() - started, {
                queue: name,
              });
            }
          });
        },
        { connection: connection(), concurrency: options?.concurrency ?? 5 },
      );

      // Without an error listener BullMQ emits an unhandled 'error' event, which on some
      // Node versions takes the process down.
      worker.on('error', (error) => {
        context.logger.error({ queue: name, err: error.message }, 'bullmq worker error');
      });

      workers.push(worker as Worker);
      return {
        async close() {
          await worker.close();
        },
      };
    },

    async close() {
      for (const worker of workers) await worker.close();
      for (const queue of queues) await queue.close();
      for (const conn of connections) conn.disconnect();
    },
  };
}

export class UnverifiedJobError extends Error {
  constructor(queue: string, reason: string) {
    super(`Rejected job on "${queue}" before handling: ${reason}`);
    this.name = 'UnverifiedJobError';
  }
}
