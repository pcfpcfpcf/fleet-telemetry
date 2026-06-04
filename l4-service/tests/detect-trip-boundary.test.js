/**
 * Unit tests for detectTripBoundary() in consumer.js
 *
 * These tests use vi.mock to isolate the DB calls (writeTripOpen / writeTripClose)
 * and verify the trip state transitions, metric accumulation, and fuel-delta
 * logic without requiring a live TimescaleDB connection.
 *
 * Requirements: 4.2, 4.3
 *
 * How to run:
 *   npm test -- tests/detect-trip-boundary.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock db.js before importing consumer.js ───────────────────────────────────
// vi.mock hoisting ensures the mock is in place before any module is resolved.
vi.mock('../src/db.js', () => {
  return {
    writeTelemetry:      vi.fn(),
    writeTelemetryBatch: vi.fn().mockResolvedValue(undefined),
    writeTripOpen:       vi.fn(),
    writeTripClose:      vi.fn().mockResolvedValue(undefined),
    touchDeviceLastSeen: vi.fn().mockResolvedValue(undefined),
    writeAlert:          vi.fn().mockResolvedValue(undefined),
    writeDeviceConfig:   vi.fn().mockResolvedValue(undefined),
    readDeviceConfig:    vi.fn().mockResolvedValue(null),
    writeDriverAssignment: vi.fn().mockResolvedValue(undefined),
    writeDtcEvent:       vi.fn().mockResolvedValue(undefined),
    resolveDtcEvent:     vi.fn().mockResolvedValue(undefined),
    writeAuditLog:       vi.fn().mockResolvedValue(undefined),
    pool:                { query: vi.fn().mockResolvedValue({ rows: [] }) },
  };
});

// Mock alerts.js — not needed for trip boundary tests
vi.mock('../src/alerts.js', () => ({
  evaluateAlerts: vi.fn().mockResolvedValue(undefined),
}));

// Mock live-cache.js — not needed for trip boundary tests
vi.mock('../src/live-cache.js', () => ({
  cacheSet: vi.fn(),
  cacheGet: vi.fn().mockReturnValue(undefined),
  cacheAll: vi.fn().mockReturnValue([]),
}));

// Mock nats — consumer.js imports it for startConsumer
vi.mock('nats', () => ({
  connect:     vi.fn(),
  StringCodec: vi.fn(() => ({ encode: vi.fn(), decode: vi.fn() })),
}));

// ── Import after mocks are set up ─────────────────────────────────────────────
import { detectTripBoundary } from '../src/consumer.js';
import { writeTripOpen, writeTripClose } from '../src/db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _eventCounter = 0;

/**
 * Build a minimal normalised event as returned by normalizeEvent().
 */
