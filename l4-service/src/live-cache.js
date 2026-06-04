/**
 * live-cache.js
 *
 * In-process cache of the latest telemetry state per device.
 * Populated synchronously on every NATS message before the DB write.
 * The dashboard summary endpoint reads from this cache — no DB round-trip
 * for live data. DB is still the source of truth for history.
 *
 * Source-of-truth contract (Requirements 10.4, 11.1–11.4):
 *   - SSE `summary` events are the SOLE source for fleet-level aggregates
 *     (total_vehicles, ignition_on, avg_bat_voltage, low_battery_count,
 *     offline_count, unacknowledged_alerts).
 *   - WebSocket `telemetry` events are the SOLE source for per-vehicle
 *     position and field updates.
 *   - The frontend MUST NOT merge fleet-level counters from WebSocket
 *     telemetry events, and MUST NOT update per-vehicle positions from SSE
 *     summary events — this prevents conflicting update races.
 */

/** @type {Map<string, object>} device_id → latest normalised event */
const _store = new Map();

/** @type {Set<(event: object) => void>} listeners notified on every update */
const _listeners = new Set();

/**
 * Upsert a normalised telemetry event into the cache.
 * Notifies all registered listeners synchronously.
 */
export function cacheSet(event) {
  _store.set(event.device_id, event);
  for (const fn of _listeners) {
    try { fn(event); } catch { /* never let a listener crash the pipeline */ }
  }
}

/** Return the latest state for a single device, or undefined. */
export function cacheGet(deviceId) {
  return _store.get(deviceId);
}

/** Return all latest states as an array. */
export function cacheAll() {
  return Array.from(_store.values());
}

/** Return total number of tracked devices. */
export function cacheSize() {
  return _store.size;
}

/**
 * Subscribe to real-time updates.
 * The callback is called with the full normalised event immediately after
 * it is written to the cache (before the DB insert completes).
 * Returns an unsubscribe function.
 */
export function cacheSubscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Compute a fleet-wide summary from the live cache.
 * All aggregation happens here — never in the frontend.
 *
 * Extended fields (Requirements 10.4, 11.1–11.4):
 *   - avg_bat_voltage         — mean across all cached vehicles with non-null bat_voltage
 *   - low_battery_count       — count of vehicles where bat_voltage < 3.0 V
 *   - offline_count           — count of vehicles where last event age > 600 s
 *   - unacknowledged_alerts   — injected from the in-memory counter maintained by alerts.js;
 *                               callers must pass this value explicitly so live-cache.js
 *                               remains free of any alerts.js import (avoids circular deps).
 *
 * @param {number} staleThresholdMs   Age in ms above which a device is "stale" (default 15 min)
 * @param {number} offlineThresholdMs Age in ms above which a device is "offline" (default 600 s)
 * @param {number} unacknowledgedAlerts  Open alert count from alerts.js (default 0)
 */
