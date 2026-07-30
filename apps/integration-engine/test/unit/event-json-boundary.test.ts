import { describe, expect, it } from 'vitest';
import { normalizedAlarmEventSchema } from '@deepsight/contracts';
import { makeFakeEvent } from '@deepsight/test-support';

/**
 * Regression guard for the queue boundary bug (Phase 4).
 *
 * Every job placed on BullMQ is stored in Redis as JSON, so by the time the engine's alarm
 * worker validates a published event, its Date fields have become ISO strings. When
 * `occurred_at`/`received_at` were strict `z.date()`, validation rejected 100% of
 * queue-delivered events — the worker published, the engine silently discarded, and AC4
 * never drained. These tests lock the fix (`z.coerce.date()`) so a future tightening back
 * to `z.date()` fails fast here rather than as a mysterious ingestion stall.
 */

const ORG = '0a000000-0000-4000-8000-000000000001';
const CLIENT = '0a000000-0000-4000-8000-0000000000c1';
const SITE = '0a000000-0000-4000-8000-0000000000f1';

function event() {
  return makeFakeEvent({
    orgId: ORG,
    clientId: CLIENT,
    siteId: SITE,
    vendor: 'axxon',
    vendorEventId: 'boundary-1',
    correlationId: 'boundary',
  });
}

describe('the alarm event survives a JSON round trip (the BullMQ boundary)', () => {
  it('parses an event whose dates arrived as ISO strings', () => {
    // Exactly what Redis returns: the object after JSON.stringify/parse, dates now strings.
    const overWire = JSON.parse(JSON.stringify(event())) as unknown;
    expect(typeof (overWire as { occurred_at: unknown }).occurred_at).toBe('string');

    const parsed = normalizedAlarmEventSchema.parse(overWire);
    expect(parsed.occurred_at).toBeInstanceOf(Date);
    expect(parsed.received_at).toBeInstanceOf(Date);
    expect(parsed.occurred_at.toISOString()).toBe(event().occurred_at.toISOString());
  });

  it('still accepts a real Date from the in-process path unchanged', () => {
    const parsed = normalizedAlarmEventSchema.parse(event());
    expect(parsed.occurred_at).toBeInstanceOf(Date);
  });

  it('still rejects a value that is not a date at all', () => {
    const bad = { ...JSON.parse(JSON.stringify(event())), occurred_at: 'not-a-date' };
    expect(normalizedAlarmEventSchema.safeParse(bad).success).toBe(false);
  });
});
