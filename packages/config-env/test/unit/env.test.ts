import { describe, expect, it } from 'vitest';
import { EnvValidationError, databaseEnvSchema, parseEnv, z } from '../../src/index.js';

/**
 * Phase 1 acceptance test A11: a service with a missing required variable fails hard,
 * naming the variable, and never silently falls back to a default.
 *
 * A silent default is how a staging service ends up writing to production, or how a
 * service runs for a week with authentication quietly disabled.
 */

describe('A11 — env validation fails hard', () => {
  it('throws naming the missing variable', () => {
    expect(() => parseEnv('integration-engine', databaseEnvSchema, {})).toThrowError(
      /DATABASE_URL/,
    );
  });

  it('reports every problem at once, not one per deploy attempt', () => {
    const schema = z.object({
      DATABASE_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
      R2_BUCKET: z.string().min(1),
    });

    try {
      parseEnv('report-worker', schema, {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;
      expect(issues).toHaveLength(3);
      expect(issues.join('\n')).toMatch(/DATABASE_URL/);
      expect(issues.join('\n')).toMatch(/REDIS_URL/);
      expect(issues.join('\n')).toMatch(/R2_BUCKET/);
    }
  });

  it('rejects a present-but-empty variable rather than treating it as absent', () => {
    expect(() =>
      parseEnv('integration-engine', databaseEnvSchema, { DATABASE_URL: '' }),
    ).toThrowError(/DATABASE_URL/);
  });

  it('rejects a connection string that is not postgres', () => {
    expect(() =>
      parseEnv('integration-engine', databaseEnvSchema, {
        DATABASE_URL: 'mysql://user:pass@host/db',
      }),
    ).toThrowError(/postgres/);
  });

  it('accepts a valid environment and applies only explicit, safe defaults', () => {
    const parsed = parseEnv('integration-engine', databaseEnvSchema, {
      DATABASE_URL: 'postgres://app:secret@127.0.0.1:5432/deepsight',
    });
    expect(parsed.DATABASE_URL).toContain('postgres://');
    // DATABASE_POOL_MAX has a declared default; connection strings never do.
    expect(parsed.DATABASE_POOL_MAX).toBe(10);
  });

  it('has no variable naming the owner or superuser role', () => {
    // The owner credential is supplied only to the migration pre-deploy step, so it is
    // absent from a runtime process and application code cannot use it by mistake.
    const keys = Object.keys(databaseEnvSchema.shape);
    expect(keys.some((k) => /OWNER|ADMIN|SUPERUSER/i.test(k))).toBe(false);
  });
});
