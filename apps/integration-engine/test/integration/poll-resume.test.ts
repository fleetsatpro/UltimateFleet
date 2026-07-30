import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initPool, withOrg } from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { appDatabaseUrl, makeFakeEvent, resetFakeEventIds } from '@deepsight/test-support';
import type { NormalizedAlarmEvent, PollCursor, PollingAlarmAdapter } from '@deepsight/contracts';
import { createEngineCore } from '../../src/core.js';
import { runPollCycle, type DispatchDeps } from '../../src/ingestion/dispatcher.js';

/**
 * Phase 3 acceptance criterion 6: a poll interrupted mid-stream by AbortSignal persists its
 * cursor, and the next poll resumes from it with NO duplicate rows and NO skipped events.
 *
 * The property this protects: an in-flight poll dies when Railway sends SIGTERM on
 * redeploy, and polling must resume exactly where it stopped — never re-fetching everything
 * (dedupe would cover that, but at a cost) and, more importantly, never skipping the events
 * that had not yet been yielded when the poll was cut short.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';
const SOURCE_A1 = '0a000000-0000-4000-8000-000000000501';

beforeAll(() => {
  initPool({ connectionString: appDatabaseUrl(), max: 4 });
});

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  await withOrg(ORG_A, async (tx) => {
    await tx.query(`DELETE FROM alarm_events WHERE correlation_id LIKE 'phase3-poll%'`);
    await tx.query(`UPDATE alarm_sources SET poll_cursor = NULL WHERE id = $1`, [SOURCE_A1]);
  });
  resetFakeEventIds();
});

/**
 * A cursor-aware, abort-aware poll adapter.
 *
 * `pages` is an ordered list of {cursor-in, events, cursor-out}. Given a cursor, it finds
 * the matching page and yields its events, honouring the abort signal between yields and —
 * critically — returning a cursor that reflects only what it actually yielded. `abortAfter`
 * simulates SIGTERM landing mid-page.
 */
function pagedAdapter(
  pages: { from: PollCursor; events: NormalizedAlarmEvent[]; to: PollCursor }[],
): { adapter: PollingAlarmAdapter; abortAfter: (n: number) => void; controller: AbortController } {
  const controller = new AbortController();
  let abortAfterN = Number.POSITIVE_INFINITY;

  const adapter: PollingAlarmAdapter = {
    vendor: 'guardtek',
    mode: 'poll',
    healthCheck: () =>
      Promise.resolve({
        vendor: 'guardtek',
        status: 'connected' as const,
        breaker_state: 'closed' as const,
      }),
    async *poll(cursor: PollCursor, signal: AbortSignal) {
      const fromValue = cursor?.value ?? null;
      const page = pages.find((p) => (p.from?.value ?? null) === fromValue);
      if (page === undefined) return cursor;

      let yielded = 0;
      for (const event of page.events) {
        if (signal.aborted) {
          // Cut short: return a cursor reflecting only the events actually delivered, so
          // the next poll resumes at exactly the right place. Here that means NOT advancing
          // past the un-yielded events — we return the incoming cursor.
          return cursor;
        }
        yield event;
        yielded += 1;
        if (yielded >= abortAfterN) controller.abort();
      }
      return page.to;
    },
  };

  return { adapter, abortAfter: (n) => (abortAfterN = n), controller };
}

function dispatchFor(core: Awaited<ReturnType<typeof createEngineCore>>): DispatchDeps {
  const logger = createCapturingLogger('poll-resume-test');
  return {
    mappings: core.mappings,
    fanOut: core.fanOut,
    cursors: core.cursors,
    logger: logger.logger,
    metrics: createMetrics(),
    alerts: createAlerts(logger.logger),
  };
}

function event(id: string): NormalizedAlarmEvent {
  return makeFakeEvent({
    orgId: ORG_A,
    clientId: CLIENT_A1,
    siteId: SITE_A1_1,
    vendor: 'guardtek',
    vendorEventId: id,
    correlationId: 'phase3-poll',
    vendorEventCode: null,
    eventType: 'intrusion',
  });
}

