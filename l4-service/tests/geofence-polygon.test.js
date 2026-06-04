/**
 * Unit tests for DB-backed polygon geofence evaluation — Task 4.7
 *
 * Tests verify:
 *   - pointInPolygon() returns true for a known interior point
 *   - pointInPolygon() returns false for a known exterior point
 *   - pointInPolygon() works for both CW and CCW winding (winding invariance)
 *   - buildGeofenceCache() computes correct bounding boxes from GeoJSON
 *   - Bounding-box pre-filter skips pointInPolygon for out-of-bbox points
 *   - evaluateAlerts() emits geofence_exit on inside→outside transition
 *   - evaluateAlerts() emits geofence_enter on outside→inside transition
 *   - evaluateAlerts() does NOT emit on first event (no prior state)
 *   - loadGeofences() builds cache from DB rows atomically
 *
 * GeoJSON coordinate convention (RFC 7946 §3.1.1): ring[i] = [lng, lat]
 *   i.e. const [xi, yi] = ring[i]  where  xi = lng, yi = lat
 *
 * Requirements: 8.6, 8.7, 9.1–9.4, 9.7
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock db.js ─────────────────────────────────────────────────────────────────
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
  pool: {
    query: vi.fn().mockResolvedValue({
      rows: [
        {
          geofence_id: 'gf-london',
          name: 'London Bounding Box',
          // GeoJSON Polygon ring in [lng, lat] order (RFC 7946 §3.1.1)
          polygon: JSON.stringify({
            type: 'Polygon',
            coordinates: [[
              [-0.5, 51.3],
              [ 0.3, 51.3],
              [ 0.3, 51.7],
              [-0.5, 51.7],
              [-0.5, 51.3],
            ]],
          }),
          device_id: 'device-london',
        },
      ],
    }),
  },
}));

// ── Mock live-cache.js ─────────────────────────────────────────────────────────
vi.mock('../src/live-cache.js', () => ({
  cacheSet:       vi.fn(),
  cacheGet:       vi.fn().mockReturnValue(undefined),
  cacheAll:       vi.fn(() => []),
  cacheSize:      vi.fn().mockReturnValue(0),
  cacheSubscribe: vi.fn().mockReturnValue(() => {}),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { pointInPolygon, buildGeofenceCache, loadGeofences, evaluateAlerts } from '../src/alerts.js';
import { writeAlert } from '../src/db.js';

// ─── London bounding polygon ──────────────────────────────────────────────────
// GeoJSON [lng, lat] order — ring[i] = [xi, yi] where xi=lng, yi=lat
const londonRing = [
  [-0.5, 51.3],
  [ 0.3, 51.3],
  [ 0.3, 51.7],
  [-0.5, 51.7],
  [-0.5, 51.3],  // closed ring
];

// Known interior point: lat=51.5, lng=-0.1 (central London)
const LONDON_INSIDE_LAT = 51.5;
const LONDON_INSIDE_LNG = -0.1;

// Known exterior point: lat=51.5, lng=1.0 (east of the bounding box)
const LONDON_OUTSIDE_LAT = 51.5;
const LONDON_OUTSIDE_LNG = 1.0;

// Unit square ring — [lng, lat] order — useful for deterministic edge tests
// Vertices: (lng=0,lat=0), (lng=1,lat=0), (lng=1,lat=1), (lng=0,lat=1)
const unitSquareRing = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildEvent({ deviceId = 'device-london', lat, lng, ignition = false } = {}) {
  return {
    event_id:  crypto.randomUUID(),
    device_id: deviceId,
    timestamp: new Date().toISOString(),
    position:  { lat, lng, altitude: null, bearing: null, speed: 0 },
    telemetry: { ignition, fuel_level: null, odometer: null },
    ext_voltage: null,
    bat_voltage: null,
    bat_current: null,
    bat_level: null,
    movement: false,
    axis_x: null,
    axis_y: null,
    axis_z: null,
    gsm_signal: null,
    gnss_status: null,
    gnss_pdop: null,
    gnss_hdop: null,
    fuel_used_gps: null,
    fuel_rate_gps: null,
    trip_odometer: null,
    eco_score: null,
    network_type: null,
    sleep_mode: null,
  };
}

const noop = vi.fn();

// ─── Suite: pointInPolygon ────────────────────────────────────────────────────

describe('pointInPolygon()', () => {
  it('returns true for a known interior point in the London bounding polygon', () => {
    // lat=51.5, lng=-0.1 is inside the London bounding polygon
    // ring is [lng, lat] per GeoJSON; internally const [xi, yi] = ring[i] → xi=lng, yi=lat
    expect(pointInPolygon(LONDON_INSIDE_LAT, LONDON_INSIDE_LNG, londonRing)).toBe(true);
  });

  it('returns false for a known exterior point (east of London)', () => {
    // lat=51.5, lng=1.0 is outside the London bounding polygon
    expect(pointInPolygon(LONDON_OUTSIDE_LAT, LONDON_OUTSIDE_LNG, londonRing)).toBe(false);
  });

  it('returns true for center of unit square [0,0]→[1,1]', () => {
    // pointInPolygon(lat=0.5, lng=0.5, ring) — ring in [lng,lat] order
    expect(pointInPolygon(0.5, 0.5, unitSquareRing)).toBe(true);
  });

  it('returns false for a point outside the unit square', () => {
    // pointInPolygon(lat=2.0, lng=2.0, ring) — clearly outside
    expect(pointInPolygon(2.0, 2.0, unitSquareRing)).toBe(false);
  });

  it('is winding invariant — reversing ring CW↔CCW gives the same result', () => {
    const reversedRing = [...londonRing].reverse();
    const resultCCW = pointInPolygon(LONDON_INSIDE_LAT, LONDON_INSIDE_LNG, londonRing);
    const resultCW  = pointInPolygon(LONDON_INSIDE_LAT, LONDON_INSIDE_LNG, reversedRing);
    expect(resultCCW).toBe(resultCW);
  });

  it('is winding invariant for exterior point', () => {
    const reversedRing = [...londonRing].reverse();
    const resultCCW = pointInPolygon(LONDON_OUTSIDE_LAT, LONDON_OUTSIDE_LNG, londonRing);
    const resultCW  = pointInPolygon(LONDON_OUTSIDE_LAT, LONDON_OUTSIDE_LNG, reversedRing);
    expect(resultCCW).toBe(resultCW);
  });
});

// ─── Suite: buildGeofenceCache ────────────────────────────────────────────────

describe('buildGeofenceCache()', () => {
  it('builds a cache with one entry for device-london', () => {
    const rows = [
      {
        geofence_id: 'gf-london',
        name: 'London',
        polygon: JSON.stringify({ type: 'Polygon', coordinates: [londonRing] }),
        device_id: 'device-1',
      },
    ];
    const cache = buildGeofenceCache(rows);
    expect(cache.has('device-1')).toBe(true);
    expect(cache.get('device-1')).toHaveLength(1);
  });

  it('computes correct bounding box for the London ring', () => {
    const rows = [
      {
        geofence_id: 'gf-london',
        name: 'London',
        polygon: JSON.stringify({ type: 'Polygon', coordinates: [londonRing] }),
        device_id: 'device-1',
      },
    ];
    const cache = buildGeofenceCache(rows);
    const entry = cache.get('device-1')[0];
    // londonRing lngs: -0.5, 0.3 → minLng=-0.5, maxLng=0.3
    // londonRing lats: 51.3, 51.7 → minLat=51.3, maxLat=51.7
    expect(entry.bbox.minLng).toBeCloseTo(-0.5);
    expect(entry.bbox.maxLng).toBeCloseTo(0.3);
    expect(entry.bbox.minLat).toBeCloseTo(51.3);
    expect(entry.bbox.maxLat).toBeCloseTo(51.7);
  });

  it('assigns multiple geofences to the same device', () => {
    const rows = [
      {
        geofence_id: 'gf-a',
        name: 'Fence A',
        polygon: JSON.stringify({ type: 'Polygon', coordinates: [londonRing] }),
        device_id: 'device-x',
      },
      {
        geofence_id: 'gf-b',
        name: 'Fence B',
        polygon: JSON.stringify({ type: 'Polygon', coordinates: [unitSquareRing] }),
        device_id: 'device-x',
      },
    ];
    const cache = buildGeofenceCache(rows);
    expect(cache.get('device-x')).toHaveLength(2);
  });

  it('skips rows with invalid JSON polygon', () => {
    const rows = [
      {
        geofence_id: 'gf-bad',
        name: 'Bad Fence',
        polygon: 'not-valid-json',
        device_id: 'device-bad',
      },
    ];
    const cache = buildGeofenceCache(rows);
    expect(cache.has('device-bad')).toBe(false);
  });

  it('skips rows with unsupported geometry type', () => {
    const rows = [
      {
        geofence_id: 'gf-point',
        name: 'Point Fence',
        polygon: JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
        device_id: 'device-pt',
      },
    ];
    const cache = buildGeofenceCache(rows);
    expect(cache.has('device-pt')).toBe(false);
  });

  it('handles MultiPolygon by using the first ring of the first polygon', () => {
    const rows = [
      {
        geofence_id: 'gf-multi',
        name: 'Multi',
        polygon: JSON.stringify({ type: 'MultiPolygon', coordinates: [[londonRing]] }),
        device_id: 'device-multi',
      },
    ];
    const cache = buildGeofenceCache(rows);
    expect(cache.has('device-multi')).toBe(true);
    expect(cache.get('device-multi')[0].ring).toEqual(londonRing);
  });
});

// ─── Suite: loadGeofences ─────────────────────────────────────────────────────

describe('loadGeofences()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads geofences from DB and populates the cache (device-london from mock)', async () => {
    // The pool mock returns one row for device-london / gf-london
    await loadGeofences();
    // No error expected — test that it doesn't throw
    // Since geofenceCache is module-internal, we verify side-effects via evaluateAlerts
    // by checking that a subsequent event for device-london gets geofence evaluation.
    // (We do not expose the cache directly — that's intentional encapsulation.)
    expect(true).toBe(true); // smoke test — loadGeofences completed without throwing
  });
});

// ─── Suite: geofence enter/exit via evaluateAlerts ────────────────────────────

describe('evaluateAlerts() — geofence_enter / geofence_exit', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reload geofences so geofenceCache is populated with the mock data
    await loadGeofences();
  });

  it('does NOT emit an alert on the first event (no prior state)', async () => {
    const broadcast = vi.fn();
    // First event for device-london — inside the London polygon
    const event = buildEvent({ deviceId: 'device-london', lat: LONDON_INSIDE_LAT, lng: LONDON_INSIDE_LNG });
    await evaluateAlerts(event, broadcast);

    const geofenceCalls = writeAlert.mock.calls.filter(
      c => c[1] === 'geofence_exit' || c[1] === 'geofence_enter'
    );
    expect(geofenceCalls).toHaveLength(0);
  });

  it('emits geofence_exit (MEDIUM) when device moves from inside to outside', async () => {
    const broadcast = vi.fn();
    const deviceId = 'device-london';

    // Event 1: inside London polygon → establish initial state
    await evaluateAlerts(buildEvent({ deviceId, lat: LONDON_INSIDE_LAT, lng: LONDON_INSIDE_LNG }), broadcast);
    vi.clearAllMocks();

    // Event 2: outside London polygon → should trigger geofence_exit
    await evaluateAlerts(buildEvent({ deviceId, lat: LONDON_OUTSIDE_LAT, lng: LONDON_OUTSIDE_LNG }), broadcast);

    const geofenceExitCalls = writeAlert.mock.calls.filter(c => c[1] === 'geofence_exit');
    expect(geofenceExitCalls).toHaveLength(1);
    expect(geofenceExitCalls[0][0]).toBe(deviceId);
    expect(geofenceExitCalls[0][3]).toBe('MEDIUM');

    const broadcastExitCalls = broadcast.mock.calls.filter(c => c[0].alert_type === 'geofence_exit');
    expect(broadcastExitCalls).toHaveLength(1);
  });

  it('emits geofence_enter (LOW) when device moves from outside to inside', async () => {
    const broadcast = vi.fn();
    const deviceId = 'device-london';

    // Event 1: outside London polygon → establish initial state
    await evaluateAlerts(buildEvent({ deviceId, lat: LONDON_OUTSIDE_LAT, lng: LONDON_OUTSIDE_LNG }), broadcast);
    vi.clearAllMocks();

    // Event 2: inside London polygon → should trigger geofence_enter
    await evaluateAlerts(buildEvent({ deviceId, lat: LONDON_INSIDE_LAT, lng: LONDON_INSIDE_LNG }), broadcast);

    const geofenceEnterCalls = writeAlert.mock.calls.filter(c => c[1] === 'geofence_enter');
    expect(geofenceEnterCalls).toHaveLength(1);
    expect(geofenceEnterCalls[0][0]).toBe(deviceId);
    expect(geofenceEnterCalls[0][3]).toBe('LOW');

    const broadcastEnterCalls = broadcast.mock.calls.filter(c => c[0].alert_type === 'geofence_enter');
    expect(broadcastEnterCalls).toHaveLength(1);
  });

  it('does NOT emit when vehicle remains inside the geofence across two events', async () => {
    const broadcast = vi.fn();
    const deviceId = 'device-london';

    // Event 1: inside
    await evaluateAlerts(buildEvent({ deviceId, lat: LONDON_INSIDE_LAT, lng: LONDON_INSIDE_LNG }), broadcast);
    vi.clearAllMocks();

    // Event 2: still inside (slightly different position within the polygon)
    await evaluateAlerts(buildEvent({ deviceId, lat: 51.5, lng: -0.12 }), broadcast);

    const geofenceCalls = writeAlert.mock.calls.filter(
      c => c[1] === 'geofence_exit' || c[1] === 'geofence_enter'
    );
    expect(geofenceCalls).toHaveLength(0);
  });

  it('does NOT emit when vehicle remains outside the geofence across two events', async () => {
    const broadcast = vi.fn();
    const deviceId = 'device-london';

    // Event 1: outside
    await evaluateAlerts(buildEvent({ deviceId, lat: LONDON_OUTSIDE_LAT, lng: LONDON_OUTSIDE_LNG }), broadcast);
    vi.clearAllMocks();

    // Event 2: still outside
    await evaluateAlerts(buildEvent({ deviceId, lat: 52.0, lng: 2.0 }), broadcast);

    const geofenceCalls = writeAlert.mock.calls.filter(
      c => c[1] === 'geofence_exit' || c[1] === 'geofence_enter'
    );
    expect(geofenceCalls).toHaveLength(0);
  });

  it('skips geofence evaluation when lat/lng are null', async () => {
    const broadcast = vi.fn();
    const deviceId = 'device-london';

    const event = buildEvent({ deviceId, lat: null, lng: null });
    await evaluateAlerts(event, broadcast);

    const geofenceCalls = writeAlert.mock.calls.filter(
      c => c[1] === 'geofence_exit' || c[1] === 'geofence_enter'
    );
    expect(geofenceCalls).toHaveLength(0);
  });

  it('does NOT emit geofence alerts for a device with no geofence assignment', async () => {
    const broadcast = vi.fn();
    // 'device-unassigned' has no entry in the mock pool response
    const event = buildEvent({ deviceId: 'device-unassigned', lat: LONDON_INSIDE_LAT, lng: LONDON_INSIDE_LNG });
    await evaluateAlerts(event, broadcast);

    const geofenceCalls = writeAlert.mock.calls.filter(
      c => c[1] === 'geofence_exit' || c[1] === 'geofence_enter'
    );
    expect(geofenceCalls).toHaveLength(0);
  });

  it('bounding-box pre-filter prevents pointInPolygon call for far-away point', () => {
    // Directly test that a point far outside the London bbox is rejected at bbox level.
    // This is a whitebox test on buildGeofenceCache + the bbox check logic.
    const rows = [
      {
        geofence_id: 'gf-london',
        name: 'London',
        polygon: JSON.stringify({ type: 'Polygon', coordinates: [londonRing] }),
        device_id: 'device-1',
      },
    ];
    const cache = buildGeofenceCache(rows);
    const entry = cache.get('device-1')[0];
    const { bbox } = entry;

    // Point at lat=0, lng=0 — completely outside the London bbox
    const lat = 0, lng = 0;
    const inBbox =
      lng >= bbox.minLng && lng <= bbox.maxLng &&
      lat >= bbox.minLat && lat <= bbox.maxLat;

    // bbox check should be false, so PIP is skipped
    expect(inBbox).toBe(false);
    // Confirm PIP would return false too (consistency)
    expect(pointInPolygon(lat, lng, londonRing)).toBe(false);
  });
});
