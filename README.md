# DeepSight

Guard operations platform. Guards authenticate on a provisioned Android device with a biometric
liveness gate, a 1:1 face identity match and a GPS geofence check; patrols and alarms are captured
digitally in real time across heterogeneous vendor systems; and client reports compile and deliver
automatically on schedule — with no manual data entry and a permanent audit trail.

## Status

**Pre-build.** No implementation code yet. The architecture, repository structure and phased build
plan are complete and awaiting review.

→ **[`docs/architecture/`](./docs/architecture/)** — start with the
[document index](./docs/architecture/README.md).

Phase 1 is gated on one open decision (**D6**, tenancy depth — see
[`01-ARCHITECTURE.md`](./docs/architecture/01-ARCHITECTURE.md) §1).

## Planned stack

Node 22 · TypeScript strict · PostgreSQL 16 with row-level security · Redis + BullMQ ·
React Native (Android) with WatermelonDB · React 18 + Vite · Cloudflare R2 · pnpm workspaces ·
Railway (backend) + Vercel (dashboard)

## Repository history

This repository previously contained an unrelated vehicle-fleet-management prototype, removed in
full when DeepSight was established here. Those files remain retrievable from git history.
