import { writeAlert as _writeAlert, pool } from './db.js';
import { cacheAll } from './live-cache.js';

/**
 * Wrapper around db.writeAlert that also increments the in-memory
 * unacknowledged alert counter (Requirements 10.4, 11.4).
 */
async function writeAlert(deviceId, type, payload, severity) {
  await _writeAlert(deviceId, type, payload, severity);
  incrementUnacknowledgedAlertCount();
}

const SPEED_LIMIT_KMH = 120;
const IGNITION_IDLE_SEC = 300;
const LOW_FUEL_PERCENT = 15;
const IGNITION_ANOMALY_SPEED_KMH = 10;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

// Alert-specific cooldowns (ms)
const HARSH_EVENT_COOLDOWN_MS   = 60 * 1000;   // 60 s — Requirements 8.1, 8.2
const BATTERY_LOW_COOLDOWN_MS   = 300 * 1000;  // 300 s — Requirement 8.3
const GEOFENCE_COOLDOWN_MS      = 300 * 1000;  // 300 s — Requirements 8.6, 8.7

// ─── DB-backed geofence cache (Requirements 9.1–9.4, 9.7) ────────────────────
//
// geofenceCache is a Map<deviceId, GeofenceEntry[]> where each GeofenceEntry is:
//   {
//     geofenceId : string,
//     name       : string,
//     ring       : [lng, lat][]  — GeoJSON coordinate array (RFC 7946 §3.1.1)
//     bbox       : { minLng, maxLng, minLat, maxLat }  — pre-computed AABB
//   }
//
// The GeoJSON spec (RFC 7946 §3.1.1) stores coordinates as [longitude, latitude].
// All internal calls use pointInPolygon(lat, lng, ring) where:
//   ring[i] = [xi, yi]  with  xi = lng  and  yi = lat.
// This ordering is enforced by the destructure  const [xi, yi] = ring[i]  inside
// pointInPolygon(), and is the authoritative convention for every caller in this file.
//
// The module-level reference is replaced atomically on NOTIFY fleet_geofence_change
// (see setupGeofenceListener) so that concurrent evaluateAlerts() calls never see
// a partially-populated map.

/** @type {Map<string, Array<{geofenceId:string,name:string,ring:number[][],bbox:{minLng:number,maxLng:number,minLat:number,maxLat:number}}>>} */
let geofenceCache = new Map(); // device_id → geofence entries

// Per-device last-known inside/outside state per geofence (for enter/exit edge detection).
// Key: `${deviceId}:${geofenceId}`, value: boolean (true = inside).
const geofenceState = new Map();

// ─── pointInPolygon ───────────────────────────────────────────────────────────
/**
 * Returns true if the point (lat, lng) lies inside the GeoJSON Polygon ring.
 *
 * COORDINATE ORDER (GeoJSON RFC 7946 §3.1.1):
 *   ring is an array of [longitude, latitude] pairs — i.e. [lng, lat].
 *   Destructure as:
 *     const [xi, yi] = ring[i];   // xi = lng, yi = lat
 *   Do NOT swap — the argument order to this function is (lat, lng) to match
 *   the conventional "lat/lng" call site style, but the ring array is [lng, lat].
 *
 * Uses the standard ray-casting algorithm (Jordan curve theorem).
 * Pure and stateless — safe to call from any context.
 *
 * @param {number}   lat  — geographic latitude  of the test point
 * @param {number}   lng  — geographic longitude of the test point
 * @param {number[][]} ring — GeoJSON exterior ring: array of [lng, lat] pairs
 * @returns {boolean}
 */
