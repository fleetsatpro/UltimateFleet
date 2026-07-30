import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initPool, withGlobalConfig, withOrg } from '@deepsight/db';
import {
  createAlerts,
  createCapturingLogger,
  createMetrics,
  newCorrelationId,
  withCorrelation,
  type Alerts,
  type Metrics,
} from '@deepsight/observability';
import {
  appDatabaseUrl,
  createFakePollAdapter,
  createFakeStreamAdapter,
  createFakeWebhookAdapter,
  makeFakeEvent,
  resetFakeEventIds,
  signFakeWebhook,
  FAKE_SIGNATURE_HEADER,
} from '@deepsight/test-support';
import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import { createEngineCore } from '../../src/core.js';
import {
  handleWebhookDelivery,
  runPollCycle,
  startStream,
} from '../../src/ingestion/dispatcher.js';
import type { FanOut } from '../../src/ingestion/pipeline.js';

/**
 * Phase 2 acceptance criteria 1, 2, 3 and 7.
 *
 * Runs against the real database and the real pipeline wiring from src/core.ts — a test
 * that assembles its own graph would prove things about the test, not the service.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';
const SOURCE_A1 = '0a000000-0000-4000-8000-000000000501';

interface CountingFanOut extends FanOut {
  readonly published: NormalizedAlarmEvent[];
}

function createCountingFanOut(): CountingFanOut {
  const published: NormalizedAlarmEvent[] = [];
  return {
    published,
    publish(event) {
      published.push(event);
      return Promise.resolve();
    },
  };
}

let metrics: Metrics;
let alerts: Alerts;
let capture: ReturnType<typeof createCapturingLogger>;

function metricValue(name: string, labels?: Record<string, string>): number {
  return metrics
    .snapshot()
    .filter((sample) => sample.name === name)
    .filter((sample) =>
      labels === undefined
        ? true
        : Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
    )
    .reduce((total, sample) => total + sample.value, 0);
}

beforeAll(() => {
  initPool({ connectionString: appDatabaseUrl(), max: 8 });
});

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  // Remove only rows this suite created, identified by their correlation prefix. Deleting
  // everything would destroy the Phase 1 fixtures other files still assert against.
  await withOrg(ORG_A, (tx) =>
    tx.query(`DELETE FROM alarm_events WHERE correlation_id LIKE 'phase2-%'`),
  );
  resetFakeEventIds();
});

function freshDeps(fanOut: CountingFanOut) {
  metrics = createMetrics();
  capture = createCapturingLogger('integration-engine-test');
  alerts = createAlerts(capture.logger);
  return { logger: capture.logger, metrics, alerts, fanOut };
}

describe('AC1 + AC2 — dedupe counts and fan-out gated on actual insertion', () => {
  it('writes 800 rows from 1,000 events with 200 duplicates, and fans out exactly 800 times', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));

    const unique: NormalizedAlarmEvent[] = [];
    for (let i = 0; i < 800; i += 1) {
      unique.push(
        makeFakeEvent({
          orgId: ORG_A,
          clientId: CLIENT_A1,
          siteId: SITE_A1_1,
          vendorEventId: `phase2-ac1-${i}`,
          correlationId: `phase2-ac1-${i}`,
        }),
      );
    }

    // 200 exact duplicates: same vendor_event_id, fresh internal_id — precisely what a
    // vendor redelivery or a poll window overlap produces.
    const duplicates = unique.slice(0, 200).map((event) =>
      makeFakeEvent({
        orgId: ORG_A,
        clientId: CLIENT_A1,
        siteId: SITE_A1_1,
        vendorEventId: event.vendor_event_id,
        correlationId: event.correlation_id,
      }),
    );

    const batch = [...unique, ...duplicates];
    expect(batch).toHaveLength(1000);

    const outcome = await core.ingest(batch);

    expect(outcome.persisted).toBe(800);
    expect(outcome.duplicates).toBe(200);
    expect(outcome.rejected).toBe(0);

    expect(metricValue('ingest_persisted_total')).toBe(800);
    expect(metricValue('ingest_duplicate_suppressed_total')).toBe(200);

    // The heart of AC2: 1,000 events in, 800 rows, and 800 fan-outs — not 1,000. Without
    // the insertion gate, a vendor redelivering one event 50 times would push 50 dashboard
    // notifications and enqueue 50 media fetches while correctly writing a single row.
    expect(fanOut.published).toHaveLength(800);

    const stored = await withOrg(ORG_A, async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM alarm_events WHERE correlation_id LIKE 'phase2-ac1-%'`,
      );
      return Number(result.rows[0]?.count ?? '0');
    });
    expect(stored).toBe(800);

    // Every fanned-out event must be one that was really written.
    const publishedIds = new Set(fanOut.published.map((e) => e.vendor_event_id));
    expect(publishedIds.size).toBe(800);
  });

  it('rejects malformed events without aborting the batch', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));

    const good = makeFakeEvent({
      orgId: ORG_A,
      clientId: CLIENT_A1,
      siteId: SITE_A1_1,
      vendorEventId: 'phase2-mixed-good',
      correlationId: 'phase2-mixed',
    });

    const outcome = await core.ingest([
      { vendor: 'dahua', vendor_event_id: 'phase2-mixed-bad', nonsense: true },
      good,
      null,
    ]);

    // Partial failure isolated: one valid event still lands.
    expect(outcome.persisted).toBe(1);
    expect(outcome.rejected).toBe(2);
    expect(fanOut.published).toHaveLength(1);
    expect(outcome.rejections[0]?.vendor).toBe('dahua');
  });
});

describe('AC3 — an unmapped vendor code becomes unknown and raises exactly one alert', () => {
  it('persists as unknown, retains the original code, and names the code in the alert', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));

    const event = makeFakeEvent({
      orgId: ORG_A,
      clientId: CLIENT_A1,
      siteId: SITE_A1_1,
      vendorEventId: 'phase2-ac3-unmapped',
      correlationId: 'phase2-ac3',
      vendorEventCode: '99999',
      // The adapter's own guess must not survive: the mapping table is authoritative
      // for coded events.
      eventType: 'intrusion',
    });

    const outcome = await core.ingest([event]);
    expect(outcome.persisted).toBe(1);

    const row = await withOrg(ORG_A, async (tx) => {
      const result = await tx.query<{ event_type: string; vendor_event_code: string | null }>(
        `SELECT event_type, vendor_event_code FROM alarm_events WHERE vendor_event_id = $1`,
        ['phase2-ac3-unmapped'],
      );
      return result.rows[0];
    });

    expect(row?.event_type).toBe('unknown');
    // Retained so the alert can name the code a supervisor has to map, without the
    // alerting path needing vendor-specific payload parsing.
    expect(row?.vendor_event_code).toBe('99999');

    const fired = alerts.fired().filter((a) => a.name === 'alarm_event_code_unmapped');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.context['vendor_event_code']).toBe('99999');
    expect(fired[0]?.severity).toBe('warning');
  });

  it('uses the mapping table, and its severity override, for a known code', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));

    // Seeded mapping: dahua 2002 -> door_forced, severity critical.
    const event = makeFakeEvent({
      orgId: ORG_A,
      clientId: CLIENT_A1,
      siteId: SITE_A1_1,
      vendorEventId: 'phase2-ac3-mapped',
      correlationId: 'phase2-ac3',
      vendorEventCode: '2002',
      eventType: 'motion',
      severity: 'low',
    });

    await core.ingest([event]);

    const row = await withOrg(ORG_A, async (tx) => {
      const result = await tx.query<{ event_type: string; severity: string }>(
        `SELECT event_type, severity FROM alarm_events WHERE vendor_event_id = $1`,
        ['phase2-ac3-mapped'],
      );
      return result.rows[0];
    });

    expect(row?.event_type).toBe('door_forced');
    expect(row?.severity).toBe('critical');
    expect(alerts.fired().filter((a) => a.name === 'alarm_event_code_unmapped')).toHaveLength(0);
  });

  it('keeps the adapter classification when the vendor sends no code at all', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));

    await core.ingest([
      makeFakeEvent({
        orgId: ORG_A,
        clientId: CLIENT_A1,
        siteId: SITE_A1_1,
        vendorEventId: 'phase2-ac3-nocode',
        correlationId: 'phase2-ac3',
        vendorEventCode: null,
        eventType: 'panic',
        severity: 'critical',
      }),
    ]);

    const row = await withOrg(ORG_A, async (tx) => {
      const result = await tx.query<{ event_type: string }>(
        `SELECT event_type FROM alarm_events WHERE vendor_event_id = $1`,
        ['phase2-ac3-nocode'],
      );
      return result.rows[0];
    });

    // Nothing to look up, so no alert and no downgrade to 'unknown'.
    expect(row?.event_type).toBe('panic');
    expect(alerts.fired().filter((a) => a.name === 'alarm_event_code_unmapped')).toHaveLength(0);
  });
});

describe('AC7 — one correlation id threads the whole path', () => {
  it('appears on every log line from ingestion through persistence to fan-out', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));
    capture.clear();

    const correlationId = newCorrelationId();

    await withCorrelation({ correlationId }, async () => {
      await core.ingest([
        makeFakeEvent({
          orgId: ORG_A,
          clientId: CLIENT_A1,
          siteId: SITE_A1_1,
          vendorEventId: 'phase2-ac7',
          correlationId: 'phase2-ac7',
          vendorEventCode: '1001',
        }),
      ]);
    });

    const lines = capture.lines();
    expect(lines.length).toBeGreaterThan(0);

    // Asserted against real emitted JSON, not against the intent to log it.
    for (const line of lines) {
      expect(line['correlationId'], `line without correlationId: ${JSON.stringify(line)}`).toBe(
        correlationId,
      );
      expect(line['service']).toBe('integration-engine-test');
    }

    // The persistence line must additionally carry the tenant context resolved from the
    // event, which is what makes a log searchable by org during an incident.
    const persisted = lines.find((line) => line['msg'] === 'alarm event persisted');
    expect(persisted).toBeDefined();
    expect(persisted?.['orgId']).toBe(ORG_A);
    expect(persisted?.['clientId']).toBe(CLIENT_A1);
    expect(persisted?.['siteId']).toBe(SITE_A1_1);
    expect(persisted?.['vendor']).toBe('dahua');

    const fannedOut = lines.find((line) => line['msg'] === 'alarm event fanned out');
    expect(fannedOut?.['correlationId']).toBe(correlationId);
  });
});

describe('dispatcher drives all three ingestion modes', () => {
  it('poll: resumes from the persisted cursor and advances it only after ingestion', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));
    const adapter = createFakePollAdapter('guardtek');
    const deps = { ...freshDeps(fanOut), mappings: core.mappings, cursors: core.cursors, fanOut };
    const source = { orgId: ORG_A, sourceId: SOURCE_A1 };

    adapter.setBatch(
      [
        makeFakeEvent({
          orgId: ORG_A,
          clientId: CLIENT_A1,
          siteId: SITE_A1_1,
          vendor: 'guardtek',
          vendorEventId: 'phase2-poll-1',
          correlationId: 'phase2-poll',
          vendorEventCode: 'PANIC',
        }),
      ],
      { value: 'cursor-after-first' },
    );

    const first = await runPollCycle(adapter, source, deps, new AbortController().signal);
    expect(first.persisted).toBe(1);
    expect(adapter.seenCursors[0]).toBeNull();

    adapter.setBatch([], { value: 'cursor-after-second' });
    await runPollCycle(adapter, source, deps, new AbortController().signal);

    // The second cycle must have been handed the cursor the first one returned — the
    // property that makes polling survive a redeploy instead of re-fetching everything.
    expect(adapter.seenCursors[1]).toEqual({ value: 'cursor-after-first' });

    await withOrg(ORG_A, (tx) =>
      tx.query(`UPDATE alarm_sources SET poll_cursor = NULL WHERE id = $1`, [SOURCE_A1]),
    );
  });

  it('webhook: a forged body never reaches handleWebhook', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));
    const adapter = createFakeWebhookAdapter('dahua');
    const deps = { ...freshDeps(fanOut), mappings: core.mappings, cursors: core.cursors, fanOut };

    const body = Buffer.from(
      JSON.stringify({
        events: [
          makeFakeEvent({
            orgId: ORG_A,
            clientId: CLIENT_A1,
            siteId: SITE_A1_1,
            vendorEventId: 'phase2-webhook-1',
            correlationId: 'phase2-webhook',
          }),
        ],
      }),
      'utf8',
    );

    const accepted = await handleWebhookDelivery(
      adapter,
      body,
      { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body) },
      deps,
    );
    expect(accepted.accepted).toBe(true);
    expect(accepted.outcome?.persisted).toBe(1);
    expect(adapter.handled).toHaveLength(1);

    // One byte changed: rejected, and crucially handleWebhook is never reached, so no
    // forged payload is ever parsed.
    const tampered = Buffer.from(body);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 32 ? 33 : 32;
    const rejected = await handleWebhookDelivery(
      adapter,
      tampered,
      { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body) },
      deps,
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toMatch(/signature/);
    expect(adapter.handled).toHaveLength(1);
  });

  it('stream: stopping unsubscribes, so listeners do not accumulate across reconnects', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));
    const adapter = createFakeStreamAdapter('axxon');
    const deps = { ...freshDeps(fanOut), mappings: core.mappings, cursors: core.cursors, fanOut };

    for (let reconnect = 0; reconnect < 5; reconnect += 1) {
      const handle = await startStream(adapter, deps, new AbortController().signal);
      expect(adapter.listenerCount()).toBe(1);

      adapter.emit(
        makeFakeEvent({
          orgId: ORG_A,
          clientId: CLIENT_A1,
          siteId: SITE_A1_1,
          vendor: 'axxon',
          vendorEventId: `phase2-stream-${reconnect}`,
          correlationId: 'phase2-stream',
          vendorEventCode: 'AX_FIRE',
        }),
      );

      await handle.stop();
      // The leak this guards against: `on(): this` would leave a handler behind on every
      // reconnect, in the one process whose entire job is reconnecting forever.
      expect(adapter.listenerCount()).toBe(0);
    }

    const stored = await withOrg(ORG_A, async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM alarm_events WHERE correlation_id = 'phase2-stream'`,
      );
      return Number(result.rows[0]?.count ?? '0');
    });
    expect(stored).toBe(5);
  });
});

describe('mapping cache reads global config without a tenant context', () => {
  it('loads every seeded mapping row', async () => {
    const fanOut = createCountingFanOut();
    const core = await createEngineCore(freshDeps(fanOut));

    const dbCount = await withGlobalConfig(async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM alarm_event_type_mappings`,
      );
      return Number(result.rows[0]?.count ?? '0');
    });

    expect(core.mappings.size()).toBe(dbCount);
    expect(core.mappings.loadedAt()).toBeInstanceOf(Date);
  });
});
