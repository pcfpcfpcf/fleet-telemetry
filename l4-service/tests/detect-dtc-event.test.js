/**
 * Unit tests for detectDtcEvent() in consumer.js
 *
 * Tests verify:
 *   - Non-zero DTC IO fields trigger writeDtcEvent() calls
 *   - Absence tracking increments per-device per-code counters
 *   - resolveDtcEvent() is called only after 3 consecutive absences
 *   - The absence counter resets to 0 when a code reappears
 *   - Multiple DTC codes are handled independently per device
 *   - DB errors are caught and do not throw from detectDtcEvent()
 *
 * Requirements: 5.2, 5.4
 *
 * How to run:
 *   npm test -- tests/detect-dtc-event.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock db.js before importing consumer.js ───────────────────────────────────
vi.mock('../src/db.js', () => {
  return {
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
  };
});

// Mock alerts.js — not needed for DTC tests
vi.mock('../src/alerts.js', () => ({
  evaluateAlerts: vi.fn().mockResolvedValue(undefined),
}));

// Mock live-cache.js — not needed for DTC tests
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
import { detectDtcEvent } from '../src/consumer.js';
import { writeDtcEvent, resolveDtcEvent } from '../src/db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal normalised event as returned by normalizeEvent().
 * dtcFields is a partial object of dtc_code_* keys to non-zero values.
 * Any DTC key not listed here will be absent (null) on the event.
 */
