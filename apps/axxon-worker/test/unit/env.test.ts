import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAxxonEnv } from '../../src/env.js';

/**
 * Phase 4 acceptance criterion 3: the worker is isolated from the database.
 *
 * Two independent proofs. First, the env schema REJECTS DATABASE_URL (and the owner/admin
 * URLs) — a misconfiguration that handed this service a DB credential fails at startup.
 * Second, the package has no dependency on @deepsight/db at all, so it structurally cannot
 * open a connection. "Zero DB connections under load" is guaranteed by construction, not by
 * runtime discipline.
 */

const validEnv = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  SERVICE_SECRET_CURRENT: 'secret-value',
  SERVICE_SECRET_CURRENT_KID: 'k1',
};

describe('AC3 — the worker refuses any database credential', () => {
  it('rejects DATABASE_URL', () => {
    expect(() => loadAxxonEnv({ ...validEnv, DATABASE_URL: 'postgres://x' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects DATABASE_URL_OWNER', () => {
    expect(() => loadAxxonEnv({ ...validEnv, DATABASE_URL_OWNER: 'postgres://owner' })).toThrow(
      /DATABASE_URL_OWNER/,
    );
  });

  it('rejects ADMIN_DATABASE_URL', () => {
    expect(() => loadAxxonEnv({ ...validEnv, ADMIN_DATABASE_URL: 'postgres://admin' })).toThrow(
      /ADMIN_DATABASE_URL/,
    );
  });

  it('accepts a clean environment', () => {
    const env = loadAxxonEnv(validEnv);
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6379');
    expect(env.PORT).toBe(8081);
  });

  it('still requires REDIS_URL and the signing secret', () => {
    expect(() => loadAxxonEnv({ SERVICE_SECRET_CURRENT: 'x' })).toThrow(/REDIS_URL/);
    expect(() => loadAxxonEnv({ REDIS_URL: 'redis://x' })).toThrow(/SERVICE_SECRET_CURRENT/);
  });
});

describe('AC3 — the package cannot reach the database', () => {
  it('declares no dependency on @deepsight/db', () => {
    const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...manifest.dependencies, ...manifest.devDependencies };
    // pg would be a transitive concern; the direct guarantee is: no @deepsight/db.
    expect(Object.keys(allDeps)).not.toContain('@deepsight/db');
    expect(Object.keys(allDeps)).not.toContain('pg');
  });
});
