// FIXTURE — this file is expected to PASS typecheck.
//
// The counterpart to added-mode.ts. Without it, AC5 would pass even if tsc were failing
// for some unrelated reason (a bad tsconfig, a missing lib), which would make the
// "exhaustiveness is enforced" claim worthless.

type PollAdapter = { readonly mode: 'poll'; readonly vendor: string };
type WebhookAdapter = { readonly mode: 'webhook'; readonly vendor: string };
type StreamAdapter = { readonly mode: 'stream'; readonly vendor: string };

type AlarmAdapter = PollAdapter | WebhookAdapter | StreamAdapter;

export function dispatch(adapter: AlarmAdapter): string {
  switch (adapter.mode) {
    case 'poll':
      return 'poll';
    case 'webhook':
      return 'webhook';
    case 'stream':
      return 'stream';
    default: {
      const exhaustive: never = adapter;
      throw new Error(`Unhandled ingestion mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}
