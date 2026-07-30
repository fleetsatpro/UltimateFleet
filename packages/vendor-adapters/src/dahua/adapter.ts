import type {
  AdapterHealth,
  NormalizedAlarmEvent,
  SignatureVerdict,
  WebhookAlarmAdapter,
} from '@deepsight/contracts';
import { unverified } from '../unverified.js';

/**
 * Dahua DSS — webhook push.
 *
 * verifySignature and handleWebhook both throw UNVERIFIED_VENDOR_CONTRACT: the DSS
 * signature/token scheme is unconfirmed (open item 2). This is the highest-stakes place
 * to withhold rather than guess — a plausible-but-wrong signature check is worse than
 * none, because it looks like security while accepting forged events.
 *
 * The one thing settled and encoded in the interface (divergence D4) is that verification
 * takes the RAW BYTES, not parsed JSON: HMAC is computed over exact received bytes, and
 * the engine's webhook route is mounted with express.raw() so those bytes survive. When
 * the scheme is confirmed, the body of verifySignature is the only thing that changes; the
 * route and the raw-body plumbing are already correct and tested (with the fake adapter).
 */
export class DahuaAdapter implements WebhookAlarmAdapter {
  public readonly vendor = 'dahua' as const;
  public readonly mode = 'webhook' as const;

  healthCheck(): Promise<AdapterHealth> {
    return Promise.resolve({
      vendor: this.vendor,
      status: 'offline',
      breaker_state: 'closed',
      error: 'UNVERIFIED_VENDOR_CONTRACT: Dahua DSS webhook signature scheme not confirmed',
    });
  }

  verifySignature(
    _rawBody: Uint8Array,
    _headers: Readonly<Record<string, string>>,
  ): SignatureVerdict {
    unverified(
      'dahua',
      'verifySignature',
      'confirm the DSS signature scheme: which header carries the signature, the HMAC ' +
        'algorithm and encoding, whether a shared secret or a token is used, and whether ' +
        'a timestamp/nonce is part of the signed material (replay protection)',
    );
  }

  handleWebhook(
    _rawBody: Uint8Array,
    _headers: Readonly<Record<string, string>>,
  ): Promise<readonly NormalizedAlarmEvent[]> {
    return Promise.resolve(
      unverified(
        'dahua',
        'handleWebhook',
        'confirm the DSS event payload schema, how one delivery maps to one or many ' +
          'events, and which numeric field is the vendor event code (mapped via ' +
          'alarm_event_type_mappings) — note: the numeric-code -> normalized-type mapping ' +
          'is already externalised to the DB, so only the payload shape is needed here',
      ),
    );
  }
}