export function pointInPolygon(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; // xi = lng, yi = lat  (GeoJSON [lng, lat] order)
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ─── buildGeofenceCache ───────────────────────────────────────────────────────
/**
 * Constructs a fresh geofence cache Map from database rows.
 * Computes the axis-aligned bounding box (AABB) for each geofence at build time
 * so the O(1) bbox pre-filter in evaluateAlerts() requires no per-event geometry.
 *
 * @param {Array<{geofence_id:string, name:string, polygon:string, device_id:string}>} rows
 * @returns {Map<string, Array>}
 */
export function buildGeofenceCache(rows) {
  const cache = new Map();
  for (const row of rows) {
    let ring;
    try {
      const geojson = typeof row.polygon === 'string' ? JSON.parse(row.polygon) : row.polygon;
      // Support both Polygon and MultiPolygon; use the first ring of the first polygon.
      if (geojson.type === 'Polygon') {
        ring = geojson.coordinates[0];
      } else if (geojson.type === 'MultiPolygon') {
        ring = geojson.coordinates[0][0];
      } else {
        console.warn(`[geofence] unsupported geometry type=${geojson.type} geofence_id=${row.geofence_id}`);
        continue;
      }
    } catch (err) {
      console.error(`[geofence] JSON parse error geofence_id=${row.geofence_id}:`, err.message);
      continue;
    }

    // Compute axis-aligned bounding box from the ring.
    // ring[i] = [lng, lat] per GeoJSON spec.
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [xi, yi] of ring) { // xi = lng, yi = lat
      if (xi < minLng) minLng = xi;
      if (xi > maxLng) maxLng = xi;
      if (yi < minLat) minLat = yi;
      if (yi > maxLat) maxLat = yi;
    }
    const bbox = { minLng, maxLng, minLat, maxLat };

    const entry = { geofenceId: row.geofence_id, name: row.name, ring, bbox };

    if (!cache.has(row.device_id)) {
      cache.set(row.device_id, []);
    }
    cache.get(row.device_id).push(entry);
  }
  return cache;
}

// ─── loadGeofences ────────────────────────────────────────────────────────────
/**
 * Loads all geofences and their device assignments from TimescaleDB and replaces
 * the module-level geofenceCache atomically.
 *
 * Called at startup (from index.js) and again whenever a `fleet_geofence_change`
 * NOTIFY arrives on the pg LISTEN channel.  The new map is constructed entirely
 * before the assignment so evaluateAlerts() never observes a half-populated state.
 *
 * Requirements: 9.1, 9.2
 *
 * @returns {Promise<void>}
 */
export async function loadGeofences() {
  try {
    const { rows } = await pool.query(`
      SELECT g.geofence_id, g.name, g.polygon, ga.device_id
      FROM   geofences g
      JOIN   geofence_assignments ga USING (geofence_id)
    `);
    const newCache = buildGeofenceCache(rows);
    // Atomic single-assignment — replaces the old reference in one operation.
    geofenceCache = newCache;
    console.log(`[L4] geofence cache loaded: ${rows.length} assignment(s) across ${newCache.size} device(s)`);
  } catch (err) {
    console.error('[L4] loadGeofences failed:', err.message);
  }
}

// ─── setupGeofenceListener ────────────────────────────────────────────────────
/**
 * Opens a dedicated pg client that LISTENs on the `fleet_geofence_change` channel.
 * On notification, schedules a geofence cache reload within 5 s (Requirement 9.2).
 *
 * The listener client is kept separate from the pool so LISTEN/NOTIFY does not
 * interfere with the pool's connection lifecycle.
 *
 * @returns {Promise<void>}
 */
export async function setupGeofenceListener() {
  // Import pg Client dynamically to avoid circular dependency issues at module load
  const pgModule = await import('pg');
  const { Client } = pgModule.default ?? pgModule;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query('LISTEN fleet_geofence_change');
    console.log('[L4] Listening on channel fleet_geofence_change');

    client.on('notification', (msg) => {
      console.log(`[L4] fleet_geofence_change NOTIFY received: ${msg.payload ?? ''}`);
      // Reload within 5 s as required (Requirement 9.2).
      // A short random jitter avoids thundering-herd if multiple instances restart simultaneously.
      const delayMs = Math.floor(Math.random() * 2000) + 500; // 0.5–2.5 s
      setTimeout(() => {
        loadGeofences().catch(err =>
          console.error('[L4] geofence reload after NOTIFY failed:', err.message)
        );
      }, delayMs);
    });

    client.on('error', (err) => {
      console.error('[L4] Geofence listener pg error:', err.message);
    });
  } catch (err) {
    console.error('[L4] setupGeofenceListener failed to connect:', err.message);
  }
}

