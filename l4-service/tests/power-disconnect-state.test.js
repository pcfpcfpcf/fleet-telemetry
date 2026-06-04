/**
 * Property test — Power Disconnect State Transition (Property 7)
 *
 * **Validates: Requirements 8.4**
 *
 * Property:
 *   evaluateAlerts() emits `power_disconnect` (CRITICAL) if and only if
 *   the first ext_voltage > 11.0 V AND the second (consecutive) ext_voltage < 7.0 V.
 *   No emission for all other voltage pairs.
 *
 * How to run:
 *   npm test -- tests/power-disconnect-state.test.js
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
 * Build a minimal event with a specific ext_voltage.
 * Each device_id is unique so power_disconnect state maps don't bleed between tests.
 * Within a single test, reuse the same deviceId to simulate consecutive events.
 */
function buildEvent({ deviceId, extVoltage }) {
  return {
    event_id:  crypto.randomUUID(),
    device_id: deviceId,
    timestamp: new Date().toISOString(),
    position:  { lat: 51.5, lng: -0.1, altitude: null, accuracy: null, bearing: null, speed: 0 },
    telemetry: {
      ignition:    false,
      fuel_level:  null,
      odometer:    null,
      rpm:         null,
      engine_load: null,
      ext_voltage: extVoltage,
    },
    ext_voltage:   extVoltage,
    bat_voltage:   3.5,   // above low-battery threshold to avoid confounding alerts
    bat_level:     null,
    bat_current:   null,
    movement:      false,
    gsm_signal:    null,
    gnss_status:   null,
    gnss_pdop:     null,
    gnss_hdop:     null,
    fuel_used_gps: null,
    fuel_rate_gps: null,
    axis_x:        null,
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

describe('Property 7: Power Disconnect State Transition', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Deterministic regression guards ───────────────────────────────────────

  it('emits power_disconnect when first=12.0 V (>11.0) and second=6.0 V (<7.0)', async () => {
    const deviceId = `dev-pd-${crypto.randomUUID()}`;
    const broadcast = vi.fn();

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 12.0 }), broadcast);
    vi.clearAllMocks();

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 6.0 }), broadcast);

    const pdCalls = writeAlert.mock.calls.filter(c => c[1] === 'power_disconnect');
    expect(pdCalls).toHaveLength(1);
    expect(pdCalls[0][3]).toBe('CRITICAL');

    const broadcastCalls = broadcast.mock.calls.filter(c => c[0].alert_type === 'power_disconnect');
    expect(broadcastCalls).toHaveLength(1);
  });

  it('does NOT emit power_disconnect when first=12.0 V and second=7.0 V (exactly at lower bound)', async () => {
    const deviceId = `dev-pd-exact-${crypto.randomUUID()}`;

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 12.0 }), noop);
    vi.clearAllMocks();

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 7.0 }), noop);

    const pdCalls = writeAlert.mock.calls.filter(c => c[1] === 'power_disconnect');
    expect(pdCalls).toHaveLength(0);
  });

  it('does NOT emit power_disconnect when first=11.0 V (exactly at upper bound)', async () => {
    const deviceId = `dev-pd-upper-exact-${crypto.randomUUID()}`;

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 11.0 }), noop);
    vi.clearAllMocks();

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 0.0 }), noop);

    const pdCalls = writeAlert.mock.calls.filter(c => c[1] === 'power_disconnect');
    expect(pdCalls).toHaveLength(0);
  });

  it('does NOT emit power_disconnect when both voltages are above 11.0 V', async () => {
    const deviceId = `dev-pd-both-high-${crypto.randomUUID()}`;

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 14.0 }), noop);
    vi.clearAllMocks();

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 12.0 }), noop);

    const pdCalls = writeAlert.mock.calls.filter(c => c[1] === 'power_disconnect');
    expect(pdCalls).toHaveLength(0);
  });

  it('does NOT emit power_disconnect when both voltages are below 7.0 V', async () => {
    const deviceId = `dev-pd-both-low-${crypto.randomUUID()}`;

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 3.0 }), noop);
    vi.clearAllMocks();

    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 1.0 }), noop);

    const pdCalls = writeAlert.mock.calls.filter(c => c[1] === 'power_disconnect');
    expect(pdCalls).toHaveLength(0);
  });

  it('does NOT re-emit power_disconnect when already active (state persists until recovery)', async () => {
    const deviceId = `dev-pd-no-repeat-${crypto.randomUUID()}`;

    // First disconnect
    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 13.0 }), noop);
    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 4.0 }), noop); // fires once

    vi.clearAllMocks();

    // Second drop — should NOT fire again while state is active
    await evaluateAlerts(buildEvent({ deviceId, extVoltage: 2.0 }), noop);

    const pdCalls = writeAlert.mock.calls.filter(c => c[1] === 'power_disconnect');
    expect(pdCalls).toHaveLength(0);
  });

  // ── Property test ──────────────────────────────────────────────────────────

  it('Property 7: power_disconnect fires iff first > 11.0 AND second < 7.0', async () => {
    /**
     * **Validates: Requirements 8.4**
     *
     * For all consecutive ext_voltage pairs (first, second) in [0, 36]:
     *   power_disconnect fires  ↔  (first > 11.0 AND second < 7.0)
     */
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.float({ min: 0, max: 36 }),
          fc.float({ min: 0, max: 36 }),
        ),
        async ([firstVoltage, secondVoltage]) => {
          vi.clearAllMocks();

          // Unique device per property run to avoid state bleed across runs
          const deviceId = `prop-pd-${crypto.randomUUID()}`;

          // First event — establishes the previous ext_voltage in the alerts.js map
          await evaluateAlerts(buildEvent({ deviceId, extVoltage: firstVoltage }), noop);
          // Clear any alerts fired during the first event (e.g. bat_voltage or other alerts)
          vi.clearAllMocks();

          // Second event — this is where power_disconnect should (or should not) fire
          await evaluateAlerts(buildEvent({ deviceId, extVoltage: secondVoltage }), noop);

          const pdCalls = writeAlert.mock.calls.filter(c => c[1] === 'power_disconnect');
          const shouldEmit = firstVoltage > 11.0 && secondVoltage < 7.0;

          if (shouldEmit) {
            expect(pdCalls.length).toBeGreaterThanOrEqual(1);
            expect(pdCalls[0][3]).toBe('CRITICAL');
          } else {
            expect(pdCalls).toHaveLength(0);
          }
        }
      ),
      { numRuns: 500, verbose: false }
    );
  });

  it('Property 7 (no emission on first event alone): first event never fires power_disconnect', async () => {
    /**
     * **Validates: Requirements 8.4**
     *
     * The first event for a device cannot trigger power_disconnect because there
     * is no previous voltage to compare against.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: 0, max: 36 }),
        async (voltage) => {
          vi.clearAllMocks();
          const deviceId = `prop-pd-first-${crypto.randomUUID()}`;

          await evaluateAlerts(buildEvent({ deviceId, extVoltage: voltage }), noop);

          const pdCalls = writeAlert.mock.calls.filter(c => c[1] === 'power_disconnect');
          // First event: no prior voltage → cannot fire
          expect(pdCalls).toHaveLength(0);
        }
      ),
      { numRuns: 200, verbose: false }
    );
  });
});
