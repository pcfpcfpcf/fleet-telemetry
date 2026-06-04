/**
 * Property test — Point-in-Polygon Correctness (Property 8)
 *
 * **Validates: Requirements 9.4**
 *
 * Properties:
 *   1. Translation invariance: shifting all ring coords AND the test point by the same
 *      delta yields the same result.
 *   2. Winding invariance: reversing ring coordinate order (CW vs CCW) yields the same result.
 *   3. Known interior point → true:  unit square [[0,0],[1,0],[1,1],[0,1],[0,0]], point [0.5, 0.5]
 *   4. Known exterior point → false: unit square, point [2.0, 2.0]
 *
 * How to run:
 *   npm test -- tests/point-in-polygon.test.js
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// ── Mock db.js and live-cache.js (alerts.js imports them at module load) ───────
vi.mock('../src/db.js', () => ({
  writeTelemetry:        vi.fn(),
  writeTelemetryBatch:   vi.fn().mockResolvedValue(undefined),
  writeTripOpen:         vi.fn().mockResolvedValue('mock-trip-id'),
  writeTripClose:        vi.fn().mockResolvedValue(undefined),
  touchDeviceLastSeen:   vi.fn().mockResolvedValue(undefined),
  writeAlert:            vi.fn().mockResolvedValue(undefined),
  writeDeviceConfig:     vi.fn().mockResolvedValue(undefined),
  readDeviceConfig:      vi.fn().mockResolvedValue(null),
  writeDriverAssignment: vi.fn().mockResolvedValue(undefined),
  writeDtcEvent:         vi.fn().mockResolvedValue(undefined),
  resolveDtcEvent:       vi.fn().mockResolvedValue(undefined),
  writeAuditLog:         vi.fn().mockResolvedValue(undefined),
  pool:                  { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock('../src/live-cache.js', () => ({
  cacheSet:       vi.fn(),
  cacheGet:       vi.fn().mockReturnValue(undefined),
  cacheAll:       vi.fn().mockReturnValue([]),
  cacheSize:      vi.fn().mockReturnValue(0),
  cacheSubscribe: vi.fn().mockReturnValue(() => {}),
}));

import { pointInPolygon } from '../src/alerts.js';

// ─── Fixed test fixtures ──────────────────────────────────────────────────────
// GeoJSON coordinate order: ring[i] = [lng, lat]  (RFC 7946 §3.1.1)
// pointInPolygon(lat, lng, ring) — call site uses lat/lng but ring is [lng, lat]

// Unit square: corners at (lng=0,lat=0), (lng=1,lat=0), (lng=1,lat=1), (lng=0,lat=1)
const UNIT_SQUARE_RING = [
  [0, 0], // [lng, lat]
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0], // closed
];

// ─── Suite: Known-point regression guards ────────────────────────────────────

describe('pointInPolygon() — deterministic regression guards', () => {

  it('returns true for known interior point [lat=0.5, lng=0.5] in unit square', () => {
    // ring is [[lng,lat]...]: UNIT_SQUARE_RING is [lng, lat] order
    // Call: pointInPolygon(lat=0.5, lng=0.5, ring)
    expect(pointInPolygon(0.5, 0.5, UNIT_SQUARE_RING)).toBe(true);
  });

  it('returns false for known exterior point [lat=2.0, lng=2.0] outside unit square', () => {
    expect(pointInPolygon(2.0, 2.0, UNIT_SQUARE_RING)).toBe(false);
  });

  it('returns true for a known interior point [lat=51.5, lng=-0.1] in London bounding box', () => {
    // London bounding polygon in [lng, lat] order
    const londonRing = [
      [-0.5, 51.3],
      [ 0.3, 51.3],
      [ 0.3, 51.7],
      [-0.5, 51.7],
      [-0.5, 51.3],
    ];
    expect(pointInPolygon(51.5, -0.1, londonRing)).toBe(true);
  });

  it('returns false for a known exterior point [lat=51.5, lng=1.0] outside London bounding box', () => {
    const londonRing = [
      [-0.5, 51.3],
      [ 0.3, 51.3],
      [ 0.3, 51.7],
      [-0.5, 51.7],
      [-0.5, 51.3],
    ];
    expect(pointInPolygon(51.5, 1.0, londonRing)).toBe(false);
  });
});

// ─── Suite: Winding invariance ────────────────────────────────────────────────

describe('pointInPolygon() — winding invariance', () => {

  it('returns the same result for CW and CCW winding of the unit square', () => {
    const reversedRing = [...UNIT_SQUARE_RING].reverse();

    // Interior point
    expect(pointInPolygon(0.5, 0.5, UNIT_SQUARE_RING)).toBe(
      pointInPolygon(0.5, 0.5, reversedRing)
    );

    // Exterior point
    expect(pointInPolygon(2.0, 2.0, UNIT_SQUARE_RING)).toBe(
      pointInPolygon(2.0, 2.0, reversedRing)
    );
  });

  it('Property 8 (winding invariance): reversing ring order yields same result for any polygon', () => {
    /**
     * **Validates: Requirements 9.4**
     *
     * For any polygon ring and any test point, the result of pointInPolygon
     * must be identical whether the ring is wound CW or CCW.
     * This catches bugs that assume a specific winding direction.
     *
     * Uses integer-scaled coordinates to avoid subnormal/near-zero float precision
     * issues that cause degenerate polygon behaviour in ray-casting.
     */
    fc.assert(
      fc.property(
        // Polygon ring — at least 4 vertices using integer coordinates scaled to degrees
        fc.array(
          fc.tuple(
            fc.integer({ min: -1800, max: 1800 }).map(x => x / 10), // lng: -180 to 180
            fc.integer({ min: -900,  max:  900 }).map(y => y / 10), // lat: -90 to 90
          ),
          { minLength: 4, maxLength: 10 }
        ),
        // Test point — integer-scaled
        fc.integer({ min: -1800, max: 1800 }).map(x => x / 10), // lng
        fc.integer({ min: -900,  max:  900 }).map(y => y / 10), // lat
        (ring, testLng, testLat) => {
          // Close the ring (GeoJSON requires first == last)
          const closedRing = [...ring, ring[0]];
          const reversedRing = [...closedRing].reverse();

          const resultCCW = pointInPolygon(testLat, testLng, closedRing);
          const resultCW  = pointInPolygon(testLat, testLng, reversedRing);

          // Winding invariance: both must return the same boolean
          expect(resultCCW).toBe(resultCW);
        }
      ),
      { numRuns: 500, verbose: false }
    );
  });
});

