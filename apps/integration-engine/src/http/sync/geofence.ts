/**
 * Great-circle distance between two GPS points, in metres (haversine).
 *
 * Used to decide whether a sign-in falls outside a site's geofence. The check is
 * SERVER-AUTHORITATIVE: the device sends its GPS reading, but the engine — not the app —
 * computes the distance against the site's stored radius and sets the violation flag, so a
 * tampered client cannot mark itself compliant. Per the brief, a violation is FLAGGED and the
 * distance recorded; the event is never dropped.
 */
const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GeofenceOutcome {
  readonly violation: boolean;
  readonly distanceM: number | null;
}

/**
 * Evaluates a GPS reading against a site geofence. No reading (a device without a fix) is not a
 * violation — it is simply unknown, so the flag stays false and the distance null rather than
 * fabricating a failure.
 */
export function evaluateGeofence(
  gps: { lat: number | null; lon: number | null },
  site: { latitude: number; longitude: number; geofence_radius_m: number },
): GeofenceOutcome {
  if (gps.lat === null || gps.lon === null) return { violation: false, distanceM: null };
  const distance = haversineMetres(
    { lat: gps.lat, lon: gps.lon },
    { lat: site.latitude, lon: site.longitude },
  );
  return { violation: distance > site.geofence_radius_m, distanceM: Math.round(distance) };
}