// ─── seedAlertStateFromDb ─────────────────────────────────────────────────────
/**
 * Re-seed all in-memory alert maps from TimescaleDB at service startup.
 *
 * Called from index.js AFTER loadGeofences() and BEFORE startConsumer() so that
 * the geofence cache is available for computing inside/outside state from the
 * last known device positions.
 *
 * Seeds the following maps:
 *  1. lastExtVoltage       — from the most recent `ext_voltage` telemetry row per device
 *  2. offlineActive        — from recent unacknowledged `device_offline` alerts (< 600 s old)
 *  3. geofenceState        — from the last known position per device vs loaded geofence polygons
 *  4. tripStateByDevice    — from active trips via seedTripState() in consumer.js
 *
 * After seeding, logs a WARN listing any devices whose offline state could not be
 * confirmed (devices in the live cache with ignition=TRUE but no recent alert record).
 *
 * Requirements: 8.4, 8.5, 8.6, 8.7, 8.10
 *
 * @returns {Promise<void>}
 */
export async function seedAlertStateFromDb() {
  console.log('[L4] seedAlertStateFromDb: re-seeding alert state from DB...');

  // ── 1. Re-seed lastExtVoltage per device ──────────────────────────────────
  // Query the most recent ext_voltage reading per device from telemetry history.
  // This allows power_disconnect detection to correctly compare consecutive voltage
  // values even when the service restarts mid-monitoring cycle.
  try {
    const { rows: voltageRows } = await pool.query(`
      SELECT DISTINCT ON (device_id)
        device_id,
        ext_voltage
      FROM telemetry
      WHERE ext_voltage IS NOT NULL
      ORDER BY device_id, timestamp DESC
    `);

    for (const row of voltageRows) {
      if (row.ext_voltage != null) {
        boundedSet(lastExtVoltage, row.device_id, row.ext_voltage);
      }
    }
    console.log(`[L4] seedAlertStateFromDb: seeded lastExtVoltage for ${voltageRows.length} device(s)`);
  } catch (err) {
    console.error('[L4] seedAlertStateFromDb: failed to seed lastExtVoltage:', err.message);
  }

  // ── 2. Re-seed offlineActive from recent device_offline alerts ────────────
  // Skip re-emitting the offline alert if the most recent device_offline alert
  // for the device is already unacknowledged AND was fired < 600 s ago.
  // This prevents a flood of duplicate offline alerts immediately after restart.
  const OFFLINE_COOLDOWN_S = 600;
  const unconfirmedOfflineDevices = [];  // devices we cannot confirm offline state for

  try {
    const { rows: offlineAlertRows } = await pool.query(`
      SELECT DISTINCT ON (device_id)
        device_id,
        timestamp,
        acknowledged
      FROM alerts
      WHERE alert_type = 'device_offline'
      ORDER BY device_id, timestamp DESC
    `);

    for (const row of offlineAlertRows) {
      const alertAgeSeconds = (Date.now() - Date.parse(row.timestamp)) / 1000;
      if (!row.acknowledged && alertAgeSeconds < OFFLINE_COOLDOWN_S) {
        // Recent unacknowledged offline alert — restore the cooldown flag
        boundedSet(offlineActive, row.device_id, true);
        console.log(
          `[L4] seedAlertStateFromDb: restored device_offline cooldown device=${row.device_id}` +
          ` alert_age=${Math.round(alertAgeSeconds)}s`
        );
      }
    }
    console.log(`[L4] seedAlertStateFromDb: seeded offlineActive for ${offlineActive.size} device(s)`);
  } catch (err) {
    console.error('[L4] seedAlertStateFromDb: failed to seed offlineActive:', err.message);
  }

  // ── 3. Re-seed geofenceState from last known device positions ─────────────
  // Evaluate each device's last known position against the loaded geofence polygons
  // so that geofence_enter / geofence_exit alerts do not misfire on restart.
  // Requires geofenceCache to be populated (loadGeofences() must run first).
  try {
    const { rows: positionRows } = await pool.query(`
      SELECT DISTINCT ON (device_id)
        device_id,
        lat,
        lng
      FROM telemetry
      WHERE lat IS NOT NULL AND lng IS NOT NULL
      ORDER BY device_id, timestamp DESC
    `);

    let seededGeofenceCount = 0;
    for (const row of positionRows) {
      const { device_id, lat, lng } = row;
      if (lat == null || lng == null) continue;

      const assigned = geofenceCache.get(device_id) ?? [];
      for (const fence of assigned) {
        const stateKey = `${device_id}:${fence.geofenceId}`;
        const { bbox, ring } = fence;

        // Bounding-box pre-filter (same logic as evaluateAlerts)
        const inBbox =
          lng >= bbox.minLng && lng <= bbox.maxLng &&
          lat >= bbox.minLat && lat <= bbox.maxLat;
        const isInside = inBbox && pointInPolygon(lat, lng, ring);

        geofenceState.set(stateKey, isInside);
        seededGeofenceCount++;
      }
    }
    console.log(
      `[L4] seedAlertStateFromDb: seeded geofenceState for ${seededGeofenceCount} device-geofence pair(s)` +
      ` across ${positionRows.length} device(s)`
    );
  } catch (err) {
    console.error('[L4] seedAlertStateFromDb: failed to seed geofenceState:', err.message);
  }

  // ── 4. Recover active trips and re-seed tripStateByDevice ─────────────────
  // Query all trips that were open at the time of shutdown. Reconstruct the
  // live-cache accumulator with zeroed metrics (MVP recovery). The trip remains
  // closeable on the next ignition-OFF event.
  try {
    const { rows: activeTripRows } = await pool.query(`
      SELECT trip_id, device_id, started_at, start_lat, start_lng, driver_id
      FROM trips
      WHERE status = 'active'
    `);

    if (activeTripRows.length > 0) {
      // Dynamic import to avoid a circular ESM dependency:
      //   alerts.js → consumer.js → alerts.js
      // seedTripState is only needed here, at runtime after both modules are loaded.
      const { seedTripState } = await import('./consumer.js');
      seedTripState(activeTripRows);
      console.log(`[L4] seedAlertStateFromDb: recovered ${activeTripRows.length} active trip(s)`);
    } else {
      console.log('[L4] seedAlertStateFromDb: no active trips to recover');
    }
  } catch (err) {
    console.error('[L4] seedAlertStateFromDb: failed to recover active trips:', err.message);
  }

  // ── 5. Warm-up window warning ─────────────────────────────────────────────
  // Devices with ignition=TRUE in the live cache but WITHOUT a confirmed offline
  // cooldown entry may have gone dark during the restart window. List them in a
  // WARN so operators know their offline detection may be delayed by up to one
  // OFFLINE_SWEEP_INTERVAL_MS (60 s) for those devices.
  try {
    const { rows: ignOnRows } = await pool.query(`
      SELECT DISTINCT ON (device_id)
        device_id,
        ignition,
        timestamp
      FROM telemetry
      WHERE ignition = TRUE
      ORDER BY device_id, timestamp DESC
    `);

    for (const row of ignOnRows) {
      const ageSeconds = (Date.now() - Date.parse(row.timestamp)) / 1000;
      // Only warn about devices that haven't had an event recently
      // (i.e. within the offline threshold) and have no confirmed cooldown
      if (ageSeconds > OFFLINE_COOLDOWN_S && !offlineActive.get(row.device_id)) {
        unconfirmedOfflineDevices.push(row.device_id);
      }
    }
  } catch (err) {
    console.error('[L4] seedAlertStateFromDb: failed to check warm-up window:', err.message);
  }

  if (unconfirmedOfflineDevices.length > 0) {
    console.warn(
      `WARN [L4] seedAlertStateFromDb: restart warm-up window — offline state could not be confirmed` +
      ` for ${unconfirmedOfflineDevices.length} device(s): ${unconfirmedOfflineDevices.join(', ')}.` +
      ' Offline detection will resume on the next heartbeat sweep (up to 60 s delay).'
    );
  }

  console.log('[L4] seedAlertStateFromDb: complete');
}

