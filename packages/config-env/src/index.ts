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

/**
 * Cloudflare R2 configuration for the media pipeline.
 *
 * Every credential field is OPTIONAL because R2 is not provisioned yet (Open Item 10): a
 * service must still boot without it, just with the media pipeline disabled. But a PARTIAL
 * config — an endpoint with no secret, say — is a misconfiguration, not "disabled", so the
 * superRefine rejects it: either all four connection fields are present or none are. The TTL
 * and region carry safe defaults; the connection fields never do.
 */
const R2_CONNECTION_FIELDS = [
  'R2_ENDPOINT',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

export const r2EnvSchema = z
  .object({
    R2_ENDPOINT: z.string().url().optional(),
    R2_BUCKET: z.string().min(1).optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    R2_REGION: z.string().min(1).default('auto'),
    MEDIA_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  })
  .superRefine((value, ctx) => {
    const present = R2_CONNECTION_FIELDS.filter(
      (field) => value[field] !== undefined && value[field] !== '',
    );
    if (present.length !== 0 && present.length !== R2_CONNECTION_FIELDS.length) {
      const missing = R2_CONNECTION_FIELDS.filter((field) => !present.includes(field));
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `R2 is partially configured: set all of ${R2_CONNECTION_FIELDS.join(', ')} to enable ` +
          `the media pipeline, or none to disable it. Missing: ${missing.join(', ')}.`,
      });
    }
  });

export type R2Env = z.infer<typeof r2EnvSchema>;

export { z };
