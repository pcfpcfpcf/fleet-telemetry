/**
 * Property test — DTC Detection Round-Trip (Property 11)
 *
 * **Validates: Requirements 5.2, 5.4**
 *
 * Property:
 *   For any non-zero DTC value followed by 3 consecutive events without that code:
 *     - writeDtcEvent() is called exactly once for the active code
 *     - resolveDtcEvent() is called exactly once after 3 consecutive absences
 *     - The resolved device_id and dtc_code match the original write
 *
 * Note: resolveDtcEvent() is called after 3 consecutive absences, not 1.
 *
 * How to run:
 *   npm test -- tests/dtc-detection-round-trip.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Mock db.js before importing consumer.js ───────────────────────────────────
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

import { detectDtcEvent } from '../src/consumer.js';
import { writeDtcEvent, resolveDtcEvent } from '../src/db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal normalised event with the given DTC fields.
 * dtcFields: partial object mapping dtc_code_* keys to non-zero values.
 */
function buildEvent({ deviceId, dtcFields = {} } = {}) {
  return {
    event_id:  crypto.randomUUID(),
    device_id: deviceId,
    timestamp: new Date().toISOString(),
    position:  { lat: 51.5, lng: -0.1, altitude: null, accuracy: null, bearing: null, speed: 0 },
    telemetry: { ignition: true, fuel_level: null, odometer: null, rpm: null, engine_load: null },
    ext_voltage: null, bat_voltage: null, bat_level: null, bat_current: null,
    movement: false, gsm_signal: null, gnss_status: null, gnss_pdop: null, gnss_hdop: null,
    fuel_rate_gps: null, fuel_used_gps: null, axis_x: null, axis_y: null, axis_z: null,
    network_type: null, sleep_mode: null, eco_score: null, trip_odometer: null, buffered: false,
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

describe('Property 11: DTC Detection Round-Trip', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Deterministic regression guards ───────────────────────────────────────

  it('calls writeDtcEvent for a non-zero DTC value', async () => {
    const deviceId = `dev-dtc-base-${crypto.randomUUID()}`;
    const event = buildEvent({ deviceId, dtcFields: { dtc_code_1: 1234 } });
    await detectDtcEvent(event);
    expect(writeDtcEvent).toHaveBeenCalledOnce();
    expect(writeDtcEvent).toHaveBeenCalledWith(
      deviceId, event.timestamp, 'dtc_code_1', 1234, event.event_id
    );
  });

  it('does NOT resolve after 1 or 2 absences, only after 3', async () => {
    const deviceId = `dev-resolve-guard-${crypto.randomUUID()}`;

    await detectDtcEvent(buildEvent({ deviceId, dtcFields: { dtc_code_1: 500 } }));
    await detectDtcEvent(buildEvent({ deviceId })); // absence 1
    expect(resolveDtcEvent).not.toHaveBeenCalled();
    await detectDtcEvent(buildEvent({ deviceId })); // absence 2
    expect(resolveDtcEvent).not.toHaveBeenCalled();
    await detectDtcEvent(buildEvent({ deviceId })); // absence 3 → resolve
    expect(resolveDtcEvent).toHaveBeenCalledOnce();
    expect(resolveDtcEvent).toHaveBeenCalledWith(deviceId, 'dtc_code_1');
  });

  // ── Property test ──────────────────────────────────────────────────────────

  it('Property 11: non-zero DTC → 3 absences produces exactly one write then one resolve', async () => {
    /**
     * **Validates: Requirements 5.2, 5.4**
     *
     * Generate arbitrary (dtc_value, device_id) pairs and verify that:
     *   1. A single non-zero DTC event results in exactly one writeDtcEvent call
     *   2. Exactly 2 absence events do NOT trigger resolveDtcEvent
     *   3. A 3rd absence event triggers exactly one resolveDtcEvent call
     *   4. The device_id and dtc_code in the resolve call match the write call
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // dtc_value must be non-zero (avoid 0 since that means "no DTC")
          dtc_value: fc.nat({ max: 65535 }).filter(v => v > 0),
          // device_id must be a non-empty string
          device_id: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
        }),
        async ({ dtc_value, device_id }) => {
          vi.clearAllMocks();

          // Use a unique device per run to avoid state bleed from dtcAbsenceCount map
          const deviceId = `prop-${device_id}-${crypto.randomUUID()}`;

          // ── Phase 1: active DTC event ──────────────────────────────────────
          const activeEvent = buildEvent({
            deviceId,
            dtcFields: { dtc_code_1: dtc_value },
          });
          await detectDtcEvent(activeEvent);

          // Exactly one write for the active DTC
          expect(writeDtcEvent).toHaveBeenCalledTimes(1);
          expect(writeDtcEvent).toHaveBeenCalledWith(
            deviceId,
            activeEvent.timestamp,
            'dtc_code_1',
            dtc_value,
            activeEvent.event_id,
          );
          // No resolve yet
          expect(resolveDtcEvent).not.toHaveBeenCalled();

          // ── Phase 2: 2 absence events — still not resolved ─────────────────
          await detectDtcEvent(buildEvent({ deviceId })); // absence 1
          expect(resolveDtcEvent).not.toHaveBeenCalled();

          await detectDtcEvent(buildEvent({ deviceId })); // absence 2
          expect(resolveDtcEvent).not.toHaveBeenCalled();

          // ── Phase 3: 3rd absence — must trigger exactly one resolve ─────────
          await detectDtcEvent(buildEvent({ deviceId })); // absence 3

          expect(resolveDtcEvent).toHaveBeenCalledTimes(1);
          expect(resolveDtcEvent).toHaveBeenCalledWith(deviceId, 'dtc_code_1');

          // Total: still exactly one writeDtcEvent call (no spurious extra calls)
          expect(writeDtcEvent).toHaveBeenCalledTimes(1);
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });

  it('Property 11 (multi-code): each DTC code resolves independently after 3 absences', async () => {
    /**
     * **Validates: Requirements 5.2, 5.4**
     *
     * When multiple DTC codes are active, each one resolves independently.
     * Generate a set of 2–5 non-zero values and verify per-code resolution.
     */
    await fc.assert(
      fc.asyncProperty(
        // Generate 2 distinct non-zero DTC values
        fc.tuple(
          fc.nat({ max: 65535 }).filter(v => v > 0),
          fc.nat({ max: 65535 }).filter(v => v > 0),
        ).filter(([a, b]) => a !== b),
        async ([dtcVal1, dtcVal2]) => {
          vi.clearAllMocks();
          const deviceId = `prop-multi-${crypto.randomUUID()}`;

          // Both codes active simultaneously
          await detectDtcEvent(buildEvent({
            deviceId,
            dtcFields: { dtc_code_1: dtcVal1, dtc_code_2: dtcVal2 },
          }));

          expect(writeDtcEvent).toHaveBeenCalledTimes(2);
          expect(resolveDtcEvent).not.toHaveBeenCalled();

          // 3 absences for both codes
          for (let i = 0; i < 3; i++) {
            await detectDtcEvent(buildEvent({ deviceId }));
          }

          // Both codes should be resolved exactly once each
          expect(resolveDtcEvent).toHaveBeenCalledTimes(2);
          const resolvedCodes = resolveDtcEvent.mock.calls.map(c => c[1]).sort();
          expect(resolvedCodes).toEqual(['dtc_code_1', 'dtc_code_2'].sort());
        }
      ),
      { numRuns: 50, verbose: false }
    );
  });
});
