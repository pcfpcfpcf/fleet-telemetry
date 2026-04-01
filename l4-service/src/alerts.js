import { writeAlert } from './db.js';

const SPEED_LIMIT_KMH = 120;
const IGNITION_IDLE_SEC = 300;
const LOW_FUEL_PERCENT = 15;
const IGNITION_ANOMALY_SPEED_KMH = 10;
const GEOFENCE_BOUNDS = {
  minLat: parseFloat(process.env.GEOFENCE_MIN_LAT || '36.6'),
  maxLat: parseFloat(process.env.GEOFENCE_MAX_LAT || '37.0'),
  minLng: parseFloat(process.env.GEOFENCE_MIN_LNG || '9.9'),
  maxLng: parseFloat(process.env.GEOFENCE_MAX_LNG || '10.5'),
};
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

// ─── FIX 1: bounded in-memory maps ───────────────────────────────────────────
// Original maps grew forever with unique device IDs (memory leak under load).
// Capped at 10,000 entries each with oldest-first eviction — matches consumer.js.
const MAX_TRACKED_DEVICES = 10_000;

const idleTimers = new Map();
const lastAlertAt = new Map();

function boundedSet(map, key, value) {
  if (!map.has(key) && map.size >= MAX_TRACKED_DEVICES) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

function shouldEmitAlert(deviceId, alertType, tsMs) {
  const key = `${deviceId}:${alertType}`;
  const lastTs = lastAlertAt.get(key) || 0;
  if (tsMs - lastTs < ALERT_COOLDOWN_MS) {
    return false;
  }
  // ─── FIX 1 applied: use bounded setter ───────────────────────────────────
  boundedSet(lastAlertAt, key, tsMs);
  return true;
}

function withinGeofence(lat, lng) {
  if (lat == null || lng == null) {
    return true;
  }
  return (
    lat >= GEOFENCE_BOUNDS.minLat &&
    lat <= GEOFENCE_BOUNDS.maxLat &&
    lng >= GEOFENCE_BOUNDS.minLng &&
    lng <= GEOFENCE_BOUNDS.maxLng
  );
}

export async function evaluateAlerts(event, broadcast) {
  const { device_id, position, telemetry } = event;
  const speed = position?.speed ?? 0;
  const ignition = telemetry?.ignition ?? false;
  const fuelLevel = telemetry?.fuel_level;
  const lat = position?.lat;
  const lng = position?.lng;
  const eventTsMs = Date.parse(event.timestamp) || Date.now();

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

  if (!withinGeofence(lat, lng) && shouldEmitAlert(device_id, 'geofence_breach', eventTsMs)) {
    const alert = {
      device_id,
      lat,
      lng,
      bounds: GEOFENCE_BOUNDS,
      ts: event.timestamp,
    };
    await writeAlert(device_id, 'geofence_breach', alert, 'WARNING');
    broadcast({ type: 'alert', alert_type: 'geofence_breach', ...alert });
  }
}