// ─── Unacknowledged alert counter (Requirements 10.4, 11.4) ──────────────────
// Tracks the in-memory count of open (unacknowledged) alerts fired this session.
// This is an approximation — it counts alerts emitted since service start and
// decrements on acknowledgement via acknowledgeAlert() called from api.js.
// The SSE summary event includes this counter so the frontend can display the
// open alert badge without a DB round-trip.
let _unacknowledgedAlertCount = 0;

/**
 * Returns the current in-memory count of unacknowledged alerts.
 * Used by api.js to inject the value into buildLiveSummary().
 * @returns {number}
 */
export function getUnacknowledgedAlertCount() {
  return _unacknowledgedAlertCount;
}

/**
 * Increment the in-memory unacknowledged alert counter.
 * Called by evaluateAlerts() each time a new alert is written to the DB.
 */
export function incrementUnacknowledgedAlertCount() {
  _unacknowledgedAlertCount++;
}

/**
 * Decrement the in-memory unacknowledged alert counter (floor at 0).
 * Called by api.js when PATCH /api/alerts/:id/acknowledge is processed.
 */
export function decrementUnacknowledgedAlertCount() {
  if (_unacknowledgedAlertCount > 0) _unacknowledgedAlertCount--;
}


const HARSH_SPEED_KMH = 20;           // km/h — speed must exceed this value
const BAT_LOW_VOLTAGE = 3.0;          // V
const POWER_DISCONNECT_HIGH_V = 11.0; // V — previous ext_voltage must exceed this
const POWER_DISCONNECT_LOW_V = 7.0;   // V — current ext_voltage must be below this

