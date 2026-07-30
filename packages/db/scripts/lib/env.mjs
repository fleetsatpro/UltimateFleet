/**
 * Connection URLs for the three role tiers. The separation is the mechanism that
 * satisfies "the owner/superuser role must never appear in application code":
 *
 *   ADMIN_DATABASE_URL   superuser. Bootstrap ONLY (CREATE ROLE needs superuser).
 *   DATABASE_URL_OWNER   deepsight_owner. Migrations and seeds ONLY. In deployment this
 *                        is set on the migration pre-deploy step and nowhere else, so
 *                        it is not present in a runtime process at all.
 *   DATABASE_URL         deepsight_app. Every application query path.
 */
export function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `There are no defaults for connection strings — see packages/db/scripts/lib/env.mjs.`,
    );
  }
  return value;
}

export const adminUrl = () => requireEnv('ADMIN_DATABASE_URL');
export const ownerUrl = () => requireEnv('DATABASE_URL_OWNER');
export const appUrl = () => requireEnv('DATABASE_URL');

export const migrationsDir = new URL('../../migrations/', import.meta.url).pathname;
