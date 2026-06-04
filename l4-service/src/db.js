import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep a small pool — the batch writer is the only heavy writer
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
});

// ─── Single-event write (kept for backward-compat / non-batch callers) ────────
export async function writeTelemetry(event) {
  await writeTelemetryBatch([event]);
}

// ─── Batch write ──────────────────────────────────────────────────────────────
// Uses a single multi-row INSERT to minimize round-trips.
// ON CONFLICT DO NOTHING handles duplicate event_id+timestamp pairs.
export async function writeTelemetryBatch(events) {
  if (!events || events.length === 0) return;

  const rows   = [];
  const values = [];
  let   idx    = 1;

  for (const event of events) {
    // 35 columns per row: 17 existing + 18 new IO columns
    rows.push(
      `($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9}` +
      `,$${idx+10},$${idx+11},$${idx+12},$${idx+13},$${idx+14},$${idx+15},$${idx+16}` +
      `,$${idx+17},$${idx+18},$${idx+19},$${idx+20},$${idx+21},$${idx+22},$${idx+23},$${idx+24}` +
      `,$${idx+25},$${idx+26},$${idx+27},$${idx+28},$${idx+29},$${idx+30},$${idx+31},$${idx+32}` +
      `,$${idx+33},$${idx+34})`
    );
    values.push(
      // ── Original 17 columns ──────────────────────────────────────────────────
      event.event_id,
      event.device_id,
      event.timestamp,
      event.received_at || new Date().toISOString(),
      event.position?.lat       ?? null,
      event.position?.lng       ?? null,
      event.position?.altitude  ?? null,
      event.position?.accuracy  ?? null,
      event.position?.bearing   ?? null,
      event.position?.speed     ?? null,
      event.telemetry?.ignition    ?? null,
      event.telemetry?.fuel_level  ?? null,
      event.telemetry?.odometer    ?? null,
      event.telemetry?.rpm         ?? null,
      event.telemetry?.engine_load ?? null,
      event.buffered ?? false,
      // Store the full enriched event as payload (includes io_events + extended fields)
      JSON.stringify(event),
      // ── 18 new IO columns (IO_MAP field names from consumer.js) ─────────────
      event.ext_voltage    ?? null,  // IO 66 — mV→V
      event.bat_voltage    ?? null,  // IO 67 — mV→V
      event.bat_level      ?? null,  // IO 113
      event.bat_current    ?? null,  // IO 68
      event.gnss_status    ?? null,  // IO 69
      event.gnss_hdop      ?? null,  // IO 182
      event.gnss_pdop      ?? null,  // IO 181
      event.movement       ?? null,  // IO 240
      event.gsm_signal     ?? null,  // IO 21
      event.network_type   ?? null,  // IO 237
      event.axis_x         ?? null,  // IO 17
      event.axis_y         ?? null,  // IO 18
      event.axis_z         ?? null,  // IO 19
      event.trip_odometer  ?? null,  // IO 199 — metres
      event.eco_score      ?? null,  // IO 15
      event.fuel_rate_gps  ?? null,  // IO 13
      event.fuel_used_gps  ?? null,  // IO 12
      event.sleep_mode     ?? null,  // IO 200
    );
    idx += 35;
  }

  const sql = `
    INSERT INTO telemetry (
      event_id, device_id, timestamp, received_at,
      lat, lng, altitude, accuracy, bearing, speed,
      ignition, fuel_level, odometer, rpm, engine_load,
      buffered, payload,
      ext_voltage, bat_voltage, bat_level, bat_current,
      gnss_status, gnss_hdop, gnss_pdop, movement,
      gsm_signal, network_type,
      axis_x, axis_y, axis_z,
      trip_odometer, eco_score, fuel_rate_gps, fuel_used_gps, sleep_mode
    ) VALUES ${rows.join(',')}
    ON CONFLICT (event_id, timestamp) DO NOTHING
  `;

  await pool.query(sql, values);

  // ── Update devices.last_seen for all devices in this batch ─────────────────
  // Collect unique device IDs and update last_seen = NOW() for each registered device.
  // Uses a single parameterised UPDATE with ANY($1) so only one round-trip is needed
  // regardless of how many distinct devices are in the batch.
  const deviceIds = [...new Set(events.map(e => e.device_id).filter(Boolean))];
  if (deviceIds.length > 0) {
    await touchDeviceLastSeen(deviceIds);
  }
}

// ─── Update last_seen for one or more registered devices ─────────────────────
// Called after every successful telemetry batch flush (Requirement 7.4).
// Only rows that already exist in the devices table are touched — unregistered
// device IDs are silently ignored by the WHERE device_id = ANY($1) filter.
export async function touchDeviceLastSeen(deviceIds) {
  if (!deviceIds || deviceIds.length === 0) return;
  await pool.query(
    `UPDATE devices SET last_seen = NOW(), updated_at = NOW()
     WHERE device_id = ANY($1)`,
    [deviceIds],
  );
}

// ─── Alert write ──────────────────────────────────────────────────────────────
export async function writeAlert(deviceId, type, payload, severity = 'WARNING') {
  await pool.query(
    `INSERT INTO alerts (device_id, timestamp, alert_type, severity, message, metadata)
     VALUES ($1, NOW(), $2, $3, $4, $5)`,
    [deviceId, type, severity, `${type} triggered for ${deviceId}`, JSON.stringify(payload)]
  );
}

