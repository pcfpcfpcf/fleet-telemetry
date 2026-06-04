/**
 * Property test — Alert Threshold Invariant (Property 6)
 *
 * **Validates: Requirements 8.1, 8.3**
 *
 * Property:
 *   evaluateAlerts() emits `harsh_braking` if and only if axis_x > 3000 AND speed > 20.
 *   evaluateAlerts() emits `battery_low`  if and only if bat_voltage < 3.0.
 *   No alert of those types is emitted for events outside those bounds.
 *
 * How to run:
 *   npm test -- tests/alert-threshold-invariant.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

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
  pool:                  { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// ── Mock live-cache.js ─────────────────────────────────────────────────────────
vi.mock('../src/live-cache.js', () => ({
  cacheSet:       vi.fn(),
  cacheGet:       vi.fn().mockReturnValue(undefined),
  cacheAll:       vi.fn().mockReturnValue([]),
  cacheSize:      vi.fn().mockReturnValue(0),
  cacheSubscribe: vi.fn().mockReturnValue(() => {}),
}));

import { evaluateAlerts } from '../src/alerts.js';
import { writeAlert } from '../src/db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal event with controlled axis_x, speed, and bat_voltage.
 * Uses a unique device ID per call to bypass cooldown state.
 */
function buildEvent({ axisX = null, speed = 0, batVoltage = null } = {}) {
  return {
    event_id:  crypto.randomUUID(),
    device_id: `dev-alert-${crypto.randomUUID()}`, // unique to bypass cooldown
    timestamp: new Date().toISOString(),
    position:  { lat: 51.5, lng: -0.1, altitude: null, accuracy: null, bearing: null, speed },
    telemetry: {
      ignition:    false,
      fuel_level:  null,
      odometer:    null,
      rpm:         null,
      engine_load: null,
      axis_x:      axisX,
      bat_voltage: batVoltage,
    },
    ext_voltage:   null,
    bat_voltage:   batVoltage,
    bat_level:     null,
    bat_current:   null,
    movement:      false,
    gsm_signal:    null,
    gnss_status:   null,
    gnss_pdop:     null,
    gnss_hdop:     null,
    fuel_used_gps: null,
    fuel_rate_gps: null,
    axis_x:        axisX,
    axis_y:        null,
    axis_z:        null,
    network_type:  null,
    sleep_mode:    null,
    eco_score:     null,
    trip_odometer: null,
  };
}

