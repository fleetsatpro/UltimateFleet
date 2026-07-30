import type {
  AdapterHealth,
  AttendanceSource,
  NormalizedAlarmEvent,
  NormalizedAttendanceRecord,
  PollCursor,
  PollingAlarmAdapter,
} from '@deepsight/contracts';
import { unverified } from '../unverified.js';

/**
 * GuardTek — SOAP, poll-based, and also a source of attendance records.
 *
 * Every operation that would touch the real GuardTek endpoint throws
 * UNVERIFIED_VENDOR_CONTRACT, because the WSDL, endpoint URL, and authentication scheme
 * are unconfirmed (open item 1). The class is fully typed and implements the real
 * interfaces, so the ingestion core, registry, dispatch, and health surface are all
 * exercised against it — only the vendor-facing bodies are withheld, and they are
 * withheld loudly rather than faked.
 *
 * What must be confirmed before the bodies can be written is enumerated per method below
 * and in VENDOR_TODO.md.
 */
export class GuardTekAdapter implements PollingAlarmAdapter, AttendanceSource {
  public readonly vendor = 'guardtek' as const;
  public readonly mode = 'poll' as const;

  healthCheck(): Promise<AdapterHealth> {
    // Honest, not invented: the adapter is genuinely not connected to anything, and
    // saying so lets /health show it as offline pending contract confirmation rather
    // than pretending a connection exists.
    return Promise.resolve({
      vendor: this.vendor,
      status: 'offline',
      breaker_state: 'closed',
      error: 'UNVERIFIED_VENDOR_CONTRACT: GuardTek WSDL/endpoint/auth not confirmed',
    });
  }

  // The generator shape is required by the PollingAlarmAdapter interface, but the body is
  // withheld until the WSDL is confirmed and so throws before any yield.
  // eslint-disable-next-line require-yield
  async *poll(
    _cursor: PollCursor,
    _signal: AbortSignal,
  ): AsyncGenerator<NormalizedAlarmEvent, PollCursor, void> {
    unverified(
      'guardtek',
      'poll',
      'confirm the SOAP WSDL, the alarm-list operation name, its request/response ' +
        'schema, the auth scheme (WS-Security? API key?), and how the poll cursor maps ' +
        'to a GuardTek request parameter (timestamp? sequence id?)',
    );
  }

  fetchAttendance(
    _siteId: string,
    _from: Date,
    _to: Date,
    _signal: AbortSignal,
  ): Promise<readonly NormalizedAttendanceRecord[]> {
    return Promise.resolve(
      unverified(
        'guardtek',
        'fetchAttendance',
        'confirm the attendance SOAP operation, its date-range parameters, the record ' +
          'schema, and how a GuardTek guard identifier maps to an internal guard_id',
      ),
    );
  }
}