// ─── Device config write ──────────────────────────────────────────────────────
// Inserts a new device_config record. Each call creates a new versioned entry;
// the latest record is determined by config_applied_at DESC.
export async function writeDeviceConfig(deviceId, config) {
  const {
    firmware_version         = null,
    tracking_interval_seconds = null,
    sleep_mode               = null,
    notes                    = null,
  } = config || {};

  const result = await pool.query(
    `INSERT INTO device_config
       (device_id, firmware_version, tracking_interval_seconds, sleep_mode, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [deviceId, firmware_version, tracking_interval_seconds, sleep_mode, notes]
  );

  return result.rows[0];
}

// ─── Device config read ───────────────────────────────────────────────────────
// Returns the most-recently applied config record for the device, or null if
// no config has been written yet.
export async function readDeviceConfig(deviceId) {
  const result = await pool.query(
    `SELECT *
     FROM device_config
     WHERE device_id = $1
     ORDER BY config_applied_at DESC
     LIMIT 1`,
    [deviceId]
  );

  return result.rows[0] ?? null;
}

// ─── Trip helpers ─────────────────────────────────────────────────────────────

/**
 * Open a new trip row (ignition ON transition).
 * Returns the generated trip_id (UUID) for storage in the live cache.
 *
 * @param {string}  deviceId   - device_id (TEXT)
 * @param {string|null} driverId - driver_id (UUID) or null
 * @param {string|Date} startedAt - trip start timestamp
 * @param {number|null} startLat  - start latitude
 * @param {number|null} startLng  - start longitude
 * @returns {Promise<string>} trip_id
 */
export async function writeTripOpen(deviceId, driverId, startedAt, startLat, startLng) {
  const result = await pool.query(
    `INSERT INTO trips (device_id, driver_id, started_at, start_lat, start_lng, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING trip_id`,
    [deviceId, driverId ?? null, startedAt, startLat ?? null, startLng ?? null]
  );
  return result.rows[0].trip_id;
}

/**
 * Close an active trip row (ignition OFF transition).
 * duration_seconds is computed from the DB using EXTRACT(EPOCH FROM ended_at - started_at)
 * so the passed durationSeconds is only used as a fallback; the DB value is authoritative.
 *
 * @param {string}      tripId              - trip_id to update
 * @param {string|Date} endedAt             - trip end timestamp
 * @param {number|null} endLat              - end latitude
 * @param {number|null} endLng              - end longitude
 * @param {number|null} distanceMeters      - total trip distance in metres
 * @param {number|null} durationSeconds     - pre-computed duration (overridden by DB calc)
 * @param {number|null} maxSpeedKmh         - max speed recorded during trip
 * @param {number|null} avgSpeedKmh         - average speed during trip
 * @param {number|null} fuelConsumedLiters  - total fuel consumed in litres
 * @param {number|null} ecoScore            - eco driving score (0–100)
 */
export async function writeTripClose(
  tripId,
  endedAt,
  endLat,
  endLng,
  distanceMeters,
  durationSeconds,
  maxSpeedKmh,
  avgSpeedKmh,
  fuelConsumedLiters,
  ecoScore
) {
  await pool.query(
    `UPDATE trips
     SET
       ended_at             = $2,
       end_lat              = $3,
       end_lng              = $4,
       distance_meters      = $5,
       duration_seconds     = EXTRACT(EPOCH FROM $2::timestamptz - started_at)::INTEGER,
       max_speed_kmh        = $6,
       avg_speed_kmh        = $7,
       fuel_consumed_liters = $8,
       eco_score            = $9,
       status               = 'completed'
     WHERE trip_id = $1`,
    [
      tripId,
      endedAt,
      endLat             ?? null,
      endLng             ?? null,
      distanceMeters     ?? null,
      maxSpeedKmh        ?? null,
      avgSpeedKmh        ?? null,
      fuelConsumedLiters ?? null,
      ecoScore           ?? null,
    ]
  );
}

// ─── Driver assignment helper ─────────────────────────────────────────────────

/**
 * Assign (or unassign) a driver to a device.
 * Sets devices.driver_id to the given driverId; pass null to unassign.
 *
 * @param {string}      deviceId - device_id (TEXT)
 * @param {string|null} driverId - driver_id (UUID) or null to remove assignment
 */
export async function writeDriverAssignment(deviceId, driverId) {
  await pool.query(
    `UPDATE devices SET driver_id = $2 WHERE device_id = $1`,
    [deviceId, driverId ?? null]
  );
}

// ─── DTC event write ──────────────────────────────────────────────────────────
// Inserts a new DTC fault code occurrence into dtc_events.
// Requirements: 5.2
export async function writeDtcEvent(deviceId, timestamp, dtcCode, rawValue, eventId) {
  await pool.query(
    `INSERT INTO dtc_events (device_id, timestamp, dtc_code, raw_value, event_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [deviceId, timestamp, dtcCode, rawValue ?? null, eventId ?? null]
  );
}

// ─── DTC event resolve ────────────────────────────────────────────────────────
// Marks the most recent unresolved record(s) for (device_id, dtc_code) as resolved.
// Requirements: 5.4
export async function resolveDtcEvent(deviceId, dtcCode) {
  await pool.query(
    `UPDATE dtc_events
        SET resolved_at = NOW()
      WHERE device_id  = $1
        AND dtc_code   = $2
        AND resolved_at IS NULL`,
    [deviceId, dtcCode]
  );
}

// ─── Audit log ────────────────────────────────────────────────────────────────
export async function writeAuditLog(action, entityType, entityId, details, ipAddress) {
  try {
    await pool.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5::inet)`,
      [action, entityType, entityId || null, JSON.stringify(details || {}), ipAddress || null]
    );
  } catch (err) {
    console.error('[AUDIT] Failed to write audit log:', err.message);
  }
}
