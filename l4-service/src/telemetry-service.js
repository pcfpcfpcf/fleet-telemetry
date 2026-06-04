import { telemetryContracts } from './telemetry-contracts.js';

// ─── Contract-shaping helpers (Requirements 10.4, 11.1–11.4) ─────────────────
//
// These functions project raw data (live-cache entries or DB rows) to the
// canonical API contract shapes defined in telemetry-contracts.js.
// They are pure functions: no side-effects, no DB calls.

/**
 * Project a live-cache entry to the API contract shape for a single vehicle.
 * Used by GET /api/vehicles/live and WebSocket telemetry broadcast.
 *
 * All 14 new fields from live cache requirements (Req 11.1) are included.
 *
 * @param {object} cacheEntry - Raw entry from cacheGet() or cacheAll()
 * @returns {object} Live vehicle API shape
 */
export function shapeVehicleLive(cacheEntry) {
  if (!cacheEntry) return null;
  const v = cacheEntry;
  const speed = v.position?.speed ?? v.speed ?? null;
  const lat = v.position?.lat ?? v.lat ?? null;
  const lng = v.position?.lng ?? v.lng ?? null;
  const ignition = v.telemetry?.ignition ?? v.ignition ?? null;
  const fuelLevel = v.telemetry?.fuel_level ?? v.fuel_level ?? null;
  const odometer = v.telemetry?.odometer ?? v.odometer ?? null;

  return {
    device_id: v.device_id,
    timestamp: v.timestamp ?? null,
    received_at: v.received_at ?? null,
    lat,
    lng,
    altitude: v.position?.altitude ?? v.altitude ?? null,
    bearing: v.position?.bearing ?? v.bearing ?? null,
    speed,
    ignition,
    fuel_level: fuelLevel,
    odometer,
    buffered: Boolean(v.buffered),
    // 14 extended live-cache fields (Requirement 11.1)
    ext_voltage: v.ext_voltage ?? null,
    bat_voltage: v.bat_voltage ?? null,
    bat_level: v.bat_level ?? null,
    movement: v.movement ?? null,
    gsm_signal: v.gsm_signal ?? null,
    gnss_status: v.gnss_status ?? null,
    gnss_hdop: v.gnss_hdop ?? null,
    axis_x: v.axis_x ?? null,
    axis_y: v.axis_y ?? null,
    axis_z: v.axis_z ?? null,
    trip_odometer: v.trip_odometer ?? null,
    eco_score: v.eco_score ?? null,
    fuel_rate_gps: v.fuel_rate_gps ?? null,
    sleep_mode: v.sleep_mode ?? null,
  };
}

/**
 * Build the fleet-level summary from the full live-cache array.
 * Includes avg_bat_voltage, low_battery_count, offline_count, unacknowledged_alerts.
 *
 * Source-of-truth for SSE summary events (Requirement 11.4, 10.4).
 *
 * @param {object[]} cacheAll - Array from cacheAll()
 * @param {object} [opts]
 * @param {number} [opts.offlineThresholdMs=600000] - Age in ms above which a device is offline
 * @param {number} [opts.unacknowledgedAlerts=0]    - Injected from alerts.js counter
 * @returns {object} Fleet summary shape
 */
export function shapeFleetSummary(cacheAll, { offlineThresholdMs = 600_000, unacknowledgedAlerts = 0 } = {}) {
  const now = Date.now();
  let ignitionOn = 0;
  let ignitionOff = 0;
  let totalBatVoltage = 0;
  let batVoltageCount = 0;
  let lowBatteryCount = 0;
  let offlineCount = 0;

  for (const v of cacheAll) {
    const ignition = v.telemetry?.ignition ?? v.ignition ?? false;
    if (ignition) ignitionOn++; else ignitionOff++;

    const batVoltage = v.bat_voltage ?? null;
    if (batVoltage != null) {
      totalBatVoltage += batVoltage;
      batVoltageCount++;
      if (batVoltage < 3.0) lowBatteryCount++;
    }

    const ts = v.timestamp ? Date.parse(v.timestamp) : 0;
    const ageMs = now - ts;
    if (ageMs > offlineThresholdMs) offlineCount++;
  }

  const avgBatVoltage = batVoltageCount > 0
    ? Math.round((totalBatVoltage / batVoltageCount) * 1000) / 1000
    : null;

  return {
    as_of: new Date().toISOString(),
    total_vehicles: cacheAll.length,
    ignition_on: ignitionOn,
    ignition_off: ignitionOff,
    avg_bat_voltage: avgBatVoltage,
    low_battery_count: lowBatteryCount,
    offline_count: offlineCount,
    unacknowledged_alerts: unacknowledgedAlerts,
  };
}

/**
 * Project a `trips` DB row to the TripRecord API contract shape.
 *
 * @param {object} dbRow - Raw row from queryTripList or listTrips
 * @returns {object} TripRecord shape
 */
export function shapeTrip(dbRow) {
  if (!dbRow) return null;
  return {
    trip_id: dbRow.trip_id,
    device_id: dbRow.device_id,
    driver_id: dbRow.driver_id ?? null,
    started_at: dbRow.started_at ?? null,
    ended_at: dbRow.ended_at ?? null,
    start_lat: dbRow.start_lat ?? null,
    start_lng: dbRow.start_lng ?? null,
    end_lat: dbRow.end_lat ?? null,
    end_lng: dbRow.end_lng ?? null,
    distance_meters: dbRow.distance_meters ?? null,
    duration_seconds: dbRow.duration_seconds ?? null,
    fuel_consumed_liters: dbRow.fuel_consumed_liters ?? null,
    max_speed_kmh: dbRow.max_speed_kmh ?? null,
    avg_speed_kmh: dbRow.avg_speed_kmh ?? null,
    idle_seconds: dbRow.idle_seconds ?? null,
    eco_score: dbRow.eco_score ?? null,
    status: dbRow.status ?? 'active',
  };
}

