import { z } from 'zod';

/**
 * Environment configuration.
 *
 * All secrets and environment-specific values arrive via environment variables, and
 * the full shape is validated at service startup. A service with a missing required
 * variable must FAIL HARD, naming the variable — never silently fall back to a
 * default. A silent default is how a staging service ends up writing to production,
 * or how a service runs for a week with authentication disabled.
 */

export class EnvValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(service: string, issues: readonly string[]) {
    super(
      `Invalid environment for "${service}":\n` +
        issues.map((i) => `  - ${i}`).join('\n') +
        `\nRefusing to start. Set the variables above; there are no defaults for required values.`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Parses `source` against `schema`, throwing {@link EnvValidationError} listing every
 * problem at once. Reporting all issues together matters operationally: fixing one
 * variable per deploy attempt on a platform with a multi-minute build is miserable.
 */
export function parseEnv<S extends z.ZodTypeAny>(
  service: string,
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(service, issues);
  }
  return result.data;
}

/** A required, non-empty string. The default building block — no implicit fallback. */
export const requiredString = (): z.ZodString => z.string().min(1);

/** A required PostgreSQL connection URL. Return type inferred: `.refine` yields ZodEffects. */
export const postgresUrl = () =>
  z
    .string()
    .min(1)
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// URL',
    });

/** An integer from a string env var, with an explicit default where one is genuinely safe. */
export const intWithDefault = (fallback: number) => z.coerce.number().int().default(fallback);

/**
 * The database env shape shared by every service that talks to PostgreSQL.
 *
 * Note what is absent: any variable naming the owner/superuser role. The owner
 * credential is supplied ONLY to the migration pre-deploy step, so it is not present
 * in a runtime process and application code cannot use it even by mistake. That is a
 * deployment-level control, not a coding convention review has to catch.
 */
export const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrl(),
  DATABASE_POOL_MAX: intWithDefault(10),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export { z };
