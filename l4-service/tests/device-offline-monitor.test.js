/**
 * Unit tests for device_offline heartbeat detection — startOfflineMonitor() and
 * the recovery path inside evaluateAlerts().
 *
 * Tests verify:
 *   - device_offline alert fires for a device whose last event age > 600 s and
 *     whose cached ignition is TRUE
 *   - device_offline does NOT fire for a device whose last event age ≤ 600 s
 *   - device_offline does NOT fire for a device whose cached ignition is FALSE
 *   - Once the offline cooldown is active, the alert is NOT re-emitted on the
 *     next sweep (Requirement 8.10)
 *   - The offline cooldown is cleared when a recovery event arrives via
 *     evaluateAlerts(), allowing a future alert to fire again
 *
 * Requirements: 8.5, 8.10
 *
 * How to run:
 *   npm test -- tests/device-offline-monitor.test.js
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
  pool:                  { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// ── live-cache.js is partially mocked so we can control what cacheAll() returns
// while leaving the real module's other exports intact for evaluateAlerts() calls
// that inspect event fields.
const mockCacheEntries = [];
vi.mock('../src/live-cache.js', () => ({
  cacheSet: vi.fn(),
  cacheGet: vi.fn().mockReturnValue(undefined),
  cacheAll: vi.fn(() => [...mockCacheEntries]),
  cacheSize: vi.fn().mockReturnValue(0),
  cacheSubscribe: vi.fn().mockReturnValue(() => {}),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { startOfflineMonitor, evaluateAlerts } from '../src/alerts.js';
import { writeAlert } from '../src/db.js';
import { cacheAll } from '../src/live-cache.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** ISO timestamp N seconds in the past */
function tsSecondsAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

/**
 * Build a minimal cache entry as stored in live-cache (output of cacheSet).
 * @param {string} deviceId
 * @param {boolean} ignition   last known ignition state
 * @param {number}  ageSeconds how many seconds ago the last event arrived
 */
function buildCacheEntry({ deviceId = 'device-test', ignition = true, ageSeconds = 700 } = {}) {
  return {
    device_id: deviceId,
    timestamp: tsSecondsAgo(ageSeconds),
    received_at: tsSecondsAgo(ageSeconds),
    position:  { lat: 51.5, lng: -0.1, altitude: null, bearing: null, speed: 0 },
    telemetry: { ignition, fuel_level: null, odometer: null },
    ext_voltage: null,
    bat_voltage: null,
    movement: false,
  };
}

/**
 * Build a minimal normalised event (for evaluateAlerts recovery tests).
 */