// ─── Suite: Translation invariance ───────────────────────────────────────────

describe('pointInPolygon() — translation invariance', () => {

  it('shifting unit square and interior point by (0.5, 0.5) still returns true', () => {
    const dx = 0.5; // lng shift
    const dy = 0.5; // lat shift

    const shiftedRing = UNIT_SQUARE_RING.map(([lng, lat]) => [lng + dx, lat + dy]);
    const shiftedLat  = 0.5 + dy;
    const shiftedLng  = 0.5 + dx;

    const original = pointInPolygon(0.5, 0.5, UNIT_SQUARE_RING);
    const shifted  = pointInPolygon(shiftedLat, shiftedLng, shiftedRing);

    expect(shifted).toBe(original);
  });

  it('Property 8 (translation invariance): shifting ring and point by same delta yields same result', () => {
    /**
     * **Validates: Requirements 9.4**
     *
     * For any polygon, test point, and translation delta:
     *   pointInPolygon(lat, lng, ring) === pointInPolygon(lat+dy, lng+dx, shiftedRing)
     *
     * Uses integer-scaled coordinates to avoid subnormal/near-zero float precision
     * issues that cause degenerate polygon behaviour in ray-casting.
     */
    fc.assert(
      fc.property(
        // Polygon ring — integer-scaled coordinates
        fc.array(
          fc.tuple(
            fc.integer({ min: -800, max: 800 }).map(x => x / 10), // lng: -80 to 80
            fc.integer({ min: -400, max: 400 }).map(y => y / 10), // lat: -40 to 40
          ),
          { minLength: 4, maxLength: 10 }
        ),
        // Test point
        fc.integer({ min: -800, max: 800 }).map(x => x / 10),
        fc.integer({ min: -400, max: 400 }).map(y => y / 10),
        // Translation delta — small integer values to prevent range overflow
        fc.integer({ min: -50, max: 50 }).map(x => x / 10),
        fc.integer({ min: -50, max: 50 }).map(y => y / 10),
        (ring, testLng, testLat, dx, dy) => {
          // Close the ring
          const closedRing = [...ring, ring[0]];

          // Shift the ring and test point by the same delta
          const shiftedRing = closedRing.map(([lng, lat]) => [lng + dx, lat + dy]);
          const shiftedLat  = testLat + dy;
          const shiftedLng  = testLng + dx;

          const original = pointInPolygon(testLat, testLng, closedRing);
          const shifted  = pointInPolygon(shiftedLat, shiftedLng, shiftedRing);

          // Translation invariance: result must be identical
          expect(original).toBe(shifted);
        }
      ),
      { numRuns: 500, verbose: false }
    );
  });
});

// ─── Suite: Combined properties ───────────────────────────────────────────────

describe('pointInPolygon() — combined property checks', () => {

  it('Property 8 (both invariants): translation AND winding invariance hold simultaneously', () => {
    /**
     * **Validates: Requirements 9.4**
     *
     * Verifies both invariants hold for the same generated polygon.
     * Uses integer-scaled coordinates to avoid degenerate float precision issues.
     */
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: -800, max: 800 }).map(x => x / 10),
            fc.integer({ min: -400, max: 400 }).map(y => y / 10),
          ),
          { minLength: 4, maxLength: 8 }
        ),
        fc.integer({ min: -800, max: 800 }).map(x => x / 10),
        fc.integer({ min: -400, max: 400 }).map(y => y / 10),
        fc.integer({ min: -50, max: 50 }).map(x => x / 10),
        fc.integer({ min: -50, max: 50 }).map(y => y / 10),
        (ring, testLng, testLat, dx, dy) => {
          const closedRing = [...ring, ring[0]];
          const reversedRing = [...closedRing].reverse();

          // Shifted versions
          const shiftedClosedRing   = closedRing.map(([lng, lat]) => [lng + dx, lat + dy]);
          const shiftedReversedRing = reversedRing.map(([lng, lat]) => [lng + dx, lat + dy]);
          const shiftedLat = testLat + dy;
          const shiftedLng = testLng + dx;

          const r0 = pointInPolygon(testLat, testLng, closedRing);
          const r1 = pointInPolygon(testLat, testLng, reversedRing);      // winding invariance
          const r2 = pointInPolygon(shiftedLat, shiftedLng, shiftedClosedRing);    // translation invariance
          const r3 = pointInPolygon(shiftedLat, shiftedLng, shiftedReversedRing);  // both

          // All four results must be identical
          expect(r1).toBe(r0);
          expect(r2).toBe(r0);
          expect(r3).toBe(r0);
        }
      ),
      { numRuns: 300, verbose: false }
    );
  });
});
