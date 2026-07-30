# Vendor contract TODO

Every adapter here is built contract-first: typed against the real `AlarmAdapter` /
`AttendanceSource` interfaces, with each vendor-facing operation throwing
`UNVERIFIED_VENDOR_CONTRACT: <what needs confirming>` until the contract is confirmed. No
endpoint behaviour is invented, no response shape is mocked as real, and no `any` is used to
paper over an unknown schema.

The reason this matters more than tidiness: a plausible-looking mock is indistinguishable
from a working integration until the day it meets the real vendor — and for a signature
check, a wrong-but-plausible implementation is worse than none, because it looks like
security while accepting forged events.

These are open items 1–3 in `docs/architecture/01-ARCHITECTURE.md §12`. Each phase that
depends on a vendor body is blocked only on the item below, not on the surrounding structure
(registry, dispatch, health, the pipeline) which is complete and tested against fake
adapters.

## GuardTek (SOAP, poll) — open item 1

Blocks: `GuardTekAdapter.poll`, `GuardTekAdapter.fetchAttendance`.

- [ ] Live WSDL URL and the SOAP endpoint.
- [ ] Authentication scheme (WS-Security username/password token? an API key header?).
- [ ] The alarm-list operation: name, request parameters, response schema.
- [ ] How the poll cursor maps to a request parameter — a timestamp watermark, or a
      sequence id? This determines whether overlapping polls can double-deliver (dedupe
      covers it either way, but a sequence id is cheaper).
- [ ] The attendance operation: name, date-range parameters, record schema.
- [ ] How a GuardTek guard identifier maps to an internal `guard_id` (or whether records
      arrive unmatched and are resolved later — the schema already allows `guard_id` null).

## Dahua DSS (webhook push) — open item 2

Blocks: `DahuaAdapter.verifySignature`, `DahuaAdapter.handleWebhook`.

- [ ] The signature scheme: which header carries the signature; the HMAC algorithm and
      encoding (hex? base64?); shared secret vs. token.
- [ ] Whether a timestamp or nonce is part of the signed material (replay protection). If
      so, the signed string is `f(timestamp, body)`, not just the body.
- [ ] The event payload schema, and whether one delivery maps to one event or many.
- [ ] Which numeric field is the vendor event code.
      NOTE: the numeric-code → normalized-type mapping is already externalised to the
      `alarm_event_type_mappings` table and hot-reloadable, so only the payload _shape_ is
      needed here — not the code meanings.

Already settled: verification runs on the raw request bytes before any parse (divergence
D4), and the engine's webhook route is mounted with `express.raw()`. When the scheme is
confirmed, only the body of `verifySignature` changes.

## AxxonSoft (long-poll/stream) — open item 3

Blocks: `AxxonAdapter.start`, `AxxonAdapter.stop` (transport teardown).

- [ ] The stream/long-poll endpoint URL and auth scheme.
- [ ] The frame format: chunked JSON, SSE, or proprietary framing.
- [ ] The keep-alive/heartbeat contract, so reconnect-with-jitter can tell an idle stream
      from a disconnected one.
- [ ] The event payload schema.

Already built and safe without the contract: `onAlarm`/local subscription bookkeeping and
listener teardown (returns an `Unsubscribe`, so reconnects in the dedicated Phase 4 worker
cannot leak listeners).
