/**
 * Role-based access control for dashboard users.
 *
 * Three roles, matching the users.role CHECK constraint. RBAC is a route-level gate; it is NOT
 * the tenant boundary — that is RLS, enforced independently in the database. The two are
 * deliberately redundant: acceptance criterion 6 requires that a supervisor in org A be denied
 * an org B resource AND that the underlying query return zero rows even if the route check is
 * bypassed. A single mechanism failing must not open the door.
 */
export const ROLES = ['admin', 'supervisor', 'report_viewer'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Whether `role` is among the roles a route allows. */
export function roleAllows(allowed: readonly Role[], role: Role): boolean {
  return allowed.includes(role);
}
