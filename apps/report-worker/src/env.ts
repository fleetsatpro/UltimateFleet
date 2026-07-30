import { databaseEnvSchema, parseEnv, r2EnvSchema, requiredString, z } from '@deepsight/config-env';

/**
 * The report worker's environment. It talks to PostgreSQL (per-client aggregation), Redis (the
 * report.run queue) and Chromium (rendering). The Chromium path defaults to the local
 * Playwright-managed browser but is overridable, because the deployed image installs it elsewhere.
 */
const reportBaseSchema = databaseEnvSchema.extend({
  REDIS_URL: requiredString(),
  SERVICE_SECRET_CURRENT: requiredString(),
  SERVICE_SECRET_CURRENT_KID: z.string().default('current'),
  SERVICE_SECRET_PREVIOUS: z.string().optional(),
  SERVICE_SECRET_PREVIOUS_KID: z.string().optional(),
  CHROMIUM_EXECUTABLE_PATH: z
    .string()
    .default('/opt/pw-browsers/chromium-1194/chrome-linux/chrome'),
  /** Concurrent browsers. The whole point of the pool: bounded, not one-per-report. */
  POOL_MAX_BROWSERS: z.coerce.number().int().positive().default(2),
  /** Renders before a browser is recycled, bounding Chromium's memory creep. */
  POOL_MAX_RENDERS: z.coerce.number().int().positive().default(50),
  /** Recycle a browser early if process RSS crosses this (MiB). 0 disables the ceiling. */
  POOL_RSS_CEILING_MB: z.coerce.number().int().nonnegative().default(0),
  LOG_LEVEL: z.string().default('info'),
});

export const reportEnvSchema = reportBaseSchema.and(r2EnvSchema);
export type ReportEnv = z.infer<typeof reportEnvSchema>;

export function loadReportEnv(source?: Record<string, string | undefined>): ReportEnv {
  return parseEnv('report-worker', reportEnvSchema, source);
}
