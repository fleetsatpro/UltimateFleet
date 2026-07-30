import { describe, expect, it } from 'vitest';
import { createSessionCodec } from '../../src/realtime/session.js';

/**
 * The dashboard session codec in isolation: a token round-trips, and every way of presenting a
 * token that was not signed by this secret is rejected. The hub trusts a verified token to name
 * the org a socket may join, so a forged or altered token slipping through would be a
 * cross-tenant hole — hence the explicit tamper and wrong-secret cases.
 */

const codec = createSessionCodec('phase6-signing-secret-value');
const ORG = '0a000000-0000-4000-8000-000000000001';

describe('session codec', () => {
  it('round-trips a session', () => {
    const token = codec.sign({ sid: 's1', org_id: ORG, client_id: 'c1' });
    const verdict = codec.verify(token);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.session.sid).toBe('s1');
      expect(verdict.session.org_id).toBe(ORG);
      expect(verdict.session.client_id).toBe('c1');
    }
  });

  it('rejects a token signed with a different secret', () => {
    const other = createSessionCodec('a-completely-different-secret');
    const token = other.sign({ sid: 's2', org_id: ORG });
    expect(codec.verify(token).ok).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const token = codec.sign({ sid: 's3', org_id: ORG });
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      payload: { org_id: string };
    };
    // Swap the org without re-signing: the signature no longer matches the payload.
    decoded.payload.org_id = '0b000000-0000-4000-8000-000000000002';
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(codec.verify(forged).ok).toBe(false);
  });

  it('rejects malformed and incomplete tokens', () => {
    expect(codec.verify('not-base64url-json').ok).toBe(false);
    const noSig = Buffer.from(
      JSON.stringify({ payload: { sid: 'x', org_id: ORG } }),
      'utf8',
    ).toString('base64url');
    expect(codec.verify(noSig).ok).toBe(false);
  });
});