function buildEvent({
  deviceId = 'dev-dtc-1',
  dtcFields = {},
  ts = null,
} = {}) {
  return {
    event_id:  crypto.randomUUID(),
    device_id: deviceId,
    timestamp: ts ?? new Date().toISOString(),
    position:  { lat: 51.5, lng: -0.1, altitude: null, accuracy: null, bearing: null, speed: 0 },
    telemetry: { ignition: true, fuel_level: null, odometer: null, rpm: null, engine_load: null },
    // Standard IO fields
    ext_voltage: null, bat_voltage: null, bat_level: null, bat_current: null,
    movement: false, gsm_signal: null, gnss_status: null, gnss_pdop: null, gnss_hdop: null,
    fuel_rate_gps: null, fuel_used_gps: null, axis_x: null, axis_y: null, axis_z: null,
    network_type: null, sleep_mode: null, eco_score: null, trip_odometer: null, buffered: false,
    // DTC fields — only those in dtcFields are non-null
    dtc_code_1: dtcFields.dtc_code_1 ?? null,
    dtc_code_2: dtcFields.dtc_code_2 ?? null,
    dtc_code_3: dtcFields.dtc_code_3 ?? null,
    dtc_code_4: dtcFields.dtc_code_4 ?? null,
    dtc_code_5: dtcFields.dtc_code_5 ?? null,
    dtc_code_6: dtcFields.dtc_code_6 ?? null,
    dtc_code_7: dtcFields.dtc_code_7 ?? null,
    dtc_code_8: dtcFields.dtc_code_8 ?? null,
    dtc_code_9: dtcFields.dtc_code_9 ?? null,
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('detectDtcEvent()', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Active DTC code → writeDtcEvent is called ──────────────────────────────

  it('calls writeDtcEvent when a DTC IO field is non-zero', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;
    const event = buildEvent({ deviceId, dtcFields: { dtc_code_1: 1234 } });

    await detectDtcEvent(event);

    expect(writeDtcEvent).toHaveBeenCalledOnce();
    expect(writeDtcEvent).toHaveBeenCalledWith(
      deviceId,
      event.timestamp,
      'dtc_code_1',
      1234,
      event.event_id,
    );
  });

  it('calls writeDtcEvent for each non-zero DTC field in the same event', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;
    const event = buildEvent({
      deviceId,
      dtcFields: { dtc_code_1: 100, dtc_code_3: 200, dtc_code_7: 300 },
    });

    await detectDtcEvent(event);

    expect(writeDtcEvent).toHaveBeenCalledTimes(3);
    const calledCodes = writeDtcEvent.mock.calls.map(call => call[2]).sort();
    expect(calledCodes).toEqual(['dtc_code_1', 'dtc_code_3', 'dtc_code_7'].sort());
  });

  it('does NOT call writeDtcEvent when all DTC fields are null or zero', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;
    const event = buildEvent({ deviceId, dtcFields: {} });

    await detectDtcEvent(event);

    expect(writeDtcEvent).not.toHaveBeenCalled();
    expect(resolveDtcEvent).not.toHaveBeenCalled();
  });

  it('does NOT call writeDtcEvent for DTC fields explicitly set to 0', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;
    const event = buildEvent({ deviceId, dtcFields: { dtc_code_1: 0 } });
    event.dtc_code_1 = 0; // explicitly zero (not null)

    await detectDtcEvent(event);

    expect(writeDtcEvent).not.toHaveBeenCalled();
  });

  // ── Absence streak → resolveDtcEvent after 3 consecutive absences ──────────

  it('does NOT call resolveDtcEvent after 1 absence', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;

    // Event with active DTC
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 999 } }));
    // One absence
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));

    expect(resolveDtcEvent).not.toHaveBeenCalled();
  });

  it('does NOT call resolveDtcEvent after 2 consecutive absences', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;

    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 999 } }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));

    expect(resolveDtcEvent).not.toHaveBeenCalled();
  });

  it('calls resolveDtcEvent exactly once after 3 consecutive absences', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;

    // Code appears
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 999 } }));
    expect(resolveDtcEvent).not.toHaveBeenCalled();

    // 3 consecutive absences
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} })); // absence 1
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} })); // absence 2
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} })); // absence 3 → resolve

    expect(resolveDtcEvent).toHaveBeenCalledOnce();
    expect(resolveDtcEvent).toHaveBeenCalledWith(deviceId, 'dtc_code_1');
  });

  // ── Reappearance resets the absence counter ────────────────────────────────

  it('resets the absence counter when a code reappears before reaching threshold', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;

    // Code appears
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_2: 42 } }));
    // 2 absences (below threshold)
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    expect(resolveDtcEvent).not.toHaveBeenCalled();

    // Code reappears — counter resets to 0
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_2: 42 } }));
    expect(writeDtcEvent).toHaveBeenCalledTimes(2); // once initially, once on reappearance

    // Now 3 fresh absences are needed to resolve
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} })); // absence 1
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} })); // absence 2
    expect(resolveDtcEvent).not.toHaveBeenCalled();

    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} })); // absence 3 → resolve
    expect(resolveDtcEvent).toHaveBeenCalledOnce();
    expect(resolveDtcEvent).toHaveBeenCalledWith(deviceId, 'dtc_code_2');
  });

  // ── Counter resets to 0 when code reappears after resolve ─────────────────

  it('handles a second DTC occurrence after the first has been resolved', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;

    // First occurrence → 3 absences → resolved
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 10 } }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));

    expect(resolveDtcEvent).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    // Second occurrence — code comes back after resolution
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 20 } }));
    expect(writeDtcEvent).toHaveBeenCalledOnce();
    expect(resolveDtcEvent).not.toHaveBeenCalled();

    // Again 3 absences needed
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));

    expect(resolveDtcEvent).toHaveBeenCalledOnce();
    expect(resolveDtcEvent).toHaveBeenCalledWith(deviceId, 'dtc_code_1');
  });

  // ── Multiple codes tracked independently ──────────────────────────────────

  it('tracks absence streaks independently for different DTC codes', async () => {
    const deviceId = `dev-${crypto.randomUUID()}`;

    // Both codes active
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 1, dtc_code_2: 2 } }));

    // code_1 absent for 3 events; code_2 still present
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_2: 2 } })); // code_1 absence 1
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_2: 2 } })); // code_1 absence 2
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_2: 2 } })); // code_1 absence 3

    // Only code_1 should be resolved; code_2 is still active
    expect(resolveDtcEvent).toHaveBeenCalledOnce();
    expect(resolveDtcEvent).toHaveBeenCalledWith(deviceId, 'dtc_code_1');
  });

  // ── Device isolation ──────────────────────────────────────────────────────

  it('tracks absence streaks independently for different devices', async () => {
    const deviceA = `dev-a-${crypto.randomUUID()}`;
    const deviceB = `dev-b-${crypto.randomUUID()}`;

    // Both devices get the same DTC code
    await detectDtcEvent(buildEvent({ deviceId: deviceA, dtcFields: { dtc_code_1: 99 } }));
    await detectDtcEvent(buildEvent({ deviceId: deviceB, dtcFields: { dtc_code_1: 99 } }));

    // Only device A goes through 3 absences
    await detectDtcEvent(buildEvent({ deviceId: deviceA, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId: deviceA, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId: deviceA, dtcFields: {} }));

    // Only device A should be resolved; device B still has streak = 0
    expect(resolveDtcEvent).toHaveBeenCalledOnce();
    expect(resolveDtcEvent).toHaveBeenCalledWith(deviceA, 'dtc_code_1');
  });

  // ── DB error resilience ───────────────────────────────────────────────────

  it('does not throw if writeDtcEvent rejects', async () => {
    writeDtcEvent.mockRejectedValueOnce(new Error('DB down'));
    const deviceId = `dev-${crypto.randomUUID()}`;

    await expect(
      detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 1 } }))
    ).resolves.toBeUndefined();
  });

  it('does not throw if resolveDtcEvent rejects', async () => {
    resolveDtcEvent.mockRejectedValueOnce(new Error('DB down'));
    const deviceId = `dev-${crypto.randomUUID()}`;

    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 1 } }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));

    await expect(
      detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }))
    ).resolves.toBeUndefined();
  });

  // ── No DTC history at all → resolveDtcEvent never called ──────────────────

  it('never calls resolveDtcEvent for a device with no prior DTC activity', async () => {
    const deviceId = `dev-clean-${crypto.randomUUID()}`;

    // 5 events, never any DTC codes
    for (let i = 0; i < 5; i++) {
      await detectDtcEvent(buildEvent({ deviceId, dtcFields: {} }));
    }

    expect(writeDtcEvent).not.toHaveBeenCalled();
    expect(resolveDtcEvent).not.toHaveBeenCalled();
  });
});
