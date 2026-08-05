import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initPool, withOrg } from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { appDatabaseUrl, makeFakeEvent } from '@deepsight/test-support';
import type { NormalizedAlarmEvent } from '@deepsight/contracts';
import { createEngineCore } from '../../src/core.js';

/**
 * Phase 12 acceptance criterion 5: sustained load with zero row loss and bounded
 * ingestion->fan-out latency.
 *
 * The brief specifies 50 events/sec for 10 minutes (30,000 events). A literal 10-minute run
 * belongs in a scheduled load-test job, not a suite that runs on every push — so, following the
 * same pattern Phase 4's AC4 uses for its 10,000-event scale claim, this defaults to a SHORT,
 * fast run (a few seconds) and is driven to the brief's full scale via env vars:
 *
 *   LOAD_TEST_RATE=50 LOAD_TEST_DURATION_SEC=600 pnpm --filter @deepsight/integration-engine \
 *     exec vitest run --project integration load-test
 *
 * The property proven — zero row loss, p95 fan-out latency under the threshold — is identical at
 * either duration; only the exposure window to a regression that manifests slowly (a leak, a lock
 * escalation) changes. Events are scheduled to ARRIVE at the target rate without waiting for each
 * ingest to finish before scheduling the next, so this genuinely tests sustained concurrent
 * throughput rather than a serial trickle.
 *
 * Documented breaking point: a raw INSERT-loop probe against this environment's local PostgreSQL
 * measured ~1,460 inserts/sec (see the Phase 4 AC4 diagnosis). That is the practical ceiling for
 * a SINGLE engine instance's ingest path here; 50/sec sustained sits at ~3% of it, which is why
 * one instance is untroubled at the brief's target rate. Real Railway hardware/network will
 * differ, and multi-instance horizontal scaling (the Phase 6 Redis-adapter fan-out already
 * supports more than one engine instance) is the documented path past a single instance's ceiling
 * — this is an estimate from local measurement, not a guaranteed SLA figure.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';
const CORRELATION = 'phase12-load';

const RATE = Number(process.env['LOAD_TEST_RATE'] ?? '50');
const DURATION_SEC = Number(process.env['LOAD_TEST_DURATION_SEC'] ?? '4');
const TOTAL = Math.round(RATE * DURATION_SEC);

beforeAll(() => initPool({ connectionString: appDatabaseUrl(), max: 20 }));

afterAll(async () => {
  await withOrg(ORG_A, (tx) =>
    tx.query(`DELETE FROM alarm_events WHERE correlation_id = $1`, [CORRELATION]),
  );
  await closePool();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe(`AC5 — sustained ${RATE}/sec for ${DURATION_SEC}s: zero loss, p95 fan-out latency under 2s`, () => {
  it(
    'persists every event exactly once with bounded fan-out latency',
    async () => {
      const capture = createCapturingLogger('load-test');
      const metrics = createMetrics();
      const alerts = createAlerts(capture.logger);

      const submittedAt = new Map<string, number>();
      const receivedAt = new Map<string, number>();
      const core = await createEngineCore({
        logger: capture.logger,
        metrics,
        alerts,
        fanOut: {
          publish(event: NormalizedAlarmEvent) {
            receivedAt.set(event.internal_id, Date.now());
            return Promise.resolve();
          },
        },
      });

      const start = Date.now();
      const inFlight: Promise<void>[] = [];
      for (let i = 0; i < TOTAL; i += 1) {
        const targetAt = start + Math.round((i * 1000) / RATE);
        const now = Date.now();
        if (targetAt > now) await sleep(targetAt - now);

        const event = makeFakeEvent({
          orgId: ORG_A,
          clientId: CLIENT_A1,
          siteId: SITE_A1_1,
          vendor: 'axxon',
          vendorEventId: `${CORRELATION}-${i}`,
          correlationId: CORRELATION,
          vendorEventCode: null,
          eventType: 'intrusion',
        });
        submittedAt.set(event.internal_id, Date.now());
        // Not awaited here: scheduling proceeds at the target rate regardless of how long any one
        // ingest takes, which is what makes this a concurrency/throughput test rather than a
        // request-response benchmark.
        inFlight.push(core.ingest([event]).then(() => {}));
      }
      // allSettled, not all: one ingest rejecting must not hide the outcome of the other 199+
      // in-flight events — the same partial-failure-isolation discipline the pipeline itself
      // follows. Any rejection is a genuine test failure, surfaced explicitly below.
      const settled = await Promise.allSettled(inFlight);
      const rejected = settled.filter((s) => s.status === 'rejected');
      expect(rejected).toHaveLength(0);
      core.dispose();

      // Zero row loss: every submitted event actually persisted, none lost, none duplicated.
      const stored = await withOrg(ORG_A, async (tx) => {
        const r = await tx.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM alarm_events WHERE correlation_id = $1`,
          [CORRELATION],
        );
        return Number(r.rows[0]?.count ?? '0');
      });
      expect(stored).toBe(TOTAL);

      // p95 ingestion -> fan-out latency, over every event that actually reached fan-out.
      const latencies = [...submittedAt.entries()]
        .map(([id, t0]) => {
          const t1 = receivedAt.get(id);
          return t1 !== undefined ? t1 - t0 : null;
        })
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      expect(latencies).toHaveLength(TOTAL);
      const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? Infinity;
      expect(p95).toBeLessThan(2_000);
    },
    Math.max(60_000, DURATION_SEC * 1_000 + 60_000),
  );
});
