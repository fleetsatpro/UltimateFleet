import { describe, expect, it } from 'vitest';
import { MEDIA_PRIORITY_MAX, MEDIA_PRIORITY_MIN, mediaJobPriority } from '../../src/media/job.js';

/**
 * The expiry -> priority mapping, in isolation. The end-to-end ordering (AC5) is proven over a
 * real queue elsewhere; this pins the monotonicity the queue relies on, so a future change to
 * the formula that breaks ordering fails here rather than as a flaky integration test.
 */

const NOW = new Date('2026-07-01T00:00:00Z');
const inSeconds = (s: number): Date => new Date(NOW.getTime() + s * 1000);

describe('mediaJobPriority', () => {
  it('is monotonic in expiry: sooner deadline yields a smaller (more urgent) number', () => {
    const soon = mediaJobPriority(inSeconds(10), NOW);
    const later = mediaJobPriority(inSeconds(100), NOW);
    const muchLater = mediaJobPriority(inSeconds(1000), NOW);
    expect(soon).toBeLessThan(later);
    expect(later).toBeLessThan(muchLater);
  });

  it('ranks a stated expiry ahead of no expiry', () => {
    expect(mediaJobPriority(inSeconds(1_000_000), NOW)).toBeLessThan(mediaJobPriority(null, NOW));
    expect(mediaJobPriority(null, NOW)).toBe(MEDIA_PRIORITY_MAX);
  });

  it('clamps an already-expired URL to the most-urgent slot', () => {
    expect(mediaJobPriority(inSeconds(-500), NOW)).toBe(MEDIA_PRIORITY_MIN);
  });

  it('never leaves the valid BullMQ priority range', () => {
    for (const s of [-10, 0, 1, 60, 3600, 10_000_000]) {
      const p = mediaJobPriority(inSeconds(s), NOW);
      expect(p).toBeGreaterThanOrEqual(MEDIA_PRIORITY_MIN);
      expect(p).toBeLessThanOrEqual(MEDIA_PRIORITY_MAX);
    }
  });
});
