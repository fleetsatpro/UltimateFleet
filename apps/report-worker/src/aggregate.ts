import { withOrgClient, type TenantTransaction } from '@deepsight/db';

/**
 * Per-client report aggregation.
 *
 * Two properties are deliberate. First, it runs under `withOrgClient` — so every source query is
 * scoped by RLS to exactly one org AND one client, and a report for client A1 physically cannot
 * read client A2's or another org's rows (acceptance criterion 6), independent of any application
 * filter. Second, sources are gathered with `Promise.allSettled`, never `Promise.all`: one vendor
 * source failing must NOT sink the whole report. A failed source becomes a recorded gap and the
 * report is marked `partial`; the other clients in the same run are entirely unaffected (AC2).
 */
export interface ReportSource {
  readonly name: string;
  fetch(tx: TenantTransaction): Promise<unknown>;
}

export interface SourceFailure {
  readonly source: string;
  readonly error: string;
}

export interface Aggregation {
  readonly status: 'complete' | 'partial';
  readonly data: Record<string, unknown>;
  readonly failures: readonly SourceFailure[];
}

export async function aggregate(
  orgId: string,
  clientId: string,
  sources: readonly ReportSource[],
): Promise<Aggregation> {
  return withOrgClient(orgId, clientId, async (tx) => {
    const results = await Promise.allSettled(sources.map((s) => s.fetch(tx)));
    const data: Record<string, unknown> = {};
    const failures: SourceFailure[] = [];
    results.forEach((result, i) => {
      const source = sources[i]!;
      if (result.status === 'fulfilled') {
        data[source.name] = result.value;
      } else {
        failures.push({
          source: source.name,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
    return { status: failures.length === 0 ? 'complete' : 'partial', data, failures };
  });
}

/**
 * The default report sources: counts of the client's events in the period. Each is a small,
 * independent query, so one failing (a lock timeout, a bad migration) degrades the report to
 * `partial` rather than failing it outright.
 */
export function defaultReportSources(periodStart: Date, periodEnd: Date): ReportSource[] {
  const countBetween =
    (table: string) =>
    async (tx: TenantTransaction): Promise<number> => {
      const r = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table}
        WHERE occurred_at >= $1 AND occurred_at < $2`,
        [periodStart, periodEnd],
      );
      return Number(r.rows[0]?.n ?? '0');
    };
  return [
    { name: 'alarm_events', fetch: countBetween('alarm_events') },
    { name: 'patrol_scans', fetch: countBetween('patrol_scans') },
    { name: 'attendance', fetch: countBetween('shift_attendance') },
  ];
}