const noop = vi.fn();

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Property 6: Alert Threshold Invariant', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Deterministic regression guards ───────────────────────────────────────

  it('emits harsh_braking when axis_x=3001 and speed=21 (above both thresholds)', async () => {
    const event = buildEvent({ axisX: 3001, speed: 21 });
    await evaluateAlerts(event, noop);

    const hbCalls = writeAlert.mock.calls.filter(c => c[1] === 'harsh_braking');
    expect(hbCalls).toHaveLength(1);
    expect(hbCalls[0][3]).toBe('HIGH');
  });

  it('does NOT emit harsh_braking when axis_x=3000 (exactly at threshold, not above)', async () => {
    const event = buildEvent({ axisX: 3000, speed: 100 });
    await evaluateAlerts(event, noop);

    const hbCalls = writeAlert.mock.calls.filter(c => c[1] === 'harsh_braking');
    expect(hbCalls).toHaveLength(0);
  });

  it('does NOT emit harsh_braking when speed=20 (exactly at threshold, not above)', async () => {
    const event = buildEvent({ axisX: 5000, speed: 20 });
    await evaluateAlerts(event, noop);

    const hbCalls = writeAlert.mock.calls.filter(c => c[1] === 'harsh_braking');
    expect(hbCalls).toHaveLength(0);
  });

  it('emits battery_low when bat_voltage=2.9 (below 3.0 V threshold)', async () => {
    const event = buildEvent({ batVoltage: 2.9 });
    await evaluateAlerts(event, noop);

    const blCalls = writeAlert.mock.calls.filter(c => c[1] === 'battery_low');
    expect(blCalls).toHaveLength(1);
    expect(blCalls[0][3]).toBe('HIGH');
  });

  it('does NOT emit battery_low when bat_voltage=3.0 (at threshold, not below)', async () => {
    const event = buildEvent({ batVoltage: 3.0 });
    await evaluateAlerts(event, noop);

    const blCalls = writeAlert.mock.calls.filter(c => c[1] === 'battery_low');
    expect(blCalls).toHaveLength(0);
  });

  // ── Property test: harsh_braking iff axis_x > 3000 AND speed > 20 ─────────

  it('Property 6 (harsh_braking): emitted iff axis_x > 3000 AND speed > 20', async () => {
    /**
     * **Validates: Requirements 8.1**
     *
     * For all (axis_x, speed) pairs:
     *   harsh_braking is emitted  ↔  (axis_x > 3000 AND speed > 20)
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          axis_x: fc.integer({ min: -10000, max: 10000 }),
          speed:  fc.nat(200),
          // bat_voltage above threshold to avoid confounding battery_low
          bat_voltage: fc.float({ min: 3.0, max: 6.0 }).filter(v => v >= 3.0),
        }),
        async ({ axis_x, speed, bat_voltage }) => {
          vi.clearAllMocks();

          const event = buildEvent({ axisX: axis_x, speed, batVoltage: bat_voltage });
          await evaluateAlerts(event, noop);

          const hbCalls = writeAlert.mock.calls.filter(c => c[1] === 'harsh_braking');
          const shouldEmit = axis_x > 3000 && speed > 20;

          if (shouldEmit) {
            expect(hbCalls.length).toBeGreaterThanOrEqual(1);
            // Severity must be HIGH
            expect(hbCalls[0][3]).toBe('HIGH');
          } else {
            expect(hbCalls).toHaveLength(0);
          }
        }
      ),
      { numRuns: 500, verbose: false }
    );
  });

  // ── Property test: battery_low iff bat_voltage < 3.0 ─────────────────────

  it('Property 6 (battery_low): emitted iff bat_voltage < 3.0', async () => {
    /**
     * **Validates: Requirements 8.3**
     *
     * For all bat_voltage values in [0, 6]:
     *   battery_low is emitted  ↔  bat_voltage < 3.0
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // axis_x and speed both below thresholds to avoid confounding harsh_braking
          axis_x:      fc.integer({ min: -10000, max: 3000 }),
          speed:       fc.nat(20),
          bat_voltage: fc.float({ min: 0, max: 6 }),
        }),
        async ({ axis_x, speed, bat_voltage }) => {
          vi.clearAllMocks();

          const event = buildEvent({ axisX: axis_x, speed, batVoltage: bat_voltage });
          await evaluateAlerts(event, noop);

          const blCalls = writeAlert.mock.calls.filter(c => c[1] === 'battery_low');
          const shouldEmit = bat_voltage < 3.0;

          if (shouldEmit) {
            expect(blCalls.length).toBeGreaterThanOrEqual(1);
            expect(blCalls[0][3]).toBe('HIGH');
          } else {
            expect(blCalls).toHaveLength(0);
          }
        }
      ),
      { numRuns: 500, verbose: false }
    );
  });

  // ── Property test: combined — both thresholds at once ────────────────────

  it('Property 6 (combined): both harsh_braking and battery_low fire independently', async () => {
    /**
     * **Validates: Requirements 8.1, 8.3**
     *
     * When axis_x > 3000 AND speed > 20 AND bat_voltage < 3.0, both alerts fire.
     * When conditions are mixed, only the matching alert fires.
     * Neither alert fires when both conditions are false.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          axis_x:      fc.integer({ min: -10000, max: 10000 }),
          speed:       fc.nat(200),
          bat_voltage: fc.float({ min: 0, max: 6 }),
        }),
        async ({ axis_x, speed, bat_voltage }) => {
          vi.clearAllMocks();

          const event = buildEvent({ axisX: axis_x, speed, batVoltage: bat_voltage });
          await evaluateAlerts(event, noop);

          const hbCalls = writeAlert.mock.calls.filter(c => c[1] === 'harsh_braking');
          const blCalls = writeAlert.mock.calls.filter(c => c[1] === 'battery_low');

          const harshExpected   = axis_x > 3000 && speed > 20;
          const batteryExpected = bat_voltage < 3.0;

          // harsh_braking iff condition
          expect(hbCalls.length > 0).toBe(harshExpected);
          // battery_low iff condition
          expect(blCalls.length > 0).toBe(batteryExpected);

          // No false positives for either alert
          if (!harshExpected) expect(hbCalls).toHaveLength(0);
          if (!batteryExpected) expect(blCalls).toHaveLength(0);
        }
      ),
      { numRuns: 500, verbose: false }
    );
  });
});
