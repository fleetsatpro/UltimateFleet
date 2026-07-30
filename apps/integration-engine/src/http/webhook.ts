import type { VendorId, WebhookAlarmAdapter } from '@deepsight/contracts';
import type { Alerts, Logger, Metrics } from '@deepsight/observability';
import { UnverifiedVendorContractError } from '@deepsight/vendor-adapters';
import { handleWebhookDelivery } from '../ingestion/dispatcher.js';
import type { DispatchDeps } from '../ingestion/dispatcher.js';

/**
 * Resolves an inbound webhook to a vendor adapter and drives it through the pipeline.
 *
 * The route that calls this MUST be mounted with express.raw() (see app.ts). Under
 * express.json() the raw bytes are consumed and discarded, and an HMAC computed over the
 * exact received bytes becomes impossible — divergence D4, and the single most damaging
 * one-line mistake available here, because it silently disables signature verification.
 */

export interface WebhookResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface WebhookHandler {
  handle(
    vendor: string,
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<WebhookResult>;
}

const KNOWN_VENDORS = new Set<VendorId>(['guardtek', 'dahua', 'axxon']);

function isVendorId(value: string): value is VendorId {
  return KNOWN_VENDORS.has(value as VendorId);
}

export interface WebhookHandlerDeps {
  /** Webhook-mode adapters keyed by vendor. Only 'dahua' is push-based today. */
  readonly adapters: ReadonlyMap<VendorId, WebhookAlarmAdapter>;
  readonly dispatch: DispatchDeps;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
}

export function createWebhookHandler(deps: WebhookHandlerDeps): WebhookHandler {
  return {
    async handle(vendor, rawBody, headers) {
      if (!isVendorId(vendor)) {
        return { status: 404, body: { error: `unknown vendor "${vendor}"` } };
      }

      const adapter = deps.adapters.get(vendor);
      if (adapter === undefined) {
        // A known vendor that is not push-based (GuardTek polls, Axxon streams) has no
        // webhook route — 405, not 404, because the vendor exists.
        return { status: 405, body: { error: `vendor "${vendor}" is not webhook-based` } };
      }

      deps.metrics.counter('webhook_received_total', 1, { vendor });

      try {
        const result = await handleWebhookDelivery(adapter, rawBody, headers, deps.dispatch);
        if (!result.accepted) {
          // Signature rejected. 401, and — crucially — handleWebhook was never reached, so
          // no forged payload was parsed.
          return { status: 401, body: { error: 'signature rejected', reason: result.reason } };
        }
        return {
          status: 202,
          body: {
            accepted: true,
            persisted: result.outcome?.persisted ?? 0,
            duplicates: result.outcome?.duplicates ?? 0,
            rejected: result.outcome?.rejected ?? 0,
          },
        };
      } catch (error) {
        if (error instanceof UnverifiedVendorContractError) {
          // The adapter exists but its contract is unconfirmed (Dahua signature scheme,
          // open item 2). 501 Not Implemented is the honest status: the endpoint is wired,
          // the vendor detail is not. It must never be mistaken for a working acceptance.
          deps.logger.warn(
            { vendor, operation: error.operation },
            'webhook rejected: vendor contract unverified',
          );
          deps.metrics.counter('webhook_unverified_total', 1, { vendor });
          return { status: 501, body: { error: error.message } };
        }
        deps.logger.error(
          { vendor, err: error instanceof Error ? error.message : error },
          'webhook handling failed',
        );
        deps.alerts.fire('webhook_handler_error', {
          severity: 'warning',
          vendor,
          error: error instanceof Error ? error.message : String(error),
        });
        return { status: 500, body: { error: 'webhook handling failed' } };
      }
    },
  };
}
