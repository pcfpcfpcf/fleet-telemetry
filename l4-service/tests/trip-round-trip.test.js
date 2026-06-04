/**
 * Property test — Trip Round-Trip (Property 4)
 *
 * **Validates: Requirements 4.2, 4.3**
 *
 * Property:
 *   For any ignition sequence, every FALSE → TRUE → FALSE transition results in:
 *     - writeTripOpen() called at the TRUE transition
 *     - writeTripClose() called at the FALSE transition with:
 *         • the correct tripId
 *         • ended_at > started_at (timestamps advance)
 *         • matching end_lat / end_lng from the close event position
 *
 * How to run:
 *   npm test -- tests/trip-round-trip.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Mock db.js before importing consumer.js ───────────────────────────────────
vi.mock('../src/db.js', () => ({
  writeTelemetry:        vi.fn(),
  writeTelemetryBatch:   vi.fn().mockResolvedValue(undefined),
  writeTripOpen:         vi.fn(),
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

vi.mock('../src/alerts.js', () => ({
  evaluateAlerts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/live-cache.js', () => ({
  cacheSet: vi.fn(),
  cacheGet: vi.fn().mockReturnValue(undefined),
  cacheAll: vi.fn().mockReturnValue([]),
}));

vi.mock('nats', () => ({
  connect:     vi.fn(),
  StringCodec: vi.fn(() => ({ encode: vi.fn(), decode: vi.fn() })),
}));

import { detectTripBoundary } from '../src/consumer.js';
import { writeTripOpen, writeTripClose } from '../src/db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _tsBase = Date.now();
let _tsIdx  = 0;

/**
 * Build a normalised event with the given ignition state.
 * Each call advances the timestamp by 1 s so ended_at > started_at is always satisfiable.
 */
function buildEvent({ deviceId, ignition, lat = 51.5, lng = -0.1 } = {}) {
  _tsIdx++;
  return {
    event_id:  crypto.randomUUID(),
    device_id: deviceId,
    timestamp: new Date(_tsBase + _tsIdx * 1_000).toISOString(),
    position:  { lat, lng, altitude: null, accuracy: null, bearing: null, speed: 0 },
    telemetry: { ignition, fuel_level: null, odometer: null, rpm: null, engine_load: null },
    ext_voltage: null, bat_voltage: null, bat_level: null, bat_current: null,
    movement: false, gsm_signal: null, gnss_status: null, gnss_pdop: null, gnss_hdop: null,
    fuel_rate_gps: null, fuel_used_gps: null, axis_x: null, axis_y: null, axis_z: null,
    network_type: null, sleep_mode: null, eco_score: null, trip_odometer: null, buffered: false,
    dtc_code_1: null, dtc_code_2: null, dtc_code_3: null, dtc_code_4: null,
    dtc_code_5: null, dtc_code_6: null, dtc_code_7: null, dtc_code_8: null, dtc_code_9: null,
  };
}

/**
 * Find all trip open/close pairs in a boolean array, mirroring detectTripBoundary logic:
 *   - prev=null AND cur=true  → open (first-event guard)
 *   - prev=false AND cur=true → open
 *   - prev=true  AND cur=false AND open trip exists → close
 * Returns an array of { openIdx, closeIdx } index pairs for completed trips.
 * Also returns openCount (number of opens) and closeCount (number of closes).
 */
