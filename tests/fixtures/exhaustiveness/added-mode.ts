// FIXTURE — this file is expected to FAIL typecheck. Phase 2 acceptance test AC5 asserts
// that, by running tsc against it and requiring a specific error.
//
// It reproduces the dispatcher's exhaustive switch over a locally-declared union that has
// a FOURTH ingestion mode the switch does not handle. The `const exhaustive: never` line
// must fail to compile.
//
// This is the whole point of divergence D3. With the brief's original all-optional-methods
// AlarmAdapter, adding a vendor with a new ingestion style type-checks fine and then
// SILENTLY INGESTS NOTHING at runtime — indistinguishable from "no alarms occurred", which
// for an alarm system is the worst failure mode available.

type PollAdapter = { readonly mode: 'poll'; readonly vendor: string };
type WebhookAdapter = { readonly mode: 'webhook'; readonly vendor: string };
type StreamAdapter = { readonly mode: 'stream'; readonly vendor: string };
// The new mode a future vendor brings — say a vendor that drops files on SFTP.
type BatchFileAdapter = { readonly mode: 'batch_file'; readonly vendor: string };

type ExtendedAlarmAdapter = PollAdapter | WebhookAdapter | StreamAdapter | BatchFileAdapter;

export function dispatch(adapter: ExtendedAlarmAdapter): string {
  switch (adapter.mode) {
    case 'poll':
      return 'poll';
    case 'webhook':
      return 'webhook';
    case 'stream':
      return 'stream';
    default: {
      // EXPECTED ERROR TS2322: Type 'BatchFileAdapter' is not assignable to type 'never'.
      const exhaustive: never = adapter;
      throw new Error(`Unhandled ingestion mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}