function buildEvent({ deviceId = 'dev-1', ignition = false, speed = 0, ecoScore = null, fuelUsedGps = null, ts = null, lat = 51.5, lng = -0.1, tripOdometer = null } = {}) {
  _eventCounter++;
  return {
    event_id:  crypto.randomUUID(),
    device_id: deviceId,
    timestamp: ts ?? new Date(Date.now() + _eventCounter * 1000).toISOString(),
    position:  { lat, lng, altitude: null, accuracy: null, bearing: null, speed },
    telemetry: { ignition, fuel_level: null, odometer: null, rpm: null, engine_load: null },
    eco_score:     ecoScore,
    fuel_used_gps: fuelUsedGps,
    trip_odometer: tripOdometer,
    // Other IO fields not relevant to trip boundary
    ext_voltage: null, bat_voltage: null, bat_level: null, bat_current: null,
    movement: false, gsm_signal: null, gnss_status: null, gnss_pdop: null, gnss_hdop: null,
    fuel_rate_gps: null, axis_x: null, axis_y: null, axis_z: null,
    network_type: null, sleep_mode: null, buffered: false,
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('detectTripBoundary()', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    // Each test gets a unique device ID derived from the test counter so the
    // in-process tripStateByDevice Map never has stale state between tests.
    _eventCounter = Math.floor(Math.random() * 1_000_000);
  });

  // ── First-event guard ───────────────────────────────────────────────────────

  it('opens a trip on the first event when ignition is TRUE', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-first-open-${crypto.randomUUID()}`;
    const event = buildEvent({ deviceId, ignition: true, speed: 50 });

    await detectTripBoundary(event);

    expect(writeTripOpen).toHaveBeenCalledOnce();
    expect(writeTripOpen).toHaveBeenCalledWith(
      deviceId, null, event.timestamp, event.position.lat, event.position.lng
    );
    expect(writeTripClose).not.toHaveBeenCalled();
  });

  it('does NOT open a trip on the first event when ignition is FALSE', async () => {
    const deviceId = `dev-first-off-${crypto.randomUUID()}`;
    const event = buildEvent({ deviceId, ignition: false });

    await detectTripBoundary(event);

    expect(writeTripOpen).not.toHaveBeenCalled();
    expect(writeTripClose).not.toHaveBeenCalled();
  });

  // ── FALSE → TRUE transition ─────────────────────────────────────────────────

  it('opens a trip on FALSE → TRUE ignition transition', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-open-${crypto.randomUUID()}`;

    // Prime with ignition=false
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    expect(writeTripOpen).not.toHaveBeenCalled();

    // Ignition on
    const onEvent = buildEvent({ deviceId, ignition: true, speed: 30 });
    await detectTripBoundary(onEvent);

    expect(writeTripOpen).toHaveBeenCalledOnce();
    expect(writeTripOpen).toHaveBeenCalledWith(
      deviceId, null, onEvent.timestamp, onEvent.position.lat, onEvent.position.lng
    );
    expect(writeTripClose).not.toHaveBeenCalled();
  });

  // ── TRUE → FALSE transition ─────────────────────────────────────────────────

  it('closes a trip on TRUE → FALSE ignition transition', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-close-${crypto.randomUUID()}`;

    // Open trip
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true, speed: 60 }));
    expect(writeTripOpen).toHaveBeenCalledOnce();

    // Close trip
    const offEvent = buildEvent({ deviceId, ignition: false });
    await detectTripBoundary(offEvent);

    expect(writeTripClose).toHaveBeenCalledOnce();
    const closeArgs = writeTripClose.mock.calls[0];
    expect(closeArgs[0]).toBe(tripId);         // tripId
    expect(closeArgs[1]).toBe(offEvent.timestamp); // endedAt
    expect(closeArgs[2]).toBe(offEvent.position.lat);
    expect(closeArgs[3]).toBe(offEvent.position.lng);
  });

  // ── No active trip on ignition-off ──────────────────────────────────────────

  it('does NOT call writeTripClose when ignition goes FALSE with no active trip', async () => {
    const deviceId = `dev-no-trip-${crypto.randomUUID()}`;

    // Two consecutive ignition-off events — no trip should be opened
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));

    expect(writeTripOpen).not.toHaveBeenCalled();
    expect(writeTripClose).not.toHaveBeenCalled();
  });

  // ── No duplicate open ───────────────────────────────────────────────────────

  it('does NOT open a second trip when ignition stays TRUE across consecutive events', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-steady-on-${crypto.randomUUID()}`;

    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true }));

    expect(writeTripOpen).toHaveBeenCalledOnce();
    expect(writeTripClose).not.toHaveBeenCalled();
  });

  // ── maxSpeedKmh accumulation ────────────────────────────────────────────────

  it('flushes maxSpeedKmh from the accumulator into writeTripClose', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-maxspeed-${crypto.randomUUID()}`;

    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  speed: 60 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  speed: 95 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  speed: 80 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: false, speed: 0  }));

    const closeArgs = writeTripClose.mock.calls[0];
    // arg index 6 = maxSpeedKmh
    expect(closeArgs[6]).toBe(95);
  });

  // ── Fuel accumulation ───────────────────────────────────────────────────────

  it('accumulates fuel deltas and flushes totalFuelUsed into writeTripClose', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-fuel-${crypto.randomUUID()}`;

    // Prime the cumulative counter baseline (before ignition-on)
    await detectTripBoundary(buildEvent({ deviceId, ignition: false, fuelUsedGps: 10.0 }));
    // Trip opens; fuelUsedGps counter at 10.0 (delta = 0 vs baseline)
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 10.0 }));
    // +0.3 L delta
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 10.3 }));
    // +0.2 L delta
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 10.5 }));
    // Trip close — total accumulated = 0.3 + 0.2 = 0.5 L (ignition-off event adds 0 delta since same value)
    await detectTripBoundary(buildEvent({ deviceId, ignition: false, fuelUsedGps: 10.5 }));

    const closeArgs = writeTripClose.mock.calls[0];
    // arg index 8 = fuelConsumedLiters
    const fuel = closeArgs[8];
    expect(fuel).toBeCloseTo(0.5, 3);
  });

  // ── Fuel delta — counter reset (delta < 0) ──────────────────────────────────

  it('treats a negative fuel delta (counter reset) as zero', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-fuel-reset-${crypto.randomUUID()}`;

    await detectTripBoundary(buildEvent({ deviceId, ignition: false, fuelUsedGps: 50.0 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 50.0 }));
    // Counter reset — raw value goes back to near-zero
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 0.1  }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: false, fuelUsedGps: 0.2  }));

    const closeArgs = writeTripClose.mock.calls[0];
    // fuelConsumedLiters should be 0.1 (only the 0.1 delta after the reset counts)
    const fuel = closeArgs[8];
    expect(fuel).toBeCloseTo(0.1, 3);
  });

  // ── Fuel delta — sensor noise spike (delta > MAX_REASONABLE_FUEL_DELTA) ─────

  it('discards fuel deltas larger than MAX_REASONABLE_FUEL_DELTA (0.5 L) as sensor noise', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-fuel-spike-${crypto.randomUUID()}`;

    await detectTripBoundary(buildEvent({ deviceId, ignition: false, fuelUsedGps: 10.0 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 10.0 }));
    // Normal delta
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 10.3 }));
    // Spike — delta of 5.0 L should be discarded
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 15.3 }));
    // Normal delta again
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  fuelUsedGps: 15.5 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: false, fuelUsedGps: 15.5 }));

    const closeArgs = writeTripClose.mock.calls[0];
    const fuel = closeArgs[8];
    // Only 0.3 + 0.2 = 0.5 L (the spike is discarded)
    expect(fuel).toBeCloseTo(0.5, 3);
  });

  // ── ecoScore averaging ───────────────────────────────────────────────────────

  it('averages ecoScoreSamples and flushes into writeTripClose', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-eco-${crypto.randomUUID()}`;

    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  ecoScore: 80 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  ecoScore: 60 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true,  ecoScore: 70 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));

    const closeArgs = writeTripClose.mock.calls[0];
    // arg index 9 = ecoScore (average of 80+60+70 = 70)
    expect(closeArgs[9]).toBeCloseTo(70, 1);
  });

  // ── tripOdometer → distanceMeters ───────────────────────────────────────────

  it('passes trip_odometer value as distanceMeters in writeTripClose', async () => {
    const tripId = crypto.randomUUID();
    writeTripOpen.mockResolvedValue(tripId);

    const deviceId = `dev-odo-${crypto.randomUUID()}`;

    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true, tripOdometer: 12345 }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: false, tripOdometer: 15000 }));

    const closeArgs = writeTripClose.mock.calls[0];
    // arg index 4 = distanceMeters — should use the trip_odometer from the close event
    expect(closeArgs[4]).toBe(15000);
  });

  // ── Multiple sequential trips (open → close → open → close) ─────────────────

  it('handles two sequential trips correctly for the same device', async () => {
    const tripId1 = crypto.randomUUID();
    const tripId2 = crypto.randomUUID();
    writeTripOpen
      .mockResolvedValueOnce(tripId1)
      .mockResolvedValueOnce(tripId2);

    const deviceId = `dev-sequential-${crypto.randomUUID()}`;

    // Trip 1
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: true }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));

    // Trip 2
    await detectTripBoundary(buildEvent({ deviceId, ignition: true }));
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));

    expect(writeTripOpen).toHaveBeenCalledTimes(2);
    expect(writeTripClose).toHaveBeenCalledTimes(2);
    expect(writeTripClose.mock.calls[0][0]).toBe(tripId1);
    expect(writeTripClose.mock.calls[1][0]).toBe(tripId2);
  });

  // ── DB error resilience ──────────────────────────────────────────────────────

  it('does not throw if writeTripOpen rejects — subsequent events still processed', async () => {
    writeTripOpen.mockRejectedValueOnce(new Error('DB connection error'));

    const deviceId = `dev-err-${crypto.randomUUID()}`;

    // Should not throw
    await detectTripBoundary(buildEvent({ deviceId, ignition: false }));
    await expect(
      detectTripBoundary(buildEvent({ deviceId, ignition: true }))
    ).resolves.toBeUndefined();

    // Following event should still execute without throwing
    await expect(
      detectTripBoundary(buildEvent({ deviceId, ignition: true }))
    ).resolves.toBeUndefined();
  });

});
