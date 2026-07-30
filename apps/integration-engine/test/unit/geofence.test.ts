import { describe, expect, it } from 'vitest';
import { evaluateGeofence, haversineMetres } from '../../src/http/sync/geofence.js';

/**
 * The geofence maths in isolation. The server — not the device — decides violations, so this is
 * the authoritative check; it must be right and it must never fabricate a violation from a
 * missing GPS fix.
 */

describe('haversineMetres', () => {
  it('is ~0 for identical points', () => {
    expect(haversineMetres({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBeCloseTo(0, 5);
  });

  it('measures ~111 km per degree of latitude', () => {
    const d = haversineMetres({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe('evaluateGeofence', () => {
  const site = { latitude: 0, longitude: 0, geofence_radius_m: 100 };

  it('flags a sign-in ~500 m outside a 100 m radius with the distance', () => {
    // ~0.0045° latitude ≈ 500 m.
    const outcome = evaluateGeofence({ lat: 0.0045, lon: 0 }, site);
    expect(outcome.violation).toBe(true);
    expect(outcome.distanceM).toBeGreaterThan(450);
    expect(outcome.distanceM).toBeLessThan(550);
  });

  it('does not flag a reading inside the radius', () => {
    const outcome = evaluateGeofence({ lat: 0.0002, lon: 0 }, site); // ~22 m
    expect(outcome.violation).toBe(false);
  });

  it('treats a missing GPS fix as unknown, not a violation', () => {
    expect(evaluateGeofence({ lat: null, lon: null }, site)).toEqual({
      violation: false,
      distanceM: null,
    });
  });
});
