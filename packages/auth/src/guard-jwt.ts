import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

/**
 * Short-lived guard access tokens (HS256 JWT).
 *
 * The guard app holds a 15-minute access token and a long-lived, rotating refresh token. The
 * access token is stateless — verified by signature and expiry alone, no database hit on the
 * hot path — which is why it is deliberately SHORT-LIVED: statelessness means it cannot be
 * revoked before it expires, so its blast radius is bounded to minutes. Anything requiring
 * immediate revocation (a stolen device) acts on the refresh family, not the access token.
 */
export interface GuardAccessClaims {
  readonly guardId: string;
  readonly orgId: string;
  readonly clientId: string;
  readonly deviceId: string;
  readonly enrollmentId: string;
}

const ALG = 'HS256';
const DEFAULT_TTL_SECONDS = 15 * 60;

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function signGuardAccessToken(
  claims: GuardAccessClaims,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    org_id: claims.orgId,
    client_id: claims.clientId,
    device_id: claims.deviceId,
    enrollment_id: claims.enrollmentId,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.guardId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secretKey(secret));
}

export type GuardTokenVerification =
  | { readonly ok: true; readonly claims: GuardAccessClaims }
  | { readonly ok: false; readonly reason: string };

export async function verifyGuardAccessToken(
  token: string,
  secret: string,
): Promise<GuardTokenVerification> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secretKey(secret), { algorithms: [ALG] }));
  } catch (error) {
    // jose throws on bad signature AND on expiry; both are "not a valid token right now".
    return { ok: false, reason: error instanceof Error ? error.name : 'invalid token' };
  }
  const { sub, org_id, client_id, device_id, enrollment_id } = payload as JWTPayload &
    Record<string, unknown>;
  if (
    typeof sub !== 'string' ||
    typeof org_id !== 'string' ||
    typeof client_id !== 'string' ||
    typeof device_id !== 'string' ||
    typeof enrollment_id !== 'string'
  ) {
    return { ok: false, reason: 'incomplete claims' };
  }
  return {
    ok: true,
    claims: {
      guardId: sub,
      orgId: org_id,
      clientId: client_id,
      deviceId: device_id,
      enrollmentId: enrollment_id,
    },
  };
}
