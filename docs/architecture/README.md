# Sonalit Guard Operations Platform — Pre-Build Document Set

Deliverables produced before any implementation code, per the build brief's §7/§8 gate.

| Doc | Contents |
|---|---|
| [`01-ARCHITECTURE.md`](./01-ARCHITECTURE.md) | Repository context finding, divergences from the brief, C4 Context + Container diagrams, alarm-ingestion data flow, technology decisions, refined TypeScript contracts, multi-tenancy/RLS design, resiliency, auth & authz, biometric architecture, data model & indexing rationale, open items |
| [`02-REPOSITORY-STRUCTURE.md`](./02-REPOSITORY-STRUCTURE.md) | pnpm workspace layout, package responsibilities, dependency graph, CI/CD, standards enforcement |
| [`03-PHASED-BUILD-PLAN.md`](./03-PHASED-BUILD-PLAN.md) | 12 phases + a parallel compliance track, with inter-phase dependencies and runnable acceptance criteria per phase |

## Read these first

Five findings change the work relative to the brief as written:

1. **This repository is not the Sonalit codebase.** It holds an unrelated vehicle-fleet-management
   prototype. Several brief instructions reference existing Sonalit infrastructure (Centrifugo,
   `withOrg()`, provisioned R2) that does not exist here. → `01` §0, Open Item 0.
2. **The brief's Cockatiel snippet does not compile.** It is Polly (.NET) fluent syntax; Cockatiel
   uses standalone policy functions. Corrected version in `01` §8.1. → Divergence D1.
3. **Kenya DPA compliance is a ≥60-day statutory lead time, not a checkbox.** DPIAs must be filed
   with the Data Commissioner at least 60 days before processing begins, and biometric data is
   expressly sensitive personal data. The compliance track therefore starts in parallel with
   Phase 1, not when biometrics start. → `01` §10.1, `03` Track C.
4. **Drizzle Kit cannot satisfy the brief's own migration requirement** — it generates no `down`
   migrations. node-pg-migrate chosen. → Divergence D2.
5. **Webhook signature verification needs raw bytes**, which the draft adapter interface made
   impossible. → Divergence D3/D4, `01` §6.3.

## Status

Three pre-build documents complete. **Phase 1 implementation is gated on `/continue`** and on a
decision on Open Item 0 (repository placement).
