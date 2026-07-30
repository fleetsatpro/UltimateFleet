import type { Alerts, Logger, Metrics } from '@deepsight/observability';
import type { TypedQueue } from '@deepsight/queue';
import type { MediaSink } from '../ingestion/pipeline.js';
import { mediaJobPriority, type MediaFetchJob } from './job.js';

/**
 * The {@link MediaSink} implementation: turns the media rows persisted with an alarm event
 * into signed `media.fetch` jobs, each carrying a BullMQ priority derived from its expiry so
 * the soonest-to-expire URL is fetched first.
 *
 * One job per row. The payload is signed by the queue factory on `add`, so the media worker
 * verifies provenance before touching a vendor URL — the same trust boundary the alarm queue
 * uses, for the same reason: a job on shared Redis is not authenticated by its network origin.
 */
export interface MediaEnqueuerDeps {
  readonly queue: TypedQueue<MediaFetchJob>;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
  /** Injectable clock so priority-from-expiry is deterministic under test. */
  readonly now?: (() => Date) | undefined;
}

export function createMediaEnqueuer(deps: MediaEnqueuerDeps): MediaSink {
  const now = deps.now ?? (() => new Date());

  return {
    async enqueue(input) {
      for (const row of input.rows) {
        const priority = mediaJobPriority(row.expires_at, now());
        const job: MediaFetchJob = {
          media_id: row.id,
          org_id: input.orgId,
          client_id: input.clientId,
          alarm_event_id: input.alarmEventId,
          source_url: row.source_url,
          kind: row.kind as MediaFetchJob['kind'],
          correlation_id: input.correlationId,
        };
        await deps.queue.add('media-fetch', job, { priority });
        deps.metrics.counter('media_enqueued_total', 1);
        deps.logger.debug(
          { mediaId: row.id, priority, expiresAt: row.expires_at },
          'media fetch enqueued',
        );
      }
    },
  };
}
