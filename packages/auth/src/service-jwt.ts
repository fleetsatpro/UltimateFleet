import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

/**
 * Service-to-service JWTs with kid dual-secret rotation.
 *
 * The same rotation scheme the queue envelopes use, in JWT form for HTTP: sign with `current`,
 * accept `current` OR `previous`, selected by the `kid` header. Rotation is therefore
 * zero-downtime — deploy the new secret as `current` and the old as `previous`, and in-flight
 * tokens signed with the old key still verify until they expire — no coordinated restart.
 *
 * A token whose `kid` names neither key, or whose `exp` has passed, is rejected. Acceptance
 * criterion 7 asserts exactly these: previous-key acceptance during the window, unknown-kid and
 * expired rejection.
 */
export interface ServiceKey {
  readonly kid: string;
  readonly secret: string;
}

export interface ServiceJwtConfig {
  readonly current: ServiceKey;
  readonly previous?: ServiceKey | undefined;
  readonly issuer: string;
}

const ALG = 'HS256';

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export interface ServiceJwt {
  sign(subject: string, audience: string, ttlSeconds: number): Promise<string>;
  verify(token: string, audience: string): Promise<ServiceJwtVerification>;
}

export type ServiceJwtVerification =
  { readonly ok: true; readonly subject: string } | { readonly ok: false; readonly reason: string };

export function createServiceJwt(config: ServiceJwtConfig): ServiceJwt {
  const byKid = new Map<string, string>([[config.current.kid, config.current.secret]]);
  if (config.previous !== undefined) byKid.set(config.previous.kid, config.previous.secret);

  return {
    sign(subject, audience, ttlSeconds) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: ALG, kid: config.current.kid })
        .setIssuer(config.issuer)
        .setSubject(subject)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + ttlSeconds)
        .sign(key(config.current.secret));
    },

    async verify(token, audience) {
      let payload: JWTPayload;
      try {
        // The key is chosen by the token's kid header, then jwtVerify checks the signature,
        // exp, issuer and audience. An unknown kid resolves to no key and fails closed.
        ({ payload } = await jwtVerify(
          token,
          (header) => {
            const secret = header.kid !== undefined ? byKid.get(header.kid) : undefined;
            if (secret === undefined) throw new Error(`unknown kid: ${String(header.kid)}`);
            return Promise.resolve(key(secret));
          },
          { algorithms: [ALG], issuer: config.issuer, audience },
        ));
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'invalid token' };
      }
      if (typeof payload.sub !== 'string') return { ok: false, reason: 'missing subject' };
      return { ok: true, subject: payload.sub };
    },
  };
}
