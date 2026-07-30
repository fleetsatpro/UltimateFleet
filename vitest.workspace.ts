import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/test/unit/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['packages/*/test/integration/**/*.test.ts', 'apps/*/test/integration/**/*.test.ts'],
      environment: 'node',
      // Migrations and seeds are applied once, then every file shares one database.
      // Parallel files would interleave DDL with isolation assertions, so the suite is
      // deliberately serial — correctness of the RLS assertions over wall-clock time.
      globalSetup: ['./packages/db/test/global-setup.mjs'],
      fileParallelism: false,
      sequence: { concurrent: false },
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  },
]);
