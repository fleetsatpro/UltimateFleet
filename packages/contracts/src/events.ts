import { z } from 'zod';

/**
 * The shared vocabulary. Types and zod schemas live together deliberately: a type
 * without a validator gets trusted at an I/O boundary, which is how `unknown` vendor
 * payloads become runtime crashes three layers in.
 *
 * This module must import NOTHING from Node's standard library — React Native imports
 * this package, and a stray `import crypto` breaks the mobile bundler with an error
 * that points nowhere near the cause.
 */

export const VENDOR_IDS = ['guardtek', 'dahua', 'axxon'] as const;
export const vendorIdSchema = z.enum(VENDOR_IDS);
export type VendorId = z.infer<typeof vendorIdSchema>;

export const NORMALIZED_EVENT_TYPES = [
  'intrusion',
  'motion',
  'door_forced',
  'door_open',
  'fire',
  'panic',
  'tamper',
  'connection_loss',
  'unknown',
] as const;
export const normalizedEventTypeSchema = z.enum(NORMALIZED_EVENT_TYPES);
export type NormalizedEventType = z.infer<typeof normalizedEventTypeSchema>;

export const ALARM_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const alarmSeveritySchema = z.enum(ALARM_SEVERITIES);
export type AlarmSeverity = z.infer<typeof alarmSeveritySchema>;

/**
 * A vendor media reference.
 *
 * Refined from the brief's `media_urls: string[]`: a bare string loses the expiry
 * deadline, so the media pipeline cannot prioritise the URL expiring in 60 seconds
 * over the one expiring in an hour. Whether each vendor actually states an expiry is
 * unverified per vendor (open items 1-3), hence optional.
 */
export const mediaRefSchema = z.object({
  url: z.string().url(),
  kind: z.enum(['image', 'video', 'unknown']),
  // Coerced, not strict: an event that has crossed the BullMQ boundary arrives as JSON,
  // where a Date has become an ISO string. The in-process paths still pass a real Date,
  // which coercion returns unchanged. See occurred_at below for the full rationale.
  expires_at: z.coerce.date().optional(),
});
export interface MediaRef {
  readonly url: string;
  readonly kind: 'image' | 'video' | 'unknown';
  /**
   * Declared `| undefined` explicitly because `exactOptionalPropertyTypes` rejects
   * an explicitly-assigned `undefined` on a plain optional property, and adapters
   * naturally construct these as `expires_at: stated ? d : undefined`.
   */
  readonly expires_at?: Date | undefined;
}

export const normalizedAlarmEventSchema = z.object({
  internal_id: z.string().uuid(),
  vendor: vendorIdSchema,
  vendor_event_id: z.string().min(1),
  org_id: z.string().uuid(),
  client_id: z.string().uuid(),
  site_id: z.string().uuid(),
  event_type: normalizedEventTypeSchema,
  severity: alarmSeveritySchema,
  // `z.coerce.date()`, not `z.date()`, because this schema is the ingestion trust boundary
  // and events reach it two ways: in-process (webhook/poll) carrying real Date objects, and
  // over BullMQ, where JSON serialization has already turned every Date into an ISO string.
  // A strict `z.date()` rejects the entire queue path — the worker publishes, the engine
  // discards. Coercion accepts both: a Date passes through unchanged, a string is revived,
  // and anything `new Date()` cannot parse still fails validation. Provenance is not
  // weakened by this — queue jobs are HMAC-verified before they ever reach ingest.
  occurred_at: z.coerce.date(),
  received_at: z.coerce.date(),
  raw_payload: z.unknown(),
  media_urls: z.array(mediaRefSchema).readonly(),
  correlation_id: z.string().min(1),
  vendor_event_code: z.string().nullable(),
});

export interface NormalizedAlarmEvent {
  /** UUID v7: time-ordered, so it clusters on insert instead of scattering B-tree writes. */
  readonly internal_id: string;
  readonly vendor: VendorId;
  /** The idempotency key. Deduplicated against, per vendor. */
  readonly vendor_event_id: string;
  /** The RLS isolation key (divergence D6). */
  readonly org_id: string;
  readonly client_id: string;
  readonly site_id: string;
  readonly event_type: NormalizedEventType;
  readonly severity: AlarmSeverity;
  readonly occurred_at: Date;
  readonly received_at: Date;
  /** Stored as JSONB. The audit artifact and adapter debugging source — never dropped. */
  readonly raw_payload: unknown;
  /** Expiring vendor URLs; the media pipeline persists these to R2. */
  readonly media_urls: readonly MediaRef[];
  /** Threads ingestion -> persistence -> dashboard -> report run -> delivery. */
  readonly correlation_id: string;
  /**
   * The original vendor code, retained even when it mapped cleanly. Null means the
   * vendor sent no code. Without this, the "new event code appeared" alert cannot
   * name the code a supervisor has to map.
   */
  readonly vendor_event_code: string | null;
}

export const ATTENDANCE_EVENT_TYPES = ['sign_in', 'sign_out'] as const;
export const attendanceEventTypeSchema = z.enum(ATTENDANCE_EVENT_TYPES);
export type AttendanceEventType = z.infer<typeof attendanceEventTypeSchema>;

export const normalizedAttendanceRecordSchema = z.object({
  vendor_record_id: z.string().min(1),
  /** Explicitly nullable, not optional: "unmatched" must be a value the code handles. */
  guard_id: z.string().uuid().nullable(),
  org_id: z.string().uuid(),
  site_id: z.string().uuid(),
  client_id: z.string().uuid(),
  event_type: attendanceEventTypeSchema,
  // Coerced for the same reason as the alarm event: attendance records also cross the queue
  // boundary, where a Date is an ISO string by the time it is validated.
  occurred_at: z.coerce.date(),
  raw_payload: z.unknown(),
  correlation_id: z.string().min(1),
});

export interface NormalizedAttendanceRecord {
  readonly vendor_record_id: string;
  readonly guard_id: string | null;
  readonly org_id: string;
  readonly site_id: string;
  readonly client_id: string;
  readonly event_type: AttendanceEventType;
  readonly occurred_at: Date;
  readonly raw_payload: unknown;
  readonly correlation_id: string;
}
