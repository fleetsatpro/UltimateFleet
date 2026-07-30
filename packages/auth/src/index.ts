/**
 * @deepsight/auth — authentication and authorization primitives.
 *
 * Pure mechanism, no HTTP and no database: password hashing, opaque token generation, the Redis
 * session store, guard and service JWTs, and the RBAC role model. The engine wires these into
 * routes and the db package into persistence; keeping them here means every auth decision is a
 * small, unit-testable function rather than logic tangled into a request handler.
 */
export { hashPassword, verifyPassword } from './password.js';
export {
  generateOpaqueToken,
  generateScopedToken,
  orgFromScopedToken,
  hashToken,
  type OpaqueToken,
} from './tokens.js';
export { ROLES, isRole, roleAllows, type Role } from './rbac.js';
export {
  createSessionStore,
  type SessionStore,
  type DashboardUserSession,
} from './session-store.js';
export {
  signGuardAccessToken,
  verifyGuardAccessToken,
  type GuardAccessClaims,
  type GuardTokenVerification,
} from './guard-jwt.js';
export {
  createServiceJwt,
  type ServiceJwt,
  type ServiceKey,
  type ServiceJwtConfig,
  type ServiceJwtVerification,
} from './service-jwt.js';
