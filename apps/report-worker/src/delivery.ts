import { insertDeliveryAttempt, withOrg, type DeliveryStatus } from '@deepsight/db';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';

/**
 * Report delivery: email the archived PDF to each recipient and log EVERY attempt.
 *
 * The email transport is a port, so tests drive bounces and transient failures deterministically
 * and production binds a real provider. Three rules hold:
 *   - Every attempt writes a row (append-only) — a retry adds a row, never rewrites the first.
 *   - `sent` and `bounced` are terminal; a transient `failed` is retried with backoff, and each
 *     retry is its own row, so the attempt history is complete.
 *   - Delivery status is independent of `report_runs.status`: a failed send never rewrites a
 *     successful compilation (acceptance criterion 1).
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly r2ArchiveKey: string;
}

export interface SendResult {
  readonly status: DeliveryStatus;
  readonly error?: string | undefined;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<SendResult>;
}

export interface DeliveryDeps {
  readonly transport: EmailTransport;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
  /** Max attempts per recipient before giving up on a transient failure. Default 3. */
  readonly maxAttempts?: number | undefined;
  /** Injectable backoff sleep, so tests do not wait. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DeliverReportParams {
  readonly orgId: string;
  readonly clientId: string;
  readonly reportRunId: string;
  readonly r2ArchiveKey: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly correlationId: string;
}

export interface DeliverySummary {
  readonly sent: number;
  readonly bounced: number;
  readonly failed: number;
}

export async function deliverReport(
  deps: DeliveryDeps,
  params: DeliverReportParams,
): Promise<DeliverySummary> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const summary = { sent: 0, bounced: 0, failed: 0 };

  for (const recipient of params.recipients) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const result = await deps.transport.send({
        to: recipient,
        subject: params.subject,
        r2ArchiveKey: params.r2ArchiveKey,
      });

      await withOrg(params.orgId, (tx) =>
        insertDeliveryAttempt(tx, {
          orgId: params.orgId,
          clientId: params.clientId,
          reportRunId: params.reportRunId,
          recipientEmail: recipient,
          status: result.status,
          deliveredAt: result.status === 'sent' ? new Date() : null,
          errorDetail: result.error !== undefined ? { message: result.error } : null,
          r2ArchiveKey: params.r2ArchiveKey,
          correlationId: params.correlationId,
        }),
      );
      deps.metrics.counter('report_delivery_total', 1, { status: result.status });

      // `sent` and `bounced` are terminal outcomes; only a transient `failed` is retried.
      if (result.status === 'sent') {
        summary.sent += 1;
        break;
      }
      if (result.status === 'bounced') {
        summary.bounced += 1;
        break;
      }
      if (attempt >= maxAttempts) {
        summary.failed += 1;
        deps.alerts.fire('report_delivery_failed', {
          severity: 'warning',
          reportRunId: params.reportRunId,
          recipient,
        });
        break;
      }
      // Transient failure with attempts left: back off, then retry (a new log row).
      await sleep(Math.min(2 ** attempt * 1000, 30_000));
    }
  }

  deps.logger.info({ reportRunId: params.reportRunId, ...summary }, 'report delivery complete');
  return summary;
}