function buildEvent({ deviceId = 'device-test', ignition = true } = {}) {
  return {
    event_id:  crypto.randomUUID(),
    device_id: deviceId,
    timestamp: new Date().toISOString(),
    position:  { lat: 51.5, lng: -0.1, altitude: null, bearing: null, speed: 0 },
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

/**
 * Run one sweep of the offline monitor by manually invoking the interval callback.
 * We do this by starting the monitor with a very long interval then immediately
 * invoking the callback via fake timers.
 *
 * Simpler approach: extract the sweep logic via fake timers.
 */
async function runOneSweep(broadcast) {
  vi.useFakeTimers();
  const handle = startOfflineMonitor(broadcast);
  // Advance 60 s to trigger the first sweep
  await vi.advanceTimersByTimeAsync(60_000);
  clearInterval(handle);
  vi.useRealTimers();
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('device_offline heartbeat monitor', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the cache entries before each test
    mockCacheEntries.length = 0;
  });

  // ── Alert fires for a stale device with ignition ON ──────────────────────

  it('emits device_offline when last event age > 600 s and ignition is TRUE', async () => {
    const deviceId = `dev-offline-${crypto.randomUUID()}`;
    const broadcast = vi.fn();
    mockCacheEntries.push(buildCacheEntry({ deviceId, ignition: true, ageSeconds: 700 }));

    await runOneSweep(broadcast);

    expect(writeAlert).toHaveBeenCalledOnce();
    const [calledDevice, alertType, _payload, severity] = writeAlert.mock.calls[0];
    expect(calledDevice).toBe(deviceId);
    expect(alertType).toBe('device_offline');
    expect(severity).toBe('HIGH');

    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'alert',
      alert_type: 'device_offline',
      device_id: deviceId,
    });
  });

  // ── Alert does NOT fire for a fresh device ─────────────────────────────────

  it('does NOT emit device_offline when last event age ≤ 600 s', async () => {
    const deviceId = `dev-fresh-${crypto.randomUUID()}`;
    const broadcast = vi.fn();
    mockCacheEntries.push(buildCacheEntry({ deviceId, ignition: true, ageSeconds: 500 }));

    await runOneSweep(broadcast);

    expect(writeAlert).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  // ── Alert does NOT fire when ignition is FALSE ─────────────────────────────

  it('does NOT emit device_offline when cached ignition is FALSE', async () => {
    const deviceId = `dev-ignoff-${crypto.randomUUID()}`;
    const broadcast = vi.fn();
    mockCacheEntries.push(buildCacheEntry({ deviceId, ignition: false, ageSeconds: 700 }));

    await runOneSweep(broadcast);

    expect(writeAlert).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  // ── Cooldown prevents re-emission on subsequent sweeps (Req 8.10) ──────────

  it('does NOT re-emit device_offline on the second sweep (cooldown active)', async () => {
    const deviceId = `dev-cooldown-${crypto.randomUUID()}`;
    const broadcast = vi.fn();
    mockCacheEntries.push(buildCacheEntry({ deviceId, ignition: true, ageSeconds: 700 }));

    vi.useFakeTimers();
    const handle = startOfflineMonitor(broadcast);

    // First sweep — alert should fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeAlert).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();

    vi.clearAllMocks();

    // Second sweep — cooldown still active; should NOT fire again
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeAlert).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();

    clearInterval(handle);
    vi.useRealTimers();
  });

  // ── Recovery clears the cooldown so the alert can fire again ──────────────

  it('clears the offline cooldown when a recovery event arrives via evaluateAlerts()', async () => {
    const deviceId = `dev-recovery-${crypto.randomUUID()}`;
    const broadcast = vi.fn();
    mockCacheEntries.push(buildCacheEntry({ deviceId, ignition: true, ageSeconds: 700 }));

    // First sweep — alert fires and cooldown activates
    await runOneSweep(broadcast);
    expect(writeAlert).toHaveBeenCalledOnce();

    vi.clearAllMocks();

    // Device recovers — evaluateAlerts() is called with a fresh event
    const recoveryEvent = buildEvent({ deviceId, ignition: true });
    await evaluateAlerts(recoveryEvent, broadcast);

    // Now remove the stale entry and add a fresh one to simulate recovery
    mockCacheEntries.length = 0;
    mockCacheEntries.push(buildCacheEntry({ deviceId, ignition: true, ageSeconds: 700 }));

    // Second sweep — cooldown was cleared on recovery, so alert should fire again
    await runOneSweep(broadcast);

    // writeAlert may have been called for other reasons in evaluateAlerts;
    // check specifically for device_offline
    const offlineCalls = writeAlert.mock.calls.filter(c => c[1] === 'device_offline');
    expect(offlineCalls).toHaveLength(1);
  });

  // ── Multiple devices are handled independently ────────────────────────────

  it('handles multiple devices independently in the same sweep', async () => {
    const devOnline  = `dev-online-${crypto.randomUUID()}`;
    const devOffline = `dev-offline-${crypto.randomUUID()}`;
    const broadcast = vi.fn();

    mockCacheEntries.push(buildCacheEntry({ deviceId: devOnline,  ignition: true, ageSeconds: 300 }));
    mockCacheEntries.push(buildCacheEntry({ deviceId: devOffline, ignition: true, ageSeconds: 700 }));

    await runOneSweep(broadcast);

    expect(writeAlert).toHaveBeenCalledOnce();
    expect(writeAlert.mock.calls[0][0]).toBe(devOffline);
    expect(writeAlert.mock.calls[0][1]).toBe('device_offline');
  });

  // ── DB error during writeAlert rolls back the active flag ─────────────────

  it('rolls back the offline active flag if writeAlert throws', async () => {
    const deviceId = `dev-dberr-${crypto.randomUUID()}`;
    const broadcast = vi.fn();
    mockCacheEntries.push(buildCacheEntry({ deviceId, ignition: true, ageSeconds: 700 }));

    // First sweep: writeAlert throws
    writeAlert.mockRejectedValueOnce(new Error('DB down'));
    await runOneSweep(broadcast);

    // broadcast should NOT have been called (alert was not persisted)
    expect(broadcast).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // Second sweep: DB is back — alert should fire now (flag was rolled back)
    await runOneSweep(broadcast);
    expect(writeAlert).toHaveBeenCalledOnce();
  });

  // ── Empty cache produces no alerts ────────────────────────────────────────

  it('produces no alerts when the live cache is empty', async () => {
    const broadcast = vi.fn();
    // mockCacheEntries is empty

    await runOneSweep(broadcast);

    expect(writeAlert).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
