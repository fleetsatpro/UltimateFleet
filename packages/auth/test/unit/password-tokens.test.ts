import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/password.js';
import {
  generateOpaqueToken,
  generateScopedToken,
  hashToken,
  orgFromScopedToken,
} from '../../src/tokens.js';
import { signGuardAccessToken, verifyGuardAccessToken } from '../../src/guard-jwt.js';

const ORG = '0a000000-0000-4000-8000-000000000001';

describe('password hashing (Argon2id)', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
  });

  it('returns false (never throws) on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('hashes deterministically and uniquely per token', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(hashToken(a.plaintext)).toBe(a.hash);
    expect(a.hash).not.toBe(b.hash);
  });

  it('carries the org in a scoped token and parses it back', () => {
    const scoped = generateScopedToken(ORG);
    expect(orgFromScopedToken(scoped.plaintext)).toBe(ORG);
    expect(hashToken(scoped.plaintext)).toBe(scoped.hash);
    expect(orgFromScopedToken('no-dot-here')).toBeNull();
  });
});

describe('guard access JWT', () => {
  it('round-trips claims and rejects a wrong secret', async () => {
    const claims = {
      guardId: 'g1',
      orgId: ORG,
      clientId: 'c1',
      deviceId: 'd1',
      enrollmentId: 'e1',
    };
    const token = await signGuardAccessToken(claims, 'the-secret', 60);
    const ok = await verifyGuardAccessToken(token, 'the-secret');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.claims).toEqual(claims);
    expect((await verifyGuardAccessToken(token, 'wrong-secret')).ok).toBe(false);
  });

  it('rejects an expired access token', async () => {
    const token = await signGuardAccessToken(
      { guardId: 'g1', orgId: ORG, clientId: 'c1', deviceId: 'd1', enrollmentId: 'e1' },
      'the-secret',
      -5,
    );
    expect((await verifyGuardAccessToken(token, 'the-secret')).ok).toBe(false);
  });
});
