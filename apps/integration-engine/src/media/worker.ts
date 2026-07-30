import { Readable } from 'node:stream';
import { markMediaFailed, markMediaStored, withOrg } from '@deepsight/db';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';
import { objectKeyFor, type ObjectStore } from '@deepsight/storage-r2';
import type { MediaFetchJob } from './job.js';

/**
 * The `media.fetch` handler: stream one expiring vendor URL into R2 and record the outcome on
 * its `incident_media` row. Two properties are load-bearing:
 *
 *   - It NEVER buffers the object. The vendor response body is piped straight into the object
 *     store as a stream, so a 50 MB clip moves through with a flat memory profile (AC2). A
 *     `Buffer` anywhere on this path would defeat the whole reason media is a streaming worker.
 *   - A fetch failure is TERMINAL and ISOLATED. A 404 marks the row `failed` with a structured
 *     reason and completes the job — it never throws, so it neither retries into a storm nor
 *     touches the parent alarm event, which committed long before this job ran (AC3).
 */
export interface MediaFetchDeps {
  readonly objectStore: ObjectStore;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
  /** Injectable so unit tests can drive the vendor side without a live server. Defaults to fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMediaFetchHandler(
  deps: MediaFetchDeps,
): (job: MediaFetchJob) => Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;

  const recordFailed = async (
    job: MediaFetchJob,
    detail: Record<string, unknown>,
  ): Promise<void> => {
    deps.metrics.counter('media_fetch_failed_total', 1, { reason: String(detail['reason']) });
    deps.logger.warn({ mediaId: job.media_id, ...detail }, 'incident media fetch failed');
    await withOrg(job.org_id, (tx) => markMediaFailed(tx, job.media_id, detail));
  };

  return async (job: MediaFetchJob): Promise<void> => {
    const key = objectKeyFor({
      orgId: job.org_id,
      alarmEventId: job.alarm_event_id,
      mediaId: job.media_id,
    });

    try {
      const response = await doFetch(job.source_url);

      // A 4xx/5xx is a terminal outcome for an expiring URL: record and stop, do not throw.
      if (!response.ok) {
        await recordFailed(job, { reason: 'vendor_http_status', status: response.status });
        return;
      }
      if (response.body === null) {
        await recordFailed(job, { reason: 'empty_body' });
        return;
      }

      const contentType = response.headers.get('content-type') ?? undefined;
      const lengthHeader = response.headers.get('content-length');
      const contentLength =
        lengthHeader !== null && lengthHeader !== '' ? Number(lengthHeader) : undefined;

      // fromWeb, not arrayBuffer: the bytes flow through as a stream and are never all in
      // memory at once. This single line is what AC2's RSS assertion is really testing.
      const body = Readable.fromWeb(response.body);
      await deps.objectStore.put(key, body, {
        contentType,
        ...(contentLength !== undefined && Number.isFinite(contentLength) ? { contentLength } : {}),
      });

      await withOrg(job.org_id, (tx) => markMediaStored(tx, job.media_id, key));
      deps.metrics.counter('media_stored_total', 1, { kind: job.kind });
      deps.logger.info({ mediaId: job.media_id, key }, 'incident media stored');
    } catch (error) {
      // Network error, DNS failure, a store that rejected the upload — all terminal here, all
      // recorded on the row. Not rethrown: see the class comment on why media does not retry.
      await recordFailed(job, { reason: 'exception', message: describeError(error) });
    }
  };
}