// ─── FIX 1: bounded in-memory maps ───────────────────────────────────────────
// Original maps grew forever with unique device IDs (memory leak under load).
// Capped at 10,000 entries each with oldest-first eviction — matches consumer.js.
const MAX_TRACKED_DEVICES = 10_000;

const idleTimers = new Map();
const lastAlertAt = new Map();

// Per-device last known ext_voltage — used by power_disconnect detection (Req 8.4).
// Bounded to MAX_TRACKED_DEVICES with oldest-first eviction, same pattern as above.
const lastExtVoltage = new Map();

// Per-device power_disconnect active state — tracks whether a power_disconnect alert
// is currently active for a device.  The cooldown does NOT reset on repeated events;
// it only clears when ext_voltage recovers above POWER_DISCONNECT_LOW_V (Req 8.4).
const powerDisconnectActive = new Map();

// ─── device_offline cooldown map (Requirement 8.5, 8.10) ─────────────────────
// Tracks which devices are currently in the offline state.
// Once a device_offline alert fires, it is NOT re-emitted until the device
// recovers (sends a new event), at which point the entry is deleted.
// Bounded to MAX_TRACKED_DEVICES with oldest-first eviction.
const offlineActive = new Map(); // device_id → true (offline cooldown active)

// Heartbeat sweep interval (ms) — checked every 60 s per Requirement 8.5
const OFFLINE_SWEEP_INTERVAL_MS = 60 * 1000;
// Age threshold: device is considered offline if last event age > 600 s (Req 8.5)
const OFFLINE_THRESHOLD_MS = 600 * 1000;

