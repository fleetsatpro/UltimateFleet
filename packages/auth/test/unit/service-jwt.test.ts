import { describe, expect, it } from 'vitest';
import { createServiceJwt } from '../../src/service-jwt.js';

/**
 * Phase 7 acceptance criterion 7: service JWTs with kid dual-secret rotation.
 *
 * A token signed with the PREVIOUS key verifies during the rotation window; one signed with an
 * unknown kid, or already expired, is rejected. This is what makes secret rotation zero-downtime
 * — the same property the queue envelopes have, in JWT form for HTTP.
 */

const ISSUER = 'integration-engine';
const AUD = 'report-worker';

const rotated = createServiceJwt({
  current: { kid: 'k2', secret: 'current-secret-value' },
  previous: { kid: 'k1', secret: 'previous-secret-value' },
  issuer: ISSUER,
});

describe('service JWT rotation', () => {
  it('accepts a token signed with the current key', async () => {
    const token = await rotated.sign('engine', AUD, 60);
    const verdict = await rotated.verify(token, AUD);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.subject).toBe('engine');
  });

  it('accepts a token signed with the PREVIOUS key during the rotation window', async () => {
    // A verifier that has already rotated (previous <- old current) still accepts tokens the
    // old deployment is still minting under kid k1.
    const oldSigner = createServiceJwt({
      current: { kid: 'k1', secret: 'previous-secret-value' },
      issuer: ISSUER,
    });
    const token = await oldSigner.sign('engine', AUD, 60);
    expect((await rotated.verify(token, AUD)).ok).toBe(true);
  });

  it('rejects a token whose kid names neither key', async () => {
    const stranger = createServiceJwt({
      current: { kid: 'k9', secret: 'some-other-secret' },
      issuer: ISSUER,
    });
    const token = await stranger.sign('engine', AUD, 60);
    const verdict = await rotated.verify(token, AUD);
    expect(verdict.ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = await rotated.sign('engine', AUD, -5); // already expired
    expect((await rotated.verify(token, AUD)).ok).toBe(false);
  });

  it('rejects a token minted for a different audience', async () => {
    const token = await rotated.sign('engine', 'media-worker', 60);
    expect((await rotated.verify(token, AUD)).ok).toBe(false);
  });
});
