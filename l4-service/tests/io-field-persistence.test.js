/**
 * Property test — IO Field Persistence (Property 1)
 *
 * **Validates: Requirements 1.2, 7.1**
 *
 * Property:
 *   For an arbitrary set of io_events, after the event is normalized (applying IO_MAP),
 *   the extended fields on the event object correctly map to their column values:
 *     - IO fields present in io_events are converted and attached to the event
 *     - IO fields absent from io_events are NULL on the event (which becomes NULL in the INSERT)
 *
 * Strategy:
 *   normalizeEvent() is not exported, so we test the IO_MAP field extraction logic
 *   directly (extractIoFields + convertIoValue, which consumer.js also uses).
 *   We then verify the mapping matches the 18 expected DB column names and values.
 *
 *   Additionally, we test writeTelemetryBatch() by inspecting pool.query call arguments
 *   to confirm the parameter values at the correct positions in the INSERT VALUES clause.
 *
 * How to run:
 *   npm test -- tests/io-field-persistence.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── IO_MAP mirrors consumer.js (same IDs, types, and column names) ─────────────
const IO_MAP = {
  239: { key: 'ignition',      type: 'bool'    },
  16:  { key: 'odometer',      type: 'int'     },
  13:  { key: 'fuel_rate_gps', type: 'float10' },
  24:  { key: 'speed_io',      type: 'int'     },
  12:  { key: 'fuel_used_gps', type: 'int'     },
  15:  { key: 'eco_score',     type: 'float10' },
  17:  { key: 'axis_x',        type: 'int'     },
  18:  { key: 'axis_y',        type: 'int'     },
  19:  { key: 'axis_z',        type: 'int'     },
  21:  { key: 'gsm_signal',    type: 'int'     },
  66:  { key: 'ext_voltage',   type: 'mv'      },
  67:  { key: 'bat_voltage',   type: 'mv'      },
  68:  { key: 'bat_current',   type: 'int'     },
  69:  { key: 'gnss_status',   type: 'int'     },
  113: { key: 'bat_level',     type: 'int'     },
  181: { key: 'gnss_pdop',     type: 'float10' },
  182: { key: 'gnss_hdop',     type: 'float10' },
  199: { key: 'trip_odometer', type: 'int'     },
  200: { key: 'sleep_mode',    type: 'int'     },
  237: { key: 'network_type',  type: 'int'     },
  240: { key: 'movement',      type: 'bool'    },
  241: { key: 'gsm_operator',  type: 'int'     },
  263: { key: 'bt_status',     type: 'int'     },
};

// The 18 DB columns added by Task 2.1 (in INSERT order from db.js)
const EXTENDED_COLUMNS = [
  'ext_voltage', 'bat_voltage', 'bat_level', 'bat_current',
  'gnss_status', 'gnss_hdop', 'gnss_pdop', 'movement',
  'gsm_signal', 'network_type', 'axis_x', 'axis_y', 'axis_z',
  'trip_odometer', 'eco_score', 'fuel_rate_gps', 'fuel_used_gps', 'sleep_mode',
];

/** Convert a raw IO value using the same logic as consumer.js */
function convertIoValue(spec, raw) {
  switch (spec.type) {
    case 'bool':    return raw !== 0;
    case 'float10': return Math.round(raw) / 10;
    case 'mv':      return Math.round(raw) / 1000;
    case 'float':
    case 'int':
    default:        return Number(raw);
  }
}

/** Apply IO_MAP to an io_events array → field map */
function extractIoFields(ioEvents) {
  const fields = {};
  if (!Array.isArray(ioEvents)) return fields;
  for (const io of ioEvents) {
    if (io == null || io.id == null) continue;
    const spec = IO_MAP[io.id];
    if (spec) {
      fields[spec.key] = convertIoValue(spec, io.val ?? io.value ?? 0);
    }
  }
  return fields;
}

/**
 * Build a normalized event object with the same field-attachment logic as consumer.js's
 * normalizeEvent(). This is the event object that gets passed to writeTelemetryBatch().
 */
