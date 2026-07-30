import {
  normalizedAlarmEventSchema,
  type NormalizedAlarmEvent,
  type VendorId,
} from '@deepsight/contracts';
import { insertAlarmEvent, withOrg } from '@deepsight/db';
import {
  extendCorrelation,
  type Alerts,
  type Logger,
  type Metrics,
} from '@deepsight/observability';

/**
 * The ingestion pipeline: validate -> normalize -> dedupe/persist -> fan out.
 *
 * The critical property is that FAN-OUT IS GATED ON ACTUAL INSERTION. `ON CONFLICT DO
 * NOTHING` returns zero rows for a duplicate, so we fan out only when a row was really
 * written. Without that gate, a vendor redelivering one event fifty times would push
 * fifty dashboard notifications and enqueue fifty media fetches while correctly writing a
 * single row — the database would look right and everything downstream would be wrong.
 */

/** Where a successfully persisted event goes next. Socket.io arrives in Phase 6. */
export interface FanOut {
  publish(event: NormalizedAlarmEvent): Promise<void>;
}

export interface PipelineDeps {
  readonly mappings: {
    resolve(
      vendor: VendorId,
      vendorCode: string,
    ): {
      event_type: NormalizedAlarmEvent['event_type'];
      severity: NormalizedAlarmEvent['severity'] | null;
      mapped: boolean;
    };
  };
  readonly fanOut: FanOut;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

export interface IngestOutcome {
  readonly persisted: number;
  readonly duplicates: number;
  readonly rejected: number;
}

/** Outcome plus the detail needed to investigate rejections rather than just count them. */
export type IngestResult = IngestOutcome & { readonly rejections: readonly RejectedEvent[] };

export interface RejectedEvent {
  readonly reason: string;
  readonly vendor: string;
  readonly vendorEventId: string | undefined;
}

/**
 * Applies the mapping table to a coded event.
 *
 * The adapter supplies `vendor_event_code`; the CORE owns classification. That split is
 * what lets a new vendor be added without touching ingestion, and what lets a new event
 * code be classified without a redeploy. When the vendor sends no code at all — some
 * vendors emit semantic events rather than numeric codes — the adapter's own event_type
 * stands, since there is nothing to look up.
 */
function applyMapping(
  event: NormalizedAlarmEvent,
  deps: PipelineDeps,
): { event: NormalizedAlarmEvent; unmappedCode: string | null } {
  if (event.vendor_event_code === null) {
    return { event, unmappedCode: null };
  }

  const resolution = deps.mappings.resolve(event.vendor, event.vendor_event_code);
  const mapped: NormalizedAlarmEvent = {
    ...event,
    event_type: resolution.event_type,
    severity: resolution.severity ?? event.severity,
  };

  return { event: mapped, unmappedCode: resolution.mapped ? null : event.vendor_event_code };
}

export async function ingestEvents(
  deps: PipelineDeps,
  events: readonly unknown[],
): Promise<IngestResult> {
  let persisted = 0;
  let duplicates = 0;
  const rejections: RejectedEvent[] = [];

  for (const candidate of events) {
    const parsed = normalizedAlarmEventSchema.safeParse(candidate);
    if (!parsed.success) {
      // Guarded because the candidate may be null or a primitive, not just a wrong-shaped
      // object. Reading a property off null here would throw INSIDE the rejection path and
      // abort the whole batch — turning one malformed event into total ingestion failure,
      // which is precisely the partial-failure propagation the brief forbids.
      const shape: { vendor?: unknown; vendor_event_id?: unknown } =
        candidate !== null && typeof candidate === 'object' ? candidate : {};
      const rejection: RejectedEvent = {
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        vendor: typeof shape.vendor === 'string' ? shape.vendor : 'unknown',
        vendorEventId:
          typeof shape.vendor_event_id === 'string' ? shape.vendor_event_id : undefined,
      };
      rejections.push(rejection);
      deps.metrics.counter('ingest_rejected_total', 1, { vendor: rejection.vendor });
      deps.logger.warn({ vendor: rejection.vendor, reason: rejection.reason }, 'event rejected');
      continue;
    }

    const event = parsed.data as NormalizedAlarmEvent;
    const { event: normalized, unmappedCode } = applyMapping(event, deps);

    if (unmappedCode !== null) {
      deps.metrics.counter('ingest_unmapped_code_total', 1, { vendor: normalized.vendor });
      // Alert, not just log: the event persists as 'unknown' so nothing appears broken,
      // and without an alert naming the code nobody ever adds the mapping row.
      deps.alerts.fire('alarm_event_code_unmapped', {
        severity: 'warning',
        vendor: normalized.vendor,
        vendor_event_code: unmappedCode,
      });
    }

    await extendCorrelation(
      {
        orgId: normalized.org_id,
        clientId: normalized.client_id,
        siteId: normalized.site_id,
        vendor: normalized.vendor,
      },
      async () => {
        const result = await withOrg(normalized.org_id, (tx) => insertAlarmEvent(tx, normalized));

        if (result.inserted) {
          persisted += 1;
          deps.metrics.counter('ingest_persisted_total', 1, { vendor: normalized.vendor });
          deps.logger.info(
            { internalId: normalized.internal_id, eventType: normalized.event_type },
            'alarm event persisted',
          );
          // Only now — the gate that makes redelivery harmless downstream.
          await deps.fanOut.publish(normalized);
          deps.logger.debug({ internalId: normalized.internal_id }, 'alarm event fanned out');
        } else {
          duplicates += 1;
          deps.metrics.counter('ingest_duplicate_suppressed_total', 1, {
            vendor: normalized.vendor,
          });
          deps.logger.debug(
            { vendorEventId: normalized.vendor_event_id },
            'duplicate alarm event suppressed',
          );
        }
      },
    );
  }

  return { persisted, duplicates, rejected: rejections.length, rejections };
}
