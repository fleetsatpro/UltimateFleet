# DeepSight

Guard operations platform. Guards authenticate on a provisioned Android device with a biometric
liveness gate, a 1:1 face identity match and a GPS geofence check; patrols and alarms are captured
digitally in real time across heterogeneous vendor systems; and client reports compile and deliver
automatically on schedule — with no manual data entry and a permanent audit trail.

## Status

**Phase 1 complete: foundation and tenant-isolated data layer.** 35 tests passing (10 unit, 25
integration against real PostgreSQL). Phase 2 (ingestion core) not started.

→ **[`docs/architecture/`](./docs/architecture/)** — architecture, repository structure, and the
12-phase build plan. Start with the [document index](./docs/architecture/README.md).

## Getting started

Requires Node 22, pnpm, and a PostgreSQL 16 you can connect to as a superuser.

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
├── test-support/    integration harness and cross-tenant assertion helpers
└── eslint-config/   shared lint config incl. the Promise.all ban and no-silent-catch rule
```

`apps/` arrives with Phase 2 (integration engine, AxxonSoft worker, report worker, ops dashboard,
guard mobile).

## Stack

Node 22 · TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) ·
PostgreSQL 16 with row-level security · Redis + BullMQ · React Native (Android) with WatermelonDB ·
React 18 + Vite · Cloudflare R2 · pnpm workspaces · Railway (backend) + Vercel (dashboard)

## Repository history

This repository previously contained an unrelated vehicle-fleet-management prototype, removed in
full when DeepSight was established here. Those files remain retrievable from git history.