function boundedSet(map, key, value) {
  if (!map.has(key) && map.size >= MAX_TRACKED_DEVICES) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

function shouldEmitAlert(deviceId, alertType, tsMs, cooldownMs = ALERT_COOLDOWN_MS) {
  const key = `${deviceId}:${alertType}`;
  const lastTs = lastAlertAt.get(key) || 0;
  if (tsMs - lastTs < cooldownMs) {
    return false;
  }
  // ─── FIX 1 applied: use bounded setter ───────────────────────────────────
  boundedSet(lastAlertAt, key, tsMs);
  return true;
}

export async function evaluateAlerts(event, broadcast) {
  const { device_id, position, telemetry } = event;
  const speed = position?.speed ?? 0;
  const ignition = telemetry?.ignition ?? false;

  // ─── device_offline recovery (Requirements 8.5, 8.10) ────────────────────
  // When a device resumes sending events, clear its offline cooldown so the
  // alert can fire again if the device goes dark a second time.
  if (offlineActive.has(device_id)) {
    offlineActive.delete(device_id);
    console.log(`[L4] device_offline cleared (recovery) device=${device_id}`);
  }
  const fuelLevel = telemetry?.fuel_level;
  const lat = position?.lat;
  const lng = position?.lng;
  const eventTsMs = Date.parse(event.timestamp) || Date.now();

  // ─── harsh_braking (Requirement 8.1) ─────────────────────────────────────
  // Emit HIGH alert when axis_x > 3000 mg (deceleration) AND speed > 20 km/h.
  const axisX = telemetry?.axis_x ?? event.axis_x ?? null;
  if (
    axisX != null &&
    axisX > HARSH_AXIS_X_THRESHOLD &&
    speed > HARSH_SPEED_KMH &&
    shouldEmitAlert(device_id, 'harsh_braking', eventTsMs, HARSH_EVENT_COOLDOWN_MS)
  ) {
    const alert = {
      device_id,
      axis_x: axisX,
      speed,
      ts: event.timestamp,
    };
    await writeAlert(device_id, 'harsh_braking', alert, 'HIGH');
    broadcast({ type: 'alert', alert_type: 'harsh_braking', ...alert });
  }

  // ─── harsh_acceleration (Requirement 8.2) ────────────────────────────────
  // Emit MEDIUM alert when axis_x > 3000 mg (acceleration context) AND speed > 20 km/h.
  // Uses same axis_x threshold as harsh_braking — the acceleration context is determined
  // by the positive axis_x value (forward decel/accel axis on FMC003).
  if (
    axisX != null &&
    axisX > HARSH_AXIS_X_THRESHOLD &&
    speed > HARSH_SPEED_KMH &&
    shouldEmitAlert(device_id, 'harsh_acceleration', eventTsMs, HARSH_EVENT_COOLDOWN_MS)
  ) {
    const alert = {
      device_id,
      axis_x: axisX,
      speed,
      ts: event.timestamp,
    };
    await writeAlert(device_id, 'harsh_acceleration', alert, 'MEDIUM');
    broadcast({ type: 'alert', alert_type: 'harsh_acceleration', ...alert });
  }

  // ─── battery_low (Requirement 8.3) ───────────────────────────────────────
  // Emit HIGH alert when bat_voltage drops below 3.0 V.
  const batVoltage = telemetry?.bat_voltage ?? event.bat_voltage ?? null;
  if (
    batVoltage != null &&
    batVoltage < BAT_LOW_VOLTAGE &&
    shouldEmitAlert(device_id, 'battery_low', eventTsMs, BATTERY_LOW_COOLDOWN_MS)
  ) {
    const alert = {
      device_id,
      bat_voltage: batVoltage,
      threshold: BAT_LOW_VOLTAGE,
      ts: event.timestamp,
    };
    await writeAlert(device_id, 'battery_low', alert, 'HIGH');
    broadcast({ type: 'alert', alert_type: 'battery_low', ...alert });
  }

  if (speed > SPEED_LIMIT_KMH && shouldEmitAlert(device_id, 'speed_threshold', eventTsMs)) {
    const alert = {
      device_id,
      speed,
      limit: SPEED_LIMIT_KMH,
      ts: event.timestamp,
    };
    await writeAlert(device_id, 'speed_threshold', alert, 'WARNING');
    broadcast({ type: 'alert', alert_type: 'speed_threshold', ...alert });
  }

  if (ignition && speed === 0) {
    if (!idleTimers.has(device_id)) {
      // ─── FIX 1 applied: use bounded setter ─────────────────────────────────
      boundedSet(idleTimers, device_id, eventTsMs);
    } else {
      const idleSec = (eventTsMs - idleTimers.get(device_id)) / 1000;
      if (idleSec >= IGNITION_IDLE_SEC && shouldEmitAlert(device_id, 'ignition_idle', eventTsMs)) {
        const alert = {
          device_id,
          idle_seconds: Math.round(idleSec),
          ts: event.timestamp,
        };
        await writeAlert(device_id, 'ignition_idle', alert, 'INFO');
        broadcast({ type: 'alert', alert_type: 'ignition_idle', ...alert });
        // Reset idle timer after alert fires
        boundedSet(idleTimers, device_id, eventTsMs);
      }
    }
  } else {
    idleTimers.delete(device_id);
  }

  if (
    fuelLevel != null &&
    fuelLevel < LOW_FUEL_PERCENT &&
    shouldEmitAlert(device_id, 'fuel_low', eventTsMs)
  ) {
    const alert = {
      device_id,
      fuel_level: fuelLevel,
      threshold: LOW_FUEL_PERCENT,
      ts: event.timestamp,
    };
    await writeAlert(device_id, 'fuel_low', alert, 'WARNING');
    broadcast({ type: 'alert', alert_type: 'fuel_low', ...alert });
  }

  if (
    !ignition &&
    speed > IGNITION_ANOMALY_SPEED_KMH &&
    shouldEmitAlert(device_id, 'ignition_anomaly', eventTsMs)
  ) {
    const alert = {
      device_id,
      speed,
      ignition,
      ts: event.timestamp,
    };
    await writeAlert(device_id, 'ignition_anomaly', alert, 'CRITICAL');
    broadcast({ type: 'alert', alert_type: 'ignition_anomaly', ...alert });
  }

  // ─── geofence_exit / geofence_enter (Requirements 8.6, 8.7, 9.1–9.4, 9.7) ──
  //
  // Evaluate the vehicle position against every geofence assigned to this device.
  // Two-stage evaluation for performance:
  //   1. Bounding-box pre-filter (O(1)): skip pointInPolygon entirely when the
  //      vehicle position lies outside the geofence's axis-aligned bounding box.
  //      The bbox is pre-computed at cache-load time by buildGeofenceCache().
  //   2. Ray-casting pointInPolygon for positions that pass the bbox check.
  //
  // All calls use: pointInPolygon(lat, lng, ring)
  //   ring[i] = [xi, yi]  where  xi = lng, yi = lat  (GeoJSON [lng, lat] order).
  //
  // State transitions are tracked per (deviceId, geofenceId) in geofenceState:
  //   undefined → inside : first event lands inside   → no edge alert (no prior state)
  //   undefined → outside: first event lands outside  → no edge alert (no prior state)
  //   inside    → outside: geofence_exit  (severity MEDIUM, cooldown 300 s)
  //   outside   → inside : geofence_enter (severity LOW,    cooldown 300 s)
  if (lat != null && lng != null) {
    const assigned = geofenceCache.get(device_id) ?? [];
    for (const fence of assigned) {
      const stateKey = `${device_id}:${fence.geofenceId}`;
      const { bbox, ring } = fence;

      // ── Bounding-box pre-filter ──────────────────────────────────────────
      // minLng ≤ lng ≤ maxLng  AND  minLat ≤ lat ≤ maxLat
      const inBbox =
        lng >= bbox.minLng && lng <= bbox.maxLng &&
        lat >= bbox.minLat && lat <= bbox.maxLat;

      // If the point is outside the AABB it cannot be inside the polygon — skip PIP.
      const isInside = inBbox && pointInPolygon(lat, lng, ring);
      const wasInside = geofenceState.get(stateKey); // undefined on first event

      // Update state first (before emitting) so future events use the new state.
      geofenceState.set(stateKey, isInside);

      // Only emit on transitions (requires a known prior state).
      if (wasInside === undefined) continue;

      if (wasInside && !isInside) {
        // Transition: inside → outside → geofence_exit
        if (shouldEmitAlert(device_id, `geofence_exit:${fence.geofenceId}`, eventTsMs, GEOFENCE_COOLDOWN_MS)) {
          const alert = { device_id, geofence_id: fence.geofenceId, geofence_name: fence.name, lat, lng, ts: event.timestamp };
          await writeAlert(device_id, 'geofence_exit', alert, 'MEDIUM');
          broadcast({ type: 'alert', alert_type: 'geofence_exit', ...alert });
        }
      } else if (!wasInside && isInside) {
        // Transition: outside → inside → geofence_enter
        if (shouldEmitAlert(device_id, `geofence_enter:${fence.geofenceId}`, eventTsMs, GEOFENCE_COOLDOWN_MS)) {
          const alert = { device_id, geofence_id: fence.geofenceId, geofence_name: fence.name, lat, lng, ts: event.timestamp };
          await writeAlert(device_id, 'geofence_enter', alert, 'LOW');
          broadcast({ type: 'alert', alert_type: 'geofence_enter', ...alert });
        }
      }
    }
  }

  // ─── power_disconnect (Requirement 8.4) ──────────────────────────────────
  // Emit CRITICAL alert when ext_voltage drops from above 11.0 V to below 7.0 V
  // across consecutive events.  Once active, the cooldown does NOT reset on
  // repeated low-voltage events — it only clears when voltage recovers back
  // above POWER_DISCONNECT_LOW_V (state-based, not time-based).
  const currExtVoltage = telemetry?.ext_voltage ?? event.ext_voltage ?? null;
  const prevExtVoltage = lastExtVoltage.get(device_id) ?? null;

  if (currExtVoltage != null) {
    if (
      prevExtVoltage != null &&
      prevExtVoltage > POWER_DISCONNECT_HIGH_V &&
      currExtVoltage < POWER_DISCONNECT_LOW_V &&
      !powerDisconnectActive.get(device_id)
    ) {
      // Voltage has dropped from healthy (>11 V) to critically low (<7 V): fire alert.
      boundedSet(powerDisconnectActive, device_id, true);
      const alert = {
        device_id,
        prev_ext_voltage: prevExtVoltage,
        curr_ext_voltage: currExtVoltage,
        ts: event.timestamp,
      };
      await writeAlert(device_id, 'power_disconnect', alert, 'CRITICAL');
      broadcast({ type: 'alert', alert_type: 'power_disconnect', ...alert });
    } else if (currExtVoltage >= POWER_DISCONNECT_LOW_V && powerDisconnectActive.get(device_id)) {
      // Voltage has recovered — clear the active state so the alert can fire again
      // if power is subsequently lost.
      powerDisconnectActive.delete(device_id);
    }

    // Always update tracked voltage for this device (bounded set).
    boundedSet(lastExtVoltage, device_id, currExtVoltage);
  }
}

// ─── startOfflineMonitor (Requirements 8.5, 8.10) ────────────────────────────
/**
 * Start a periodic sweep that detects devices which have gone silent while
 * their last known ignition state was TRUE.
 *
 * The sweep runs every 60 seconds over the live cache.  For each device whose
 * last event age exceeds 600 s AND whose cached ignition is TRUE:
 *   - If the offline cooldown for that device is NOT already active, fire a
 *     `device_offline` alert (severity HIGH) and mark the cooldown active.
 *   - If the cooldown IS active, skip — do NOT re-emit (Requirement 8.10).
 *
 * The cooldown is cleared automatically inside evaluateAlerts() the moment the
 * device sends its next event (recovery detection).
 *
 * @param {(msg: object) => void} broadcast  WebSocket broadcast function from api.js
 * @returns {NodeJS.Timeout}  The interval handle (keep a reference to clear on shutdown)
 */
export function startOfflineMonitor(broadcast) {
  const handle = setInterval(async () => {
    const now = Date.now();
    const devices = cacheAll();

    for (const entry of devices) {
      const deviceId = entry.device_id;
      if (!deviceId) continue;

      // Determine the age of the last event for this device
      const lastTs = entry.timestamp ? Date.parse(entry.timestamp) : 0;
      const ageMs  = now - lastTs;

      // Retrieve cached ignition state
      const ignition = entry.telemetry?.ignition ?? entry.ignition ?? false;

      // Only consider devices that were running (ignition ON) and have gone silent
      if (ageMs <= OFFLINE_THRESHOLD_MS || !ignition) continue;

      // Skip if the offline cooldown is already active for this device (Req 8.10)
      if (offlineActive.get(deviceId)) continue;

      // Mark the device as offline — cooldown persists until a recovery event
      boundedSet(offlineActive, deviceId, true);

      const alert = {
        device_id:  deviceId,
        last_seen:  entry.timestamp,
        age_seconds: Math.round(ageMs / 1000),
        ts: new Date(now).toISOString(),
      };

      try {
        await writeAlert(deviceId, 'device_offline', alert, 'HIGH');
        broadcast({ type: 'alert', alert_type: 'device_offline', ...alert });
        console.log(`[L4] device_offline alert fired device=${deviceId} age=${alert.age_seconds}s`);
      } catch (err) {
        console.error(`[L4] device_offline writeAlert failed device=${deviceId}:`, err.message);
        // Roll back the active flag so the next sweep can retry
        offlineActive.delete(deviceId);
      }
    }
  }, OFFLINE_SWEEP_INTERVAL_MS);

  console.log('[L4] device_offline heartbeat monitor started (sweep interval 60 s, threshold 600 s)');
  return handle;
}