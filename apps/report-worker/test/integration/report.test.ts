import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getReportRun, initPool, insertAlarmEvent, withOrg } from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { appDatabaseUrl, makeFakeEvent } from '@deepsight/test-support';
import { aggregate, type ReportSource } from '../../src/aggregate.js';
import { createBrowserPool, type BrowserPool } from '../../src/pool.js';
import { runReport, type RunReportDeps } from '../../src/run.js';

/**
 * Phase 10 acceptance suite for the report worker: browser pooling and recycling, partial-failure
 * isolation, a row on every outcome, deterministic PDFs, and per-client RLS.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const CLIENT_A2 = '0a000000-0000-4000-8000-0000000000c2';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';
const SITE_A2_1 = '0a000000-0000-4000-8000-0000000000f3';
// Resolve a Chromium binary that actually exists: the pre-installed one here, or whatever
// Playwright manages in CI. The browser-dependent tests skip (rather than fail) if none is found.
function resolveChromium(): string | null {
  // executablePath() returns the path Playwright would use (it does not throw when a browsers
  // path is configured, only returns a possibly-absent path), so both candidates are filtered by
  // existence and the first real binary wins.
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    chromium.executablePath(),
  ];
  return candidates.find((p) => p !== '' && existsSync(p)) ?? null;
}
const EXE = resolveChromium();
const PERIOD_START = new Date('2026-09-01T00:00:00Z');
const PERIOD_END = new Date('2026-10-01T00:00:00Z');

const capture = createCapturingLogger('report-test');
const metrics = createMetrics();
const alerts = createAlerts(capture.logger);

function deps(pool: BrowserPool): RunReportDeps {
  return { pool, logger: capture.logger, metrics, alerts };
}

function job(clientId: string, sources: readonly ReportSource[]) {
  return {
    orgId: ORG_A,
    clientId,
    clientName: `Client ${clientId.slice(-2)}`,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    correlationId: 'phase10',
    sources,
  };
}

const countSource = (n: number): ReportSource => ({
  name: 'alarm_events',
  fetch: () => Promise.resolve(n),
});
const failingSource: ReportSource = {
  name: 'flaky_vendor',
  fetch: () => Promise.reject(new Error('vendor timed out')),
};

beforeAll(async () => {
  initPool({ connectionString: appDatabaseUrl(), max: 4 });
  // Distinguishable per-client counts, all in the report period, to prove RLS client-narrowing.
  const seed = async (clientId: string, siteId: string, count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      await withOrg(ORG_A, (tx) =>
        insertAlarmEvent(
          tx,
          makeFakeEvent({
            orgId: ORG_A,
            clientId,
            siteId,
            vendor: 'axxon',
            vendorEventId: `phase10-${clientId}-${i}`,
            correlationId: 'phase10',
            occurredAt: new Date('2026-09-15T10:00:00Z'),
          }),
        ),
      );
    }
  };
  await seed(CLIENT_A1, SITE_A1_1, 3);
  await seed(CLIENT_A2, SITE_A2_1, 2);
});

afterAll(async () => {
  await withOrg(ORG_A, async (tx) => {
    await tx.query(`DELETE FROM report_runs WHERE correlation_id = 'phase10'`);
    await tx.query(`DELETE FROM alarm_events WHERE correlation_id = 'phase10'`);
  });
  await closePool();
});

describe('AC1 — the browser pool caps process count under concurrency', () => {
  it('serves 20 concurrent renders with at most maxBrowsers+1 launches', async () => {
    if (EXE === null) return; // no Chromium available: skip rather than fail
    const pool = createBrowserPool({
      executablePath: EXE,
      maxBrowsers: 2,
      maxRendersPerBrowser: 50,
    });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => pool.render(`<h1>Report ${i}</h1>`)),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const stats = pool.stats();
      expect(stats.totalRenders).toBe(20);
      // Pooling, not per-report launch: 20 renders, but never more than 2 (+1 in-flight) browsers.
      expect(stats.totalLaunched).toBeLessThanOrEqual(3);
    } finally {
      await pool.close();
    }
  }, 60_000);
});

describe('AC4 — browsers are recycled after N renders', () => {
  it('relaunches after the render cap, keeping live browsers bounded', async () => {
    if (EXE === null) return; // no Chromium available: skip rather than fail
    const pool = createBrowserPool({
      executablePath: EXE,
      maxBrowsers: 1,
      maxRendersPerBrowser: 3,
    });
    try {
      for (let i = 0; i < 9; i += 1) await pool.render(`<h1>${i}</h1>`);
      const stats = pool.stats();
      expect(stats.totalRenders).toBe(9);
      // 9 renders / 3-per-browser => at least 3 launches: recycling happened, not one immortal
      // browser accumulating memory.
      expect(stats.totalLaunched).toBeGreaterThanOrEqual(3);
      expect(stats.liveBrowsers).toBeLessThanOrEqual(1);
    } finally {
      await pool.close();
    }
  }, 60_000);
});

describe('AC5 — identical data renders a byte-identical PDF', () => {
  it('produces the same PDF bytes twice over frozen data', async () => {
    if (EXE === null) return; // no Chromium available: skip rather than fail
    const pool = createBrowserPool({
      executablePath: EXE,
      maxBrowsers: 1,
      maxRendersPerBrowser: 50,
    });
    try {
      const a = await runReport(deps(pool), job(CLIENT_A1, [countSource(3)]));
      const b = await runReport(deps(pool), job(CLIENT_A1, [countSource(3)]));
      expect(a.pdf).not.toBeNull();
      expect(b.pdf).not.toBeNull();
      expect(a.status).toBe('complete');
      expect(Buffer.compare(a.pdf!, b.pdf!)).toBe(0);
    } finally {
      await pool.close();
    }
  }, 60_000);
});

describe('AC2 — a failing source marks one report partial without touching the others', () => {
  it('marks client A1 partial and client A2 complete in isolation', async () => {
    if (EXE === null) return; // no Chromium available: skip rather than fail
    const pool = createBrowserPool({
      executablePath: EXE,
      maxBrowsers: 1,
      maxRendersPerBrowser: 50,
    });
    try {
      const partial = await runReport(deps(pool), job(CLIENT_A1, [countSource(3), failingSource]));
      const complete = await runReport(deps(pool), job(CLIENT_A2, [countSource(2)]));

      expect(partial.status).toBe('partial');
      expect(complete.status).toBe('complete');

      const partialRow = await withOrg(ORG_A, (tx) => getReportRun(tx, partial.reportRunId));
      expect(partialRow?.status).toBe('partial');
      expect(JSON.stringify(partialRow?.error_detail)).toContain('flaky_vendor');
      const completeRow = await withOrg(ORG_A, (tx) => getReportRun(tx, complete.reportRunId));
      expect(completeRow?.status).toBe('complete');
      expect(completeRow?.error_detail).toBeNull();
    } finally {
      await pool.close();
    }
  }, 60_000);
});

describe('AC3 — a render that throws still writes a failed row', () => {
  it('records status=failed with the error, never silently disappearing', async () => {
    // A pool whose render always throws — no real browser needed to prove the failure path.
    const throwingPool: BrowserPool = {
      render: () => Promise.reject(new Error('browser crashed')),
      stats: () => ({ liveBrowsers: 0, totalLaunched: 0, totalRenders: 0 }),
      close: () => Promise.resolve(),
    };
    const outcome = await runReport(deps(throwingPool), job(CLIENT_A1, [countSource(3)]));
    expect(outcome.status).toBe('failed');
    const row = await withOrg(ORG_A, (tx) => getReportRun(tx, outcome.reportRunId));
    expect(row?.status).toBe('failed');
    expect(JSON.stringify(row?.error_detail)).toContain('browser crashed');
  });
});

describe('AC6 — per-client aggregation sees only that client’s rows', () => {
  it('counts client A1’s 3 events and never client A2’s 2', async () => {
    // withOrgClient RLS scoping: A1 must not see A2's rows even though both are org A.
    const aggA1 = await aggregate(ORG_A, CLIENT_A1, [
      {
        name: 'alarm_events',
        fetch: (tx) =>
          tx
            .query<{ n: string }>(
              `SELECT count(*)::text AS n FROM alarm_events WHERE occurred_at >= $1 AND occurred_at < $2`,
              [PERIOD_START, PERIOD_END],
            )
            .then((r) => Number(r.rows[0]?.n ?? '0')),
      },
    ]);
    expect(aggA1.data['alarm_events']).toBe(3);

    const aggA2 = await aggregate(ORG_A, CLIENT_A2, [
      {
        name: 'alarm_events',
        fetch: (tx) =>
          tx
            .query<{ n: string }>(
              `SELECT count(*)::text AS n FROM alarm_events WHERE occurred_at >= $1 AND occurred_at < $2`,
              [PERIOD_START, PERIOD_END],
            )
            .then((r) => Number(r.rows[0]?.n ?? '0')),
      },
    ]);
    expect(aggA2.data['alarm_events']).toBe(2);
  });
});
