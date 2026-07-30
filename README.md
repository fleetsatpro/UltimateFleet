# DeepSight

Guard operations platform. Guards authenticate on a provisioned Android device with a biometric
liveness gate, a 1:1 face identity match and a GPS geofence check; patrols and alarms are captured
digitally in real time across heterogeneous vendor systems; and client reports compile and deliver
automatically on schedule — with no manual data entry and a permanent audit trail.

## Status

**Phases 1-7 complete; Phases 8, 10, 11 backend delivered; Phase 9 deliberately blocked
(biometric compliance gate).** 179 tests passing across unit and integration suites (the latter
against real PostgreSQL, Redis and Chromium).

- **Phase 1** — foundation and tenant-isolated data layer: schema, two-level row-level security,
  three database roles, seeds, schema guards.
- **Phase 2** — ingestion core and observability spine: the integration engine, an ingestion
  pipeline whose fan-out is gated on actual insertion, a hot-reloadable vendor-code mapping table,
  signed BullMQ job envelopes, and correlation IDs threaded end to end.
- **Phase 3** — vendor adapter layer, contract-first: GuardTek (poll), Dahua (webhook), Axxon
  (stream) typed against the real interfaces with unverified operations throwing
  `UNVERIFIED_VENDOR_CONTRACT`; a corrected Cockatiel resilience policy with a circuit breaker per
  vendor; a raw-bytes webhook route; and per-vendor health on `/health`.
- **Phase 4** — the isolated AxxonSoft worker: a separate Railway service that holds no database
  credential (and no dependency on `@deepsight/db` at all), streams alarms, reconnects with
  decorrelated jitter from the first failure, and publishes signed jobs to the engine over BullMQ.
  This phase surfaced divergence D7 — the ingestion schema must coerce dates because BullMQ delivers
  them as JSON strings — caught by a full worker→Redis→engine test.
- **Phase 5** — the media pipeline: an `ObjectStore` port with a Cloudflare R2 binding (streaming
  multipart upload, signed URLs) and a local HTTP binding for tests; a `media.fetch` worker that
  streams expiring vendor URLs straight into storage with a flat memory profile, records the outcome
  on `incident_media` (the key, never the bytes), and orders fetches by expiry. R2 is unprovisioned
  (Open Item 10), so the engine runs media-disabled until the `R2_*` vars are set.
- **Phase 6** — the realtime transport: a Socket.io hub with the Redis adapter (rooms span engine
  instances), connect-time authentication via a minimal HMAC dashboard session, per-org room
  isolation, revocation enforced by a heartbeat sweep, a socket fan-out replacing the Phase 2 log
  sink, and a vendor-health broadcaster. Boot-optional (headless without `DASHBOARD_SESSION_SECRET`);
  the browser dashboard UI is on the frontend track.
- **Phase 7** — auth, RBAC and device provisioning: `@deepsight/auth` (Argon2id, hashed opaque
  tokens, Redis sessions, guard + service JWTs, roles); dashboard login/logout with server-side
  session revocation; RBAC-per-route from a table; supervisor-issued single-use enrollment tokens;
  guard enroll/refresh with rotating refresh-token families and replay detection. Cross-org login
  uses a `BYPASSRLS` `deepsight_auth` role owning one SECURITY DEFINER lookup; a repo-wide secret
  scan (`pnpm scan:secrets`) guards against hardcoded tokens.
- **Phase 8 (sync endpoint)** — the guard mobile sync surface: guard-JWT-authenticated idempotent
  push of offline attendance/patrol/closure events into the append-only tables (`(device_id,
client_event_id)` dedupe), with server-authoritative haversine geofencing. The React Native app +
  WatermelonDB is the frontend track.
- **Phase 9** — biometric verification — **deliberately not built.** It is hard-gated on a DPIA and
  any required registration being confirmed (or deferred in writing); shipping face-matching before
  that would breach the gate and, in several jurisdictions, the law. Only Griff can clear it.
- **Phase 10** — the report engine (`apps/report-worker`): a bounded Playwright browser pool
  (synchronous slot reservation, `newContext()` per render, recycle after N or an RSS ceiling),
  per-client aggregation under `withOrgClient` with `Promise.allSettled` isolation, a deterministic
  HTML→PDF pipeline with normalized date metadata (byte-identical output), and a `report_runs` row on
  every outcome. Built ahead of Phase 9 since it depends only on Phases 1 and 5.