export function buildLiveSummary(
  staleThresholdMs = 15 * 60 * 1000,
  offlineThresholdMs = 600 * 1000,
  unacknowledgedAlerts = 0,
) {
  const vehicles = cacheAll();
  const now = Date.now();

  let ignitionOn = 0;
  let ignitionOff = 0;
  let moving = 0;
  let totalSpeed = 0;
  let speedCount = 0;
  let totalFuel = 0;
  let fuelCount = 0;
  let lowFuel = 0;
  let overspeed = 0;
  let gpsValid = 0;
  let fresh = 0;
  let stale = 0;
  let buffered = 0;

  // Extended summary counters (Requirements 10.4, 11.4)
  let totalBatVoltage = 0;
  let batVoltageCount = 0;
  let lowBatteryCount = 0;
  let offlineCount = 0;

  // Per-vehicle summaries for the live vehicle list
  const vehicleList = vehicles.map(v => {
    const ts = v.timestamp ? Date.parse(v.timestamp) : 0;
    const age = now - ts;
    const isStale = age > staleThresholdMs;
    const isOffline = age > offlineThresholdMs;
    const speed = v.position?.speed ?? v.speed ?? 0;
    const fuel = v.telemetry?.fuel_level ?? v.fuel_level ?? null;
    const ign = v.telemetry?.ignition ?? v.ignition ?? false;
    const lat = v.position?.lat ?? v.lat ?? null;
    const lng = v.position?.lng ?? v.lng ?? null;
    // Extended live-cache fields (Requirement 11.1 — all 14 new fields)
    const extVoltage = v.ext_voltage ?? null;
    const batVoltage = v.bat_voltage ?? null;
    const batLevel = v.bat_level ?? null;
    const batCurrent = v.bat_current ?? null;
    const movement = v.movement ?? false;
    const gsmSignal = v.gsm_signal ?? null;
    const gnssStatus = v.gnss_status ?? null;
    const gnssHdop = v.gnss_hdop ?? null;
    const gnssPdop = v.gnss_pdop ?? null;
    const networkType = v.network_type ?? null;
    const axisX = v.axis_x ?? null;
    const axisY = v.axis_y ?? null;
    const axisZ = v.axis_z ?? null;
    const tripOdometer = v.trip_odometer ?? null;
    const ecoScore = v.eco_score ?? null;
    const fuelRateGps = v.fuel_rate_gps ?? null;
    const fuelUsedGps = v.fuel_used_gps ?? null;
    const sleepMode = v.sleep_mode ?? null;
    const odometer = v.telemetry?.odometer ?? v.odometer ?? null;

    if (ign) ignitionOn++; else ignitionOff++;
    if (movement) moving++;
    if (speed > 0) { totalSpeed += speed; speedCount++; }
    if (fuel != null) { totalFuel += fuel; fuelCount++; if (fuel < 15) lowFuel++; }
    if (speed > 120) overspeed++;
    if (lat != null && lng != null) gpsValid++;
    if (isStale) stale++; else fresh++;
    if (v.buffered) buffered++;

    // Extended summary aggregation
    if (batVoltage != null) {
      totalBatVoltage += batVoltage;
      batVoltageCount++;
      if (batVoltage < 3.0) lowBatteryCount++;
    }
    if (isOffline) offlineCount++;

    return {
      device_id: v.device_id,
      timestamp: v.timestamp,
      received_at: v.received_at,
      lat, lng,
      altitude: v.position?.altitude ?? v.altitude ?? null,
      bearing: v.position?.bearing ?? v.bearing ?? null,
      speed,
      ignition: ign,
      fuel_level: fuel,
      odometer,
      trip_odometer: tripOdometer,
      movement,
      // Extended fields (Requirement 11.1 — all 14 new fields)
      ext_voltage: extVoltage,
      bat_voltage: batVoltage,
      bat_level: batLevel,
      bat_current: batCurrent,
      gsm_signal: gsmSignal,
      gnss_status: gnssStatus,
      gnss_hdop: gnssHdop,
      gnss_pdop: gnssPdop,
      network_type: networkType,
      axis_x: axisX,
      axis_y: axisY,
      axis_z: axisZ,
      eco_score: ecoScore,
      fuel_rate_gps: fuelRateGps,
      fuel_used_gps: fuelUsedGps,
      sleep_mode: sleepMode,
      buffered: Boolean(v.buffered),
      stale: isStale,
      offline: isOffline,
      age_seconds: Math.round(age / 1000),
    };
  });

  const avgBatVoltage = batVoltageCount > 0
    ? Math.round((totalBatVoltage / batVoltageCount) * 1000) / 1000
    : null;

  return {
    as_of: new Date().toISOString(),
    total_vehicles: vehicles.length,
    ignition_on: ignitionOn,
    ignition_off: ignitionOff,
    moving,
    low_fuel: lowFuel,
    overspeed,
    buffered,
    gps_valid: gpsValid,
    gps_invalid: vehicles.length - gpsValid,
    fresh,
    stale,
    avg_speed: speedCount > 0 ? Math.round((totalSpeed / speedCount) * 10) / 10 : 0,
    avg_fuel: fuelCount > 0 ? Math.round((totalFuel / fuelCount) * 10) / 10 : null,
    // Extended fleet-level aggregates (Requirements 10.4, 11.4)
    avg_bat_voltage: avgBatVoltage,
    low_battery_count: lowBatteryCount,
    offline_count: offlineCount,
    unacknowledged_alerts: unacknowledgedAlerts,
    vehicles: vehicleList,
  };
}