function findTripTransitions(seq) {
  const completedTrips = [];
  let tripStart = null;
  let prev = null; // null = no previous value (first event)
  let openCount = 0;

  for (let i = 0; i < seq.length; i++) {
    const cur = seq[i];

    if (prev === null) {
      // First event for device
      if (cur === true) {
        tripStart = i;
        openCount++;
      }
    } else if (prev === false && cur === true) {
      // FALSE → TRUE transition: open
      tripStart = i;
      openCount++;
    } else if (prev === true && cur === false) {
      // TRUE → FALSE transition: close (only if a trip is open)
      if (tripStart !== null) {
        completedTrips.push({ openIdx: tripStart, closeIdx: i });
        tripStart = null;
      }
    }

    prev = cur;
  }

  return { completedTrips, openCount };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Property 4: Trip Round-Trip Open/Close', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    _tsIdx = 0;
    _tsBase = Date.now();
  });

  // ── Deterministic regression guards ───────────────────────────────────────

  it('opens exactly one trip for a single FALSE→TRUE sequence', async () => {
    writeTripOpen.mockResolvedValue(crypto.randomUUID());
    const deviceId = `dev-open-only-${crypto.randomUUID()}`;

    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true }));

    expect(writeTripOpen).toHaveBeenCalledOnce();
    expect(writeTripClose).not.toHaveBeenCalled();
  });

  it('closes the trip with correct end_lat/end_lng for a complete FALSE→TRUE→FALSE cycle', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);
    const deviceId = `dev-round-trip-${crypto.randomUUID()}`;

    const endLat = 48.8566;
    const endLng = 2.3522;

    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    const openEvent = buildEvent({ deviceId, ignition: true, lat: 51.5, lng: -0.1 });
    await detectTripBoundary(openEvent);
    const closeEvent = buildEvent({ deviceId, ignition: false, lat: endLat, lng: endLng });
    await detectTripBoundary(closeEvent);

    expect(writeTripOpen).toHaveBeenCalledOnce();
    expect(writeTripClose).toHaveBeenCalledOnce();

    const closeArgs = writeTripClose.mock.calls[0];
    expect(closeArgs[0]).toBe(tripId);
    expect(closeArgs[2]).toBe(endLat);   // end_lat
    expect(closeArgs[3]).toBe(endLng);   // end_lng

    // ended_at > started_at: timestamps must be strictly ordered
    const startedAt = new Date(openEvent.timestamp).getTime();
    const endedAt   = new Date(closeEvent.timestamp).getTime();
    expect(endedAt).toBeGreaterThan(startedAt);
  });

  // ── Property test ──────────────────────────────────────────────────────────

  it('Property 4: for every FALSE→TRUE→FALSE transition writeTripOpen + writeTripClose are paired correctly', async () => {
    /**
     * **Validates: Requirements 4.2, 4.3**
     *
     * Generate arbitrary ignition sequences and verify that for each
     * FALSE → TRUE → FALSE transition:
     *   1. writeTripOpen() is called once per open transition
     *   2. writeTripClose() is called once per close transition
     *   3. The tripId passed to writeTripClose matches what writeTripOpen returned
     *   4. ended_at timestamp > started_at timestamp (monotonic progression)
     *   5. end_lat / end_lng match the position in the close event
     */
    await fc.assert(
      fc.asyncProperty(
        // Generate an ignition sequence with at least one value to avoid empty sequences
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        async (ignitionSeq) => {
          vi.clearAllMocks();
          _tsIdx = 0;

          // Assign a unique device ID per property run to prevent state bleed
          const deviceId = `prop-dev-${crypto.randomUUID()}`;

          // Compute expected trip transitions using the same logic as detectTripBoundary
          const { completedTrips, openCount } = findTripTransitions(ignitionSeq);

          // Assign unique UUIDs for each expected trip open
          const tripIds = Array.from({ length: openCount }, () => crypto.randomUUID());
          let tripOpenCallCount = 0;
          writeTripOpen.mockImplementation(() => {
            const id = tripIds[tripOpenCallCount] ?? crypto.randomUUID();
            tripOpenCallCount++;
            return Promise.resolve(id);
          });

          // Build and dispatch events for the full sequence
          for (let i = 0; i < ignitionSeq.length; i++) {
            const ignition = ignitionSeq[i];
            const lat = 51.0 + i * 0.01;  // unique lat per event
            const lng = -0.1 + i * 0.001; // unique lng per event
            const event = buildEvent({ deviceId, ignition, lat, lng });
            await detectTripBoundary(event);
          }

          // Count actual open/close calls
          const actualOpenCount  = writeTripOpen.mock.calls.length;
          const actualCloseCount = writeTripClose.mock.calls.length;

          // Every expected open should produce exactly one writeTripOpen call
          expect(actualOpenCount).toBe(openCount);
          // Every completed trip should produce one writeTripClose call
          expect(actualCloseCount).toBe(completedTrips.length);

          // For each completed trip, verify the round-trip properties
          for (let t = 0; t < completedTrips.length; t++) {
            const { closeIdx } = completedTrips[t];

            // Find the corresponding open call — it's the t-th open overall
            // (openCount >= completedTrips.length always, since completed ≤ opens)
            const openCall  = writeTripOpen.mock.calls[t];
            const closeCall = writeTripClose.mock.calls[t];

            // Verify tripId round-trip: the tripId returned by writeTripOpen[t]
            // must be passed as first arg to writeTripClose[t]
            expect(closeCall[0]).toBe(tripIds[t]);

            // Verify ended_at > started_at
            const startedAt = new Date(openCall[2]).getTime();
            const endedAt   = new Date(closeCall[1]).getTime();
            expect(endedAt).toBeGreaterThan(startedAt);

            // Verify end_lat / end_lng match the close event's position
            const expectedLat = 51.0 + closeIdx * 0.01;
            const expectedLng = -0.1 + closeIdx * 0.001;
            expect(closeCall[2]).toBeCloseTo(expectedLat, 5);
            expect(closeCall[3]).toBeCloseTo(expectedLng, 5);
          }
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });
});