- **Phase 11** — the delivery layer: `deliverReport` emails the archived PDF and writes
  `report_delivery_log` per attempt (append-only), with `sent`/`bounced` terminal and transient
  `failed` retried with backoff. Delivery status is independent of compilation status, and the
  ingestion correlation id threads through to the delivery row. The email provider is behind an
  `EmailTransport` port (Open Item 13).

→ **[`docs/architecture/`](./docs/architecture/)** — architecture, repository structure, and the
12-phase build plan. Start with the [document index](./docs/architecture/README.md).

## Getting started

Requires Node 22, pnpm, a PostgreSQL 16 you can connect to as a superuser, and a Redis 7.

```bash
pnpm install
cp .env.example .env          # then edit if your PostgreSQL differs
set -a && . ./.env && set +a  # export the three connection URLs

createdb deepsight            # or: psql -c 'create database deepsight'
pnpm db:bootstrap             # creates the three roles (needs superuser)
pnpm db:migrate
pnpm db:seed

pnpm verify                   # typecheck + lint + boundary check + full test suite
```

Three connection URLs, three roles, deliberately. `DATABASE_URL_OWNER` runs migrations and seeds;
`DATABASE_URL` (the restricted `deepsight_app` role) is what every application query path and every
integration test uses. In a deployed environment the owner credential is set only on the migration
pre-deploy step, so it is not present in any runtime process — see
[`02-REPOSITORY-STRUCTURE.md`](./docs/architecture/02-REPOSITORY-STRUCTURE.md) §4.

### Useful commands

| Command                 | What it does                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm verify`           | Everything CI runs, apart from the database steps                                                   |
| `pnpm test:integration` | Acceptance suite against real PostgreSQL, as `deepsight_app`                                        |
| `pnpm db:lint`          | Schema guards: tenancy (org_id + RLS + FORCE + a permissive policy) and the binary-column allowlist |
| `pnpm migrate:down:up`  | Proves every `down()` migration genuinely reverses its `up()`                                       |
| `pnpm check:boundaries` | Enforces the `apps/` vs `packages/` invariants                                                      |

## Layout

```
packages/
├── contracts/       shared types + zod schemas (imported by React Native — no Node built-ins)
├── db/              migrations, RLS policies, withOrg()/withOrgClient(), seeds, schema guards
├── config-env/      zod env validation, fails hard naming the missing variable
├── observability/   pino JSON logging, AsyncLocalStorage correlation context, metrics
├── queue/           BullMQ factories with signature verification inside the worker factory
├── resilience/      per-vendor Cockatiel policy (retry/breaker/timeout/bulkhead) + breaker sweep
├── vendor-adapters/ GuardTek / Dahua / Axxon, contract-first (unverified ops throw)
├── storage-r2/      ObjectStore port + Cloudflare R2 binding (streaming upload, signed URLs)
├── auth/            Argon2id, hashed tokens, Redis sessions, guard + service JWTs, RBAC roles
├── test-support/    integration harness, fake adapters, local ObjectStore, assertion helpers
└── eslint-config/   shared lint config incl. the Promise.all ban and no-silent-catch rule

apps/
├── integration-engine/  ingestion, media, realtime hub, auth + guard-sync HTTP surface, consumers
├── axxon-worker/        isolated stream worker: reconnecting consumer, signed publish, no DB
└── report-worker/       pooled Chromium PDF rendering, per-client aggregation, report_runs
```

Frontend track (not in this backend repo): the ops dashboard UI (Phase 6) and the guard mobile app
(Phase 8). Phase 9 (biometrics) is gated on compliance sign-off; Phase 11 (delivery) is next.

Vendor contract status is tracked in [`packages/vendor-adapters/VENDOR_TODO.md`](./packages/vendor-adapters/VENDOR_TODO.md).

## Stack

Node 22 · TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) ·
PostgreSQL 16 with row-level security · Redis + BullMQ · React Native (Android) with WatermelonDB ·
React 18 + Vite · Cloudflare R2 · pnpm workspaces · Railway (backend) + Vercel (dashboard)

## Repository history

This repository previously contained an unrelated vehicle-fleet-management prototype, removed in
full when DeepSight was established here. Those files remain retrievable from git history.