/**
 * Project an `alerts` DB row to the AlertRecord API contract shape.
 *
 * @param {object} dbRow - Raw row from queryAlertList or listAlerts
 * @returns {object} AlertRecord shape
 */
export function shapeAlert(dbRow) {
  if (!dbRow) return null;
  return {
    alert_id: dbRow.alert_id,
    device_id: dbRow.device_id,
    timestamp: dbRow.timestamp ?? null,
    alert_type: dbRow.alert_type,
    severity: dbRow.severity,
    message: dbRow.message ?? null,
    metadata: dbRow.metadata ?? null,
    acknowledged: Boolean(dbRow.acknowledged),
    acknowledged_at: dbRow.acknowledged_at ?? null,
    position_lat: dbRow.position_lat ?? null,
    position_lng: dbRow.position_lng ?? null,
    event_id: dbRow.event_id ?? null,
  };
}

/**
 * Project a `devices` DB row to the DeviceRecord API contract shape.
 *
 * @param {object} dbRow - Raw row from the devices table
 * @returns {object} DeviceRecord shape
 */
export function shapeDevice(dbRow) {
  if (!dbRow) return null;
  return {
    device_id: dbRow.device_id,
    imei: dbRow.imei ?? null,
    name: dbRow.name ?? null,
    vin: dbRow.vin ?? null,
    iccid: dbRow.iccid ?? null,
    serial_number: dbRow.serial_number ?? null,
    registration_number: dbRow.registration_number ?? null,
    make: dbRow.make ?? null,
    model: dbRow.model ?? null,
    year: dbRow.year ?? null,
    fuel_type: dbRow.fuel_type ?? null,
    driver_id: dbRow.driver_id ?? null,
    last_seen: dbRow.last_seen ?? null,
    created_at: dbRow.created_at ?? null,
  };
}

/**
 * Project a `drivers` DB row to the DriverRecord API contract shape.
 *
 * @param {object} dbRow - Raw row from the drivers table
 * @returns {object} DriverRecord shape
 */
export function shapeDriver(dbRow) {
  if (!dbRow) return null;
  return {
    driver_id: dbRow.driver_id,
    name: dbRow.name,
    employee_id: dbRow.employee_id ?? null,
    license_number: dbRow.license_number ?? null,
    phone: dbRow.phone ?? null,
    tag_id: dbRow.tag_id ?? null,
    status: dbRow.status ?? 'active',
    created_at: dbRow.created_at ?? null,
    updated_at: dbRow.updated_at ?? null,
  };
}

function assertPositiveInteger(value, name, min = 1, max = 5000) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function toNullableIso(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO 8601 timestamp`);
  }
  return parsed.toISOString();
}

export function createTelemetryService(repository) {
  return {
    repository,
    contracts: telemetryContracts,

    async getLatestVehicleStates(query = {}) {
      const includeAll = Boolean(query.includeAll);
      const activeWindowMinutes = query.active_window_minutes ?? 15;
      return repository.listLatestStates({ activeWindowMinutes, includeAll });
    },

    async getLatestVehicleState(deviceId) {
      return repository.getLatestState(deviceId);
    },

    async getVehicleHistory(deviceId, query = {}) {
      const from = toNullableIso(query.from, 'from');
      const to = toNullableIso(query.to, 'to');
      const limit = assertPositiveInteger(query.limit ?? 500, 'limit');
      const records = await repository.listHistory(deviceId, { from, to, limit });
      return {
        device_id: deviceId,
        from,
        to,
        limit,
        next_cursor: null,
        records,
      };
    },

    async getVehicleTimeline(deviceId, query = {}) {
      const from = toNullableIso(query.from, 'from');
      const to = toNullableIso(query.to, 'to');
      const limit = assertPositiveInteger(query.limit ?? 500, 'limit');
      const records = await repository.listTimeline(deviceId, { from, to, limit });
      return {
        device_id: deviceId,
        from,
        to,
        limit,
        next_cursor: null,
        records,
      };
    },

    async getVehicleAlerts(query = {}) {
      const from = toNullableIso(query.from, 'from');
      const to = toNullableIso(query.to, 'to');
      const limit = assertPositiveInteger(query.limit ?? 500, 'limit');
      const acknowledged = query.acknowledged === undefined || query.acknowledged === null || query.acknowledged === ''
        ? null
        : String(query.acknowledged).toLowerCase() === 'true';
      const records = await repository.listAlerts({
        deviceId: query.device_id || null,
        from,
        to,
        severity: query.severity || null,
        alertType: query.alert_type || null,
        acknowledged,
        limit,
      });
      return {
        device_id: query.device_id || null,
        from,
        to,
        severity: query.severity || null,
        alert_type: query.alert_type || null,
        acknowledged,
        limit,
        next_cursor: null,
        records,
      };
    },

    async getVehicleDiagnostics(deviceId, query = {}) {
      const from = toNullableIso(query.from, 'from');
      const to = toNullableIso(query.to, 'to');
      const limit = assertPositiveInteger(query.limit ?? 500, 'limit');
      const version = query.version ? String(query.version) : '1';
      return repository.getDiagnostics(deviceId, { from, to, limit, version });
    },

    async getFleetSummary(query = {}) {
      const activeWindowMinutes = assertPositiveInteger(query.active_window_minutes ?? 15, 'active_window_minutes');
      return repository.getFleetSummary({ activeWindowMinutes });
    },
  };
}
