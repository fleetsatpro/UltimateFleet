# DeepSight — Pre-Build Document Set

Guard operations platform. Deliverables produced before any implementation code, per the build
brief's §7/§8 gate.

| Doc | Contents |
|---|---|
| [`01-ARCHITECTURE.md`](./01-ARCHITECTURE.md) | Build context, divergences from the brief, C4 Context + Container diagrams, alarm-ingestion data flow, technology decisions, refined TypeScript contracts, multi-tenancy/RLS design, resiliency, auth & authz, biometric architecture, data model & indexing rationale, open items |
| [`02-REPOSITORY-STRUCTURE.md`](./02-REPOSITORY-STRUCTURE.md) | pnpm workspace layout, package responsibilities, dependency graph, CI/CD, standards enforcement |
| [`03-PHASED-BUILD-PLAN.md`](./03-PHASED-BUILD-PLAN.md) | 12 phases + a parallel compliance track, with inter-phase dependencies and runnable acceptance criteria per phase |

## Read these first

Six findings change the work relative to the brief as written. The first is the one that is expensive
to reverse.

1. **Tenancy has two levels, not one.** The brief's schema makes `client_id` the RLS key, which fits
   one guarding company's internal system. DeepSight is a product, so the design uses
   `organizations → clients → sites` with `org_id` as the isolation key — a single-operator
   deployment is just the degenerate case. Retrofitting a tenancy level onto live multi-tenant RLS
   holding biometric data is brutal; removing one now is a document edit. It also determines who the
   data controller is, and therefore the entire shape of the compliance work.
   → `01` §1 (D6). **Confirm or reject before Phase 1.**
2. **The brief's Cockatiel snippet does not compile.** It is Polly (.NET) fluent syntax; Cockatiel
   uses standalone policy functions. Corrected in `01` §8.1. Decorrelated jitter is already the
   default backoff generator, so the brief's jitter call was redundant as well as invalid. → D1.
3. **Data-protection compliance is a ≥60-day statutory lead time, not a checkbox.** DPIAs must be
   filed with the supervisory authority at least 60 days before processing begins, and biometric data
   is expressly sensitive personal data. The compliance track therefore starts in parallel with
   Phase 1, not when biometrics start. → `01` §10.1, `03` Track C.
4. **Drizzle Kit cannot satisfy the brief's own migration requirement** — it generates no `down`
   migrations. node-pg-migrate chosen instead. → D2.
5. **Webhook signature verification needs raw bytes**, which the draft adapter interface made
   impossible by passing parsed JSON. → D4, `01` §6.3.
6. **Greenfield resolves two open items.** No prior codebase exists, so there is no shared Centrifugo
   instance to reuse (Socket.io chosen outright, not contingently) and R2 is a provisioning task
   rather than a pre-existing asset. → `01` §0.
7. **Two RLS errors in an earlier draft of this document set, found by building it.** Declaring both
   policies `AS RESTRICTIVE` returns *zero* rows rather than isolating (PostgreSQL needs ≥1
   permissive policy); and a transaction-local GUC reverts to the *empty string*, not NULL, so a raw
   `''::uuid` cast in a policy raises on any recycled pooled connection. Both corrected, both now
   regression-tested. → `01` §7.1.

## Status

Three pre-build documents complete. **Phases 1–3 are implemented and their full acceptance suites
pass** (97 tests: 34 unit, 63 integration against real PostgreSQL and Redis). Everything in `01` and
`02` describing those phases reflects the code as built, including the corrections above.

Phase 3 note: the three vendor adapters are built contract-first — typed against the real interfaces,
with every vendor-facing operation throwing `UNVERIFIED_VENDOR_CONTRACT` until the WSDL / signature
scheme / stream endpoint is confirmed (open items 1–3, tracked in
`packages/vendor-adapters/VENDOR_TODO.md`). The registry, resilience policy (corrected Cockatiel —
`maxAttempts` counts retries, so the API exposes `totalAttempts`), webhook route (`express.raw`,
divergence D4), and per-vendor `/health` are complete and tested.

**Phase 4 is gated on `/continue`.** One decision remains outstanding: **D6** (tenancy depth).
Phases 1–3 were built to D6(b), multi-operator, which degenerates cleanly to single-operator — see
`01` §1. It gets more expensive to reverse with each phase that builds on the schema.
