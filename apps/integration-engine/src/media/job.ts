/**
 * The `media.fetch` job: everything the worker needs to fetch one vendor URL and store it,
 * and nothing more. It carries no bytes — only the source URL and the identity of the
 * `incident_media` row to update — so the queue payload stays tiny regardless of media size.
 *
 * Snake-case `correlation_id` is deliberate: the queue factory threads a job's correlation id
 * into the worker's logging context by reading exactly that field, so naming it this way keeps
 * a media fetch on the same trace as the alarm event that spawned it.
 */
export interface MediaFetchJob {
  readonly media_id: string;
  readonly org_id: string;
  readonly client_id: string;
  readonly alarm_event_id: string;
  readonly source_url: string;
  readonly kind: 'image' | 'video' | 'unknown';
  readonly correlation_id: string;
}

/**
 * BullMQ priority is an integer where 1 is the most urgent and larger is less urgent, capped
 * below 2^21. We map a vendor URL's expiry deadline onto that range so the queue itself
 * fetches the soonest-to-expire media first — the whole reason `MediaRef` keeps the deadline
 * rather than a bare URL.
 */
export const MEDIA_PRIORITY_MIN = 1;
export const MEDIA_PRIORITY_MAX = 2_000_000;

export function mediaJobPriority(expiresAt: Date | null, now: Date): number {
  // No stated expiry is the least urgent — a URL with no deadline can wait behind every URL
  // that has one.
  if (expiresAt === null) return MEDIA_PRIORITY_MAX;
  const secondsUntilExpiry = Math.ceil((expiresAt.getTime() - now.getTime()) / 1000);
  // Sooner expiry -> smaller number -> higher priority. An already-expired URL clamps to the
  // most-urgent slot: fetch it now on the chance it still resolves, or never.
  return Math.min(MEDIA_PRIORITY_MAX, Math.max(MEDIA_PRIORITY_MIN, secondsUntilExpiry + 1));
}