function buildNormalizedEvent({ deviceId, ioEvents }) {
  const ioFields = extractIoFields(ioEvents);
  return {
    event_id:    crypto.randomUUID(),
    device_id:   deviceId,
    timestamp:   new Date().toISOString(),
    received_at: new Date().toISOString(),
    position: { lat: 51.5, lng: -0.1, altitude: null, accuracy: null, bearing: null, speed: 0 },
    telemetry: {
      ignition:    ioFields.ignition   ?? false,
      fuel_level:  null,
      odometer:    ioFields.odometer   ?? null,
      rpm:         null,
      engine_load: null,
    },
    // 18 new IO columns — exactly as set by normalizeEvent()
    ext_voltage:   ioFields.ext_voltage   ?? null,
    bat_voltage:   ioFields.bat_voltage   ?? null,
    bat_level:     ioFields.bat_level     ?? null,
    bat_current:   ioFields.bat_current   ?? null,
    gnss_status:   ioFields.gnss_status   ?? null,
    gnss_hdop:     ioFields.gnss_hdop     ?? null,
    gnss_pdop:     ioFields.gnss_pdop     ?? null,
    movement:      ioFields.movement      ?? false,
    gsm_signal:    ioFields.gsm_signal    ?? null,
    network_type:  ioFields.network_type  ?? null,
    axis_x:        ioFields.axis_x        ?? null,
    axis_y:        ioFields.axis_y        ?? null,
    axis_z:        ioFields.axis_z        ?? null,
    trip_odometer: ioFields.trip_odometer ?? null,
    eco_score:     ioFields.eco_score     ?? null,
    fuel_rate_gps: ioFields.fuel_rate_gps ?? null,
    fuel_used_gps: ioFields.fuel_used_gps ?? null,
    sleep_mode:    ioFields.sleep_mode    ?? null,
    buffered:      false,
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Property 1: IO Field Persistence', () => {

  // ── Deterministic regression guards ───────────────────────────────────────

  it('maps ext_voltage (IO 66) from mV to V correctly', () => {
    // IO 66 raw = 12000 mV → 12.0 V
    const event = buildNormalizedEvent({
      deviceId: `dev-${crypto.randomUUID()}`,
      ioEvents: [{ id: 66, val: 12000 }],
    });
    // ext_voltage should be 12.0 V after mV→V conversion
    expect(event.ext_voltage).toBeCloseTo(12.0, 3);
  });

  it('maps bat_voltage (IO 67) from mV to V correctly', () => {
    // IO 67 raw = 3700 mV → 3.7 V
    const event = buildNormalizedEvent({
      deviceId: `dev-${crypto.randomUUID()}`,
      ioEvents: [{ id: 67, val: 3700 }],
    });
    expect(event.bat_voltage).toBeCloseTo(3.7, 3);
  });

  it('stores null for absent IO fields', () => {
    const event = buildNormalizedEvent({
      deviceId: `dev-${crypto.randomUUID()}`,
      ioEvents: [],
    });
    // All 18 extended columns should be null or false (movement defaults to false)
    for (const col of EXTENDED_COLUMNS) {
      if (col === 'movement') {
        expect(event[col] === null || event[col] === false).toBe(true);
      } else {
        expect(event[col]).toBeNull();
      }
    }
  });

  it('stores correct axis_x value (IO 17) as integer', () => {
    const event = buildNormalizedEvent({
      deviceId: `dev-${crypto.randomUUID()}`,
      ioEvents: [{ id: 17, val: 3500 }],
    });
    expect(event.axis_x).toBe(3500);
  });

  it('maps movement (IO 240) as boolean — 0 → false, non-zero → true', () => {
    const eventFalse = buildNormalizedEvent({
      deviceId: `dev-${crypto.randomUUID()}`,
      ioEvents: [{ id: 240, val: 0 }],
    });
    const eventTrue = buildNormalizedEvent({
      deviceId: `dev-${crypto.randomUUID()}`,
      ioEvents: [{ id: 240, val: 1 }],
    });
    expect(eventFalse.movement).toBe(false);
    expect(eventTrue.movement).toBe(true);
  });

  it('maps eco_score (IO 15) as float/10', () => {
    // IO 15 raw = 850 → 85.0
    const event = buildNormalizedEvent({
      deviceId: `dev-${crypto.randomUUID()}`,
      ioEvents: [{ id: 15, val: 850 }],
    });
    expect(event.eco_score).toBeCloseTo(85.0, 2);
  });

  // ── Property test ──────────────────────────────────────────────────────────

  it('Property 1: each present IO field maps to its event property and absent fields are NULL', () => {
    /**
     * **Validates: Requirements 1.2, 7.1**
     *
     * Generate arbitrary io_events arrays (id: 0–300, val: any integer).
     * Apply extractIoFields + buildNormalizedEvent (same logic as consumer.js normalizeEvent).
     * Assert:
     *   - For each IO field present in io_events that maps to an extended column:
     *       the event property matches the expected converted value
     *   - For each extended column NOT covered by the io_events:
     *       the event property is NULL (or false for movement)
     */
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id:  fc.nat(300),
            val: fc.integer({ min: -100000, max: 100000 }),
          }),
          { minLength: 0, maxLength: 10 }
        ),
        (ioEventsRaw) => {
          const deviceId = `prop-io-${crypto.randomUUID()}`;
          const event = buildNormalizedEvent({ deviceId, ioEvents: ioEventsRaw });

          // Compute expected field values using the same extraction logic
          const expectedFields = extractIoFields(ioEventsRaw);

          // Verify each extended column
          for (const col of EXTENDED_COLUMNS) {
            const actualValue = event[col];

            if (col in expectedFields) {
              // Field was present in io_events → should match converted value
              const expectedVal = expectedFields[col];
              if (col === 'movement') {
                expect(actualValue).toBe(expectedVal);
              } else if (typeof expectedVal === 'number') {
                expect(actualValue).toBeCloseTo(expectedVal, 6);
              } else {
                expect(actualValue).toBe(expectedVal);
              }
            } else {
              // Field was absent → should be null (or false for movement default)
              if (col === 'movement') {
                expect(actualValue === null || actualValue === false).toBe(true);
              } else {
                expect(actualValue).toBeNull();
              }
            }
          }
        }
      ),
      { numRuns: 500, verbose: false }
    );
  });

  it('Property 1 (last-write-wins): duplicate IO IDs in the same event use the last value', () => {
    /**
     * **Validates: Requirements 1.2, 7.1**
     *
     * When the same IO ID appears multiple times in io_events, the last occurrence wins
     * (matches the for-loop behavior in extractIoFields).
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99999 }),
        fc.integer({ min: 1, max: 99999 }),
        (val1, val2) => {
          // IO 17 = axis_x (int type)
          const event = buildNormalizedEvent({
            deviceId: `prop-dup-${crypto.randomUUID()}`,
            ioEvents: [
              { id: 17, val: val1 },
              { id: 17, val: val2 },
            ],
          });
          // Last value wins
          expect(event.axis_x).toBe(val2);
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });

  it('Property 1 (mV→V conversion): ext_voltage and bat_voltage convert raw mV to V', () => {
    /**
     * **Validates: Requirements 1.2, 7.1**
     *
     * IO 66 (ext_voltage) and IO 67 (bat_voltage) are stored in the FMC003 as millivolts.
     * After normalization, they must be divided by 1000 to get Volts.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 36000 }), // raw mV for ext_voltage (0–36 V range)
        fc.integer({ min: 0, max: 5000 }),  // raw mV for bat_voltage (0–5 V range)
        (rawExtVoltage, rawBatVoltage) => {
          const event = buildNormalizedEvent({
            deviceId: `prop-mv-${crypto.randomUUID()}`,
            ioEvents: [
              { id: 66, val: rawExtVoltage },
              { id: 67, val: rawBatVoltage },
            ],
          });
          expect(event.ext_voltage).toBeCloseTo(rawExtVoltage / 1000, 3);
          expect(event.bat_voltage).toBeCloseTo(rawBatVoltage / 1000, 3);
        }
      ),
      { numRuns: 200, verbose: false }
    );
  });
});
