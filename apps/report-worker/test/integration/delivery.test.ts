import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  getReportRun,
  initPool,
  insertReportRun,
  listDeliveryAttempts,
  withOrg,
} from '@deepsight/db';
import { createAlerts, createCapturingLogger, createMetrics } from '@deepsight/observability';
import { appDatabaseUrl } from '@deepsight/test-support';
import { deliverReport, type EmailTransport, type SendResult } from '../../src/delivery.js';

/**
 * Phase 11 acceptance suite: report delivery logging. Every attempt is a row, delivery status is
 * independent of compilation status, and the ingestion correlation id closes the trace.
 */

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
const ARCHIVE_KEY = 'reports/org-a/client-a1/run.pdf';
const CORRELATION = 'phase11-corr';

const capture = createCapturingLogger('delivery-test');
const metrics = createMetrics();
const alerts = createAlerts(capture.logger);
const noSleep = (): Promise<void> => Promise.resolve();

beforeAll(() => initPool({ connectionString: appDatabaseUrl(), max: 4 }));
afterAll(() => closePool());

afterEach(async () => {
  await withOrg(ORG_A, async (tx) => {
    await tx.query(`DELETE FROM report_delivery_log WHERE correlation_id = $1`, [CORRELATION]);
    await tx.query(`DELETE FROM report_runs WHERE correlation_id = $1`, [CORRELATION]);
  });
});

async function completeRun(): Promise<string> {
  return withOrg(ORG_A, (tx) =>
    insertReportRun(tx, {
      orgId: ORG_A,
      clientId: CLIENT_A1,
      periodStart: new Date('2026-09-01T00:00:00Z'),
      periodEnd: new Date('2026-10-01T00:00:00Z'),
      status: 'complete',
      correlationId: CORRELATION,
    }),
  );
}

/** A transport whose per-address behaviour is scripted. */
function scriptedTransport(script: (to: string, attempt: number) => SendResult): EmailTransport {
  const attempts = new Map<string, number>();
  return {
    send(message) {
      const n = (attempts.get(message.to) ?? 0) + 1;
      attempts.set(message.to, n);
      return Promise.resolve(script(message.to, n));
    },
  };
}

function baseParams(reportRunId: string, recipients: readonly string[]) {
  return {
    orgId: ORG_A,
    clientId: CLIENT_A1,
    reportRunId,
    r2ArchiveKey: ARCHIVE_KEY,
    recipients,
    subject: 'Your security report',
    correlationId: CORRELATION,
  };
}

describe('AC1 — a failed delivery does not obscure a successful compilation', () => {
  it('keeps report_runs complete while the delivery row is failed', async () => {
    const runId = await completeRun();
    const transport = scriptedTransport(() => ({ status: 'failed', error: 'smtp unavailable' }));
    await deliverReport(
      { transport, logger: capture.logger, metrics, alerts, maxAttempts: 1, sleep: noSleep },
      baseParams(runId, ['ops@client.test']),
    );

    const run = await withOrg(ORG_A, (tx) => getReportRun(tx, runId));
    expect(run?.status).toBe('complete');
    const attempts = await withOrg(ORG_A, (tx) => listDeliveryAttempts(tx, runId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.delivery_status).toBe('failed');
  });
});

describe('AC2 — three recipients, one bounces', () => {
  it('writes two sent and one bounced, all sharing run id and archive key', async () => {
    const runId = await completeRun();
    const transport = scriptedTransport((to) =>
      to === 'bounce@client.test'
        ? { status: 'bounced', error: 'no such mailbox' }
        : { status: 'sent' },
    );
    await deliverReport(
      { transport, logger: capture.logger, metrics, alerts, maxAttempts: 1, sleep: noSleep },
      baseParams(runId, ['a@client.test', 'b@client.test', 'bounce@client.test']),
    );

    const attempts = await withOrg(ORG_A, (tx) => listDeliveryAttempts(tx, runId));
    expect(attempts).toHaveLength(3);
    expect(attempts.filter((a) => a.delivery_status === 'sent')).toHaveLength(2);
    expect(attempts.filter((a) => a.delivery_status === 'bounced')).toHaveLength(1);
    expect(attempts.every((a) => a.r2_archive_key === ARCHIVE_KEY)).toBe(true);
  });
});

describe('AC3 — a retried delivery appends a second row, keeping the first', () => {
  it('records the transient failure and the subsequent success as two rows', async () => {
    const runId = await completeRun();
    // Fail the first attempt, succeed the second.
    const transport = scriptedTransport((_to, attempt) =>
      attempt === 1 ? { status: 'failed', error: 'transient' } : { status: 'sent' },
    );
    await deliverReport(
      { transport, logger: capture.logger, metrics, alerts, maxAttempts: 3, sleep: noSleep },
      baseParams(runId, ['retry@client.test']),
    );

    const attempts = await withOrg(ORG_A, (tx) => listDeliveryAttempts(tx, runId));
    expect(attempts).toHaveLength(2);
    // Append-only: the first (failed) row is retained, ordered before the sent one.
    expect(attempts[0]?.delivery_status).toBe('failed');
    expect(attempts[1]?.delivery_status).toBe('sent');
  });
});

describe('AC4 — the ingestion correlation id reaches the delivery log', () => {
  it('stamps the correlation id on the delivery row', async () => {
    const runId = await completeRun();
    const transport = scriptedTransport(() => ({ status: 'sent' }));
    await deliverReport(
      { transport, logger: capture.logger, metrics, alerts, sleep: noSleep },
      baseParams(runId, ['trace@client.test']),
    );
    const attempts = await withOrg(ORG_A, (tx) => listDeliveryAttempts(tx, runId));
    expect(attempts[0]?.correlation_id).toBe(CORRELATION);
  });
});
