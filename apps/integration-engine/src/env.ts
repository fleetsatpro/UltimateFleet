import { databaseEnvSchema, parseEnv, requiredString, z } from '@deepsight/config-env';

/**
 * The engine's full environment contract, validated once at startup. Missing required
 * values fail hard, naming the variable — never a silent default.
 *
 * Note what is absent: any variable naming the owner or superuser database role. The
 * owner credential is supplied only to the migration pre-deploy step, so it is not
 * present in this process and the application cannot use it even by mistake.
 */
export const engineEnvSchema = databaseEnvSchema.extend({
  REDIS_URL: requiredString(),
  PORT: z.coerce.number().int().positive().default(8080),
  /**
   * Railway private networking requires binding the IPv6 wildcard: legacy environments
   * (created before 2025-10-16) are IPv6-only, and newer ones accept both via `[::]`.
   * Binding 0.0.0.0 yields a service that is silently unreachable from sibling services.
   */
  BIND_HOST: z.string().default('::'),
  SERVICE_SECRET_CURRENT: requiredString(),
  SERVICE_SECRET_CURRENT_KID: z.string().default('current'),
  SERVICE_SECRET_PREVIOUS: z.string().optional(),
  SERVICE_SECRET_PREVIOUS_KID: z.string().optional(),
  /**
   * Interim protection for /admin routes until Phase 7 brings supervisor sessions and
   * RBAC. Optional in the schema, but the route FAILS CLOSED when it is absent (503)
   * rather than serving an unauthenticated mutation endpoint — a config omission must not
   * silently open an admin surface.
   */
  ADMIN_API_TOKEN: z.string().min(16).optional(),
  LOG_LEVEL: z.string().default('info'),
});

export type EngineEnv = z.infer<typeof engineEnvSchema>;

export function loadEngineEnv(source?: Record<string, string | undefined>): EngineEnv {
  return parseEnv('integration-engine', engineEnvSchema, source);
}
