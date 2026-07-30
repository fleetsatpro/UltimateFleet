import { parseEnv, requiredString, z } from '@deepsight/config-env';

/**
 * The AxxonSoft worker's environment contract.
 *
 * Note what is REQUIRED to be ABSENT: DATABASE_URL. The worker is deliberately isolated
 * from the database — it publishes signed alarm jobs to BullMQ and never persists anything
 * itself. A worker that could reach the database is a worker that could bypass the queue
 * boundary the brief mandates between this service and the integration engine. So rather
 * than merely not using a DB, the env schema REJECTS DATABASE_URL if it is present, turning
 * a misconfiguration into a hard startup failure instead of a latent capability.
 */
export const axxonEnvSchema = z
  .object({
    REDIS_URL: requiredString(),
    PORT: z.coerce.number().int().positive().default(8081),
    BIND_HOST: z.string().default('::'),
    SERVICE_SECRET_CURRENT: requiredString(),
    SERVICE_SECRET_CURRENT_KID: z.string().default('current'),
    SERVICE_SECRET_PREVIOUS: z.string().optional(),
    SERVICE_SECRET_PREVIOUS_KID: z.string().optional(),
    // Axxon stream endpoint details are unverified (open item 3). Present so the worker can
    // be pointed at the real endpoint once confirmed; the adapter still throws until then.
    AXXON_STREAM_URL: z.string().optional(),
    RECONNECT_INITIAL_MS: z.coerce.number().int().positive().default(500),
    RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL: z.undefined({
      invalid_type_error:
        'DATABASE_URL must not be set on the axxon-worker: it is isolated from the database ' +
        'by design and communicates only via the signed BullMQ queue. Remove it.',
    }),
  })
  // Belt and braces: also reject the owner/admin URLs, so no DB credential of any kind can
  // reach this process.
  .strip();

export type AxxonEnv = z.infer<typeof axxonEnvSchema>;

export function loadAxxonEnv(source?: Record<string, string | undefined>): AxxonEnv {
  // Guard the DB-adjacent variables explicitly, because zod .strip() would otherwise
  // silently drop unknown keys rather than reject them.
  const env = source ?? process.env;
  for (const forbidden of ['DATABASE_URL', 'DATABASE_URL_OWNER', 'ADMIN_DATABASE_URL']) {
    if (env[forbidden] !== undefined) {
      throw new Error(
        `axxon-worker refuses to start: ${forbidden} is set, but this service must be ` +
          `isolated from the database (it publishes to BullMQ only). Unset ${forbidden}.`,
      );
    }
  }
  return parseEnv('axxon-worker', axxonEnvSchema, env);
}
