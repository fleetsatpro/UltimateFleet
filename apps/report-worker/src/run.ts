import { Readable } from 'node:stream';
import { completeReportRun, insertReportRun, withOrg, type ReportStatus } from '@deepsight/db';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';
import type { ObjectStore } from '@deepsight/storage-r2';
import { aggregate, type ReportSource } from './aggregate.js';
import { periodLabel, renderReportHtml } from './template.js';
import type { BrowserPool } from './pool.js';

/**
 * Runs one client report end to end: a `report_runs` row is written FIRST (status `running`) so a
 * row exists no matter what happens next, then aggregate → render → archive, then the row is
 * finalised with the real outcome. Any throw — an aggregation error, a browser crash — still
 * finalises the row as `failed` with the error, so a report never silently disappears (AC3).
 */
export interface RunReportDeps {
  readonly pool: BrowserPool;
  readonly objectStore?: ObjectStore | undefined;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

export interface ReportJob {
  readonly orgId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly correlationId: string;
  readonly sources: readonly ReportSource[];
}

export interface ReportOutcome {
  readonly reportRunId: string;
  readonly status: ReportStatus;
  readonly pdf: Buffer | null;
  readonly r2ObjectKey: string | null;
}

function reportObjectKey(job: ReportJob, runId: string): string {
  return `reports/${job.orgId}/${job.clientId}/${runId}.pdf`;
}

/** Formats a PDF date literal: `D:YYYYMMDDHHmmSS+00'00'` (fixed 23-char length). */
function toPdfDate(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}+00'00'`
  );
}

/**
 * Normalizes the volatile date metadata Chromium stamps into every PDF (`/CreationDate`,
 * `/ModDate`) to a value derived from the report period rather than the wall clock. Without this
 * the same report rendered twice differs only in a hidden timestamp — so "byte-identical over
 * identical data" (AC5) would hold only if both renders happened in the same second. Replacing the
 * dates with a fixed, same-length literal keeps the PDF's byte offsets valid and makes archived
 * reports genuinely reproducible.
 */
function normalizePdfDates(pdf: Buffer, date: Date): Buffer {
  const stamp = toPdfDate(date);
  const text = pdf
    .toString('latin1')
    .replace(/\/CreationDate\s*\(D:[^)]*\)/g, `/CreationDate (${stamp})`)
    .replace(/\/ModDate\s*\(D:[^)]*\)/g, `/ModDate (${stamp})`);
  return Buffer.from(text, 'latin1');
}

export async function runReport(deps: RunReportDeps, job: ReportJob): Promise<ReportOutcome> {
  const reportRunId = await withOrg(job.orgId, (tx) =>
    insertReportRun(tx, {
      orgId: job.orgId,
      clientId: job.clientId,
      periodStart: job.periodStart,
      periodEnd: job.periodEnd,
      status: 'running',
      correlationId: job.correlationId,
    }),
  );

  try {
    const agg = await aggregate(job.orgId, job.clientId, job.sources);
    const html = renderReportHtml({
      clientName: job.clientName,
      periodLabel: periodLabel(job.periodStart, job.periodEnd),
      rows: Object.entries(agg.data).map(([k, v]) => [k, String(v)] as const),
    });
    // Normalize the PDF's embedded dates to the period end, so the same data always yields the
    // same bytes regardless of when it rendered.
    const pdf = normalizePdfDates(await deps.pool.render(html), job.periodEnd);

    let r2ObjectKey: string | null = null;
    if (deps.objectStore !== undefined) {
      r2ObjectKey = reportObjectKey(job, reportRunId);
      await deps.objectStore.put(r2ObjectKey, Readable.from(pdf), {
        contentType: 'application/pdf',
        contentLength: pdf.length,
      });
    }

    await withOrg(job.orgId, (tx) =>
      completeReportRun(tx, {
        id: reportRunId,
        status: agg.status,
        errorDetail: agg.failures.length > 0 ? { failures: agg.failures } : null,
        r2ObjectKey,
      }),
    );
    deps.metrics.counter('report_completed_total', 1, { status: agg.status });
    return { reportRunId, status: agg.status, pdf, r2ObjectKey };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The row already exists; finalise it as failed rather than leaving it stuck at `running`.
    await withOrg(job.orgId, (tx) =>
      completeReportRun(tx, {
        id: reportRunId,
        status: 'failed',
        errorDetail: { message },
        r2ObjectKey: null,
      }),
    );
    deps.metrics.counter('report_failed_total', 1);
    deps.alerts.fire('report_run_failed', { severity: 'warning', reportRunId, message });
    deps.logger.error({ reportRunId, err: message }, 'report run failed');
    return { reportRunId, status: 'failed', pdf: null, r2ObjectKey: null };
  }
}