async function storedIds(): Promise<string[]> {
  return withOrg(ORG_A, async (tx) => {
    const result = await tx.query<{ vendor_event_id: string }>(
      `SELECT vendor_event_id FROM alarm_events WHERE correlation_id LIKE 'phase3-poll%' ORDER BY vendor_event_id`,
    );
    return result.rows.map((r) => r.vendor_event_id);
  });
}

describe('AC6 — polling resumes after a mid-stream abort', () => {
  it('persists only the delivered events, then resumes with no duplicates and no skips', async () => {
    const capture = createCapturingLogger('poll-resume-test');
    const core = await createEngineCore({
      logger: capture.logger,
      metrics: createMetrics(),
      alerts: createAlerts(capture.logger),
    });
    const dispatch = dispatchFor(core);
    const source = { orgId: ORG_A, sourceId: SOURCE_A1 };

    // Page 1 (from null): e1, e2, e3, e4 -> cursor "after-page-1".
    // Page 2 (from "after-page-1"): e5, e6 -> cursor "after-page-2".
    const paged = pagedAdapter([
      {
        from: null,
        events: [
          event('phase3-poll-e1'),
          event('phase3-poll-e2'),
          event('phase3-poll-e3'),
          event('phase3-poll-e4'),
        ],
        to: { value: 'after-page-1' },
      },
      {
        from: { value: 'after-page-1' },
        events: [event('phase3-poll-e5'), event('phase3-poll-e6')],
        to: { value: 'after-page-2' },
      },
    ]);

    // Abort after 2 events on the first cycle: SIGTERM lands mid-page.
    paged.abortAfter(2);
    await runPollCycle(paged.adapter, source, dispatch, paged.controller.signal);

    // Only the two delivered events persisted; the cursor did NOT advance past them.
    expect(await storedIds()).toEqual(['phase3-poll-e1', 'phase3-poll-e2']);
    const cursorAfterAbort = await core.cursors.read(source);
    expect(cursorAfterAbort).toBeNull(); // stayed at the page's incoming cursor (null)

    // Next cycle, no abort: the same page re-yields e1..e4. e1/e2 dedupe harmlessly; e3/e4
    // are the events that had not been delivered — they must arrive, not be skipped.
    const paged2 = pagedAdapter([
      {
        from: null,
        events: [
          event('phase3-poll-e1'),
          event('phase3-poll-e2'),
          event('phase3-poll-e3'),
          event('phase3-poll-e4'),
        ],
        to: { value: 'after-page-1' },
      },
    ]);
    const outcome = await runPollCycle(paged2.adapter, source, dispatch, paged2.controller.signal);

    // e1, e2 were duplicates; e3, e4 are new. No event skipped.
    expect(outcome.persisted).toBe(2);
    expect(outcome.duplicates).toBe(2);
    expect(await storedIds()).toEqual([
      'phase3-poll-e1',
      'phase3-poll-e2',
      'phase3-poll-e3',
      'phase3-poll-e4',
    ]);
    // The cursor advanced only after the full page was ingested.
    expect(await core.cursors.read(source)).toEqual({ value: 'after-page-1' });
  });

  it('advances the cursor only after a full, uninterrupted cycle', async () => {
    const capture = createCapturingLogger('poll-resume-test');
    const core = await createEngineCore({
      logger: capture.logger,
      metrics: createMetrics(),
      alerts: createAlerts(capture.logger),
    });
    const dispatch = dispatchFor(core);
    const source = { orgId: ORG_A, sourceId: SOURCE_A1 };

    const paged = pagedAdapter([
      {
        from: null,
        events: [event('phase3-poll-a'), event('phase3-poll-b')],
        to: { value: 'done' },
      },
    ]);
    await runPollCycle(paged.adapter, source, dispatch, paged.controller.signal);

    expect(await storedIds()).toEqual(['phase3-poll-a', 'phase3-poll-b']);
    expect(await core.cursors.read(source)).toEqual({ value: 'done' });
  });
});
