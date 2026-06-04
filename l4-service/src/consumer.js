import { connect, StringCodec } from 'nats';
import { writeTelemetry, writeTelemetryBatch, writeTripOpen, writeTripClose, writeDtcEvent, resolveDtcEvent } from './db.js';
import { evaluateAlerts } from './alerts.js';
import { cacheSet, cacheGet } from './live-cache.js';

// ─── Trip boundary constants ──────────────────────────────────────────────────
// fuel_used_gps (IO 12) is a cumulative odometer-style counter on the FMC003.
// At a 1 s reporting rate the max plausible delta is ~0.5 L (≈ 1 800 L/h —
// well above any HGV).  Larger deltas are sensor noise or counter resets.
// If your device reports at a longer interval, adjust to:
//   MAX_REASONABLE_FUEL_DELTA = <max_litres_per_hour> / 3600 * <interval_seconds>
const MAX_REASONABLE_FUEL_DELTA = 0.5; // litres per event

// ─── Per-device trip state (in-memory, mirrors what the live cache holds) ─────
// Structure per device_id:
//   {
//     tripId:              string | null,   — active trip UUID, null when no trip open
//     accumulator:         {                — running trip metrics
//       maxSpeedKmh:       number,
//       totalFuelUsed:     number,
//       ecoScoreSamples:   number[],
//     } | null,
//     previousFuelUsedGps: number | null,   — last known cumulative fuel counter value
//   }
const tripStateByDevice = new Map();

const sc = StringCodec();

// ─── Bounded device-timestamp tracking ───────────────────────────────────────
const MAX_TRACKED_DEVICES = 10_000;
const lastEventTsByDevice = new Map();

function setDeviceTs(deviceId, ts) {
  if (!lastEventTsByDevice.has(deviceId) && lastEventTsByDevice.size >= MAX_TRACKED_DEVICES) {
    lastEventTsByDevice.delete(lastEventTsByDevice.keys().next().value);
  }
  lastEventTsByDevice.set(deviceId, ts);
}

// ─── IO field extraction map ──────────────────────────────────────────────────
// Covers all named IO IDs from decoder.c.
// Values that need unit conversion are listed with their scale factor.
const IO_MAP = {
  // Primary telemetry (promoted to top-level columns)
  239: { key: 'ignition',     type: 'bool'   },
  16:  { key: 'odometer',     type: 'int'    },  // metres → kept as-is
  13:  { key: 'fuel_rate_gps',type: 'float10' }, // raw /10 → L/100km approx
  24:  { key: 'speed_io',     type: 'int'    },  // km/h (backup)
  // Extended fields stored on the event for cache + payload
  12:  { key: 'fuel_used_gps',type: 'int'    },
  15:  { key: 'eco_score',    type: 'float10' },
  17:  { key: 'axis_x',       type: 'int'    },
  18:  { key: 'axis_y',       type: 'int'    },
  19:  { key: 'axis_z',       type: 'int'    },
  21:  { key: 'gsm_signal',   type: 'int'    },
  66:  { key: 'ext_voltage',  type: 'mv'     },  // mV → V
  67:  { key: 'bat_voltage',  type: 'mv'     },
  68:  { key: 'bat_current',  type: 'int'    },
  69:  { key: 'gnss_status',  type: 'int'    },
  113: { key: 'bat_level',    type: 'int'    },
  181: { key: 'gnss_pdop',    type: 'float10' },
  182: { key: 'gnss_hdop',    type: 'float10' },
  199: { key: 'trip_odometer',type: 'int'    },  // metres
  200: { key: 'sleep_mode',   type: 'int'    },
  237: { key: 'network_type', type: 'int'    },
  240: { key: 'movement',     type: 'bool'   },
  241: { key: 'gsm_operator', type: 'int'    },
  263: { key: 'bt_status',    type: 'int'    },
  // OBD-II DTC fault codes (FMC003 IO IDs 30–38)
  // Non-zero values indicate an active diagnostic trouble code.
  // The raw integer value is the encoded DTC; a zero means the code is clear.
  30:  { key: 'dtc_code_1',   type: 'int'    },
  31:  { key: 'dtc_code_2',   type: 'int'    },
  32:  { key: 'dtc_code_3',   type: 'int'    },
  33:  { key: 'dtc_code_4',   type: 'int'    },
  34:  { key: 'dtc_code_5',   type: 'int'    },
  35:  { key: 'dtc_code_6',   type: 'int'    },
  36:  { key: 'dtc_code_7',   type: 'int'    },
  37:  { key: 'dtc_code_8',   type: 'int'    },
  38:  { key: 'dtc_code_9',   type: 'int'    },
};

// ─── DTC IO field names (subset of IO_MAP) ────────────────────────────────────
// All IO_MAP keys whose key starts with 'dtc_code_' are DTC fields.
// A non-zero value in any of these fields means a fault code is active.
const DTC_IO_KEYS = new Set(
  Object.values(IO_MAP)
    .filter(spec => spec.key.startsWith('dtc_code_'))
    .map(spec => spec.key)
);

// ─── Per-device DTC absence streak counter ────────────────────────────────────
// Tracks how many consecutive events each DTC code has been absent for.
// Structure: Map<deviceId, Map<dtcCode, absenceCount>>
// A DTC code is resolved only after DTC_RESOLVE_THRESHOLD consecutive absences
// to prevent noisy open/close cycles from intermittent tracker emissions.
// Requirements: 5.4
const DTC_RESOLVE_THRESHOLD = 3;
const dtcAbsenceCount = new Map();

function convertIoValue(spec, raw) {
  switch (spec.type) {
    case 'bool':    return raw !== 0;
    case 'float10': return Math.round(raw) / 10;
    case 'mv':      return Math.round(raw) / 1000; // mV → V
    case 'float':   return Number(raw);
    case 'int':     return Number(raw);
    default:        return Number(raw);
  }
}

// ─── Full field extraction from io_events ────────────────────────────────────
function extractIoFields(ioEvents) {
  const fields = {};
  if (!Array.isArray(ioEvents)) return fields;
  for (const io of ioEvents) {
    if (io == null || io.id == null) continue;
    const spec = IO_MAP[io.id];
    if (spec) {
      fields[spec.key] = convertIoValue(spec, io.value ?? io.val ?? 0);
    }
  }
  return fields;
}

// ─── Event validation ─────────────────────────────────────────────────────────
function isValidEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.event_id !== 'string' || !event.event_id) return false;
  if (typeof event.device_id !== 'string' || !event.device_id) return false;
  if (typeof event.timestamp !== 'string' || isNaN(Date.parse(event.timestamp))) return false;
  if (!event.position || typeof event.position !== 'object') return false;
  return true;
}

// ─── Full normalization ───────────────────────────────────────────────────────
function normalizeEvent(event) {
  const pos = event.position || {};
  const tel = event.telemetry || {};

  // Coerce position numbers
  pos.lat      = pos.lat      != null ? Number(pos.lat)      : null;
  pos.lng      = pos.lng      != null ? Number(pos.lng)      : null;
  pos.altitude = pos.altitude != null ? Number(pos.altitude) : null;
  pos.accuracy = pos.accuracy != null ? Number(pos.accuracy) : null;
  pos.bearing  = pos.bearing  != null ? Number(pos.bearing)  : null;
  pos.speed    = pos.speed    != null ? Number(pos.speed)    : null;

  // Coerce telemetry
  if (tel.ignition != null && typeof tel.ignition !== 'boolean') {
    tel.ignition = Boolean(Number(tel.ignition));
  }
  if (tel.fuel_level   != null) tel.fuel_level   = Number(tel.fuel_level);
  if (tel.odometer     != null) tel.odometer     = Number(tel.odometer);
  if (tel.rpm          != null) tel.rpm          = Number(tel.rpm);
  if (tel.engine_load  != null) tel.engine_load  = Number(tel.engine_load);

  // Extract all named IO fields
  const ioFields = extractIoFields(event.io_events);

  // Fill telemetry gaps from io_events (priority: explicit telemetry > io_events)
  if (tel.ignition  == null && ioFields.ignition  != null) tel.ignition  = ioFields.ignition;
  if (tel.odometer  == null && ioFields.odometer  != null) tel.odometer  = ioFields.odometer;
  if (pos.speed     == null && ioFields.speed_io  != null) pos.speed     = ioFields.speed_io;

  // fuel_rate_gps (IO 13): nats-pub divides by 10 already; if not, we do it here
  // The nats-pub.c sets fuel_level from IO 13 divided by 10 → already a float
  // Consumer fallback: IO 12 (fuel_used_gps) is cumulative, not a level — skip it

  event.position  = pos;
  event.telemetry = tel;

  // Attach extended fields directly on event for live-cache and WS broadcast
  event.ext_voltage   = ioFields.ext_voltage   ?? null;
  event.bat_voltage   = ioFields.bat_voltage   ?? null;
  event.bat_level     = ioFields.bat_level     ?? null;
  event.bat_current   = ioFields.bat_current   ?? null;
  event.movement      = ioFields.movement      ?? false;
  event.gsm_signal    = ioFields.gsm_signal    ?? null;
  event.gnss_status   = ioFields.gnss_status   ?? null;
  event.gnss_pdop     = ioFields.gnss_pdop     ?? null;
  event.gnss_hdop     = ioFields.gnss_hdop     ?? null;
  event.trip_odometer = ioFields.trip_odometer ?? null;
  event.eco_score     = ioFields.eco_score     ?? null;
  event.fuel_used_gps = ioFields.fuel_used_gps ?? null;
  event.fuel_rate_gps = ioFields.fuel_rate_gps ?? null;
  event.axis_x        = ioFields.axis_x        ?? null;
  event.axis_y        = ioFields.axis_y        ?? null;
  event.axis_z        = ioFields.axis_z        ?? null;
  event.network_type  = ioFields.network_type  ?? null;
  event.sleep_mode    = ioFields.sleep_mode    ?? null;

  // Attach DTC IO fields directly on event for detectDtcEvent and cache
  for (const dtcKey of DTC_IO_KEYS) {
    event[dtcKey] = ioFields[dtcKey] ?? null;
  }

  return event;
}

// ─── Trip boundary detection ──────────────────────────────────────────────────
/**
 * Detect ignition transitions and open/close trip rows in TimescaleDB.
 * Also accumulates per-trip metrics (maxSpeedKmh, totalFuelUsed, ecoScoreSamples)
 * and flushes them into writeTripClose() on ignition-off.
 *
 * Requirements: 4.2, 4.3
 *
 * @param {object} event - Normalised telemetry event (output of normalizeEvent)
 */
export async function detectTripBoundary(event) {
  const deviceId = event.device_id;
  const currentIgnition = event.telemetry?.ignition ?? event.ignition ?? false;
  const eventTs  = event.timestamp;
  const lat      = event.position?.lat  ?? null;
  const lng      = event.position?.lng  ?? null;
  const speed    = event.position?.speed ?? 0;
  const ecoScore = event.eco_score ?? null;

  // Retrieve (or initialise) per-device trip state
  let state = tripStateByDevice.get(deviceId);
  if (!state) {
    state = {
      tripId:              null,
      prevIgnition:        null,   // null = no previous state known (first event)
      accumulator:         null,
      previousFuelUsedGps: null,
    };
    tripStateByDevice.set(deviceId, state);
  }

  // ── Fuel delta computation (cumulative counter on FMC003) ─────────────────
  // Must be done on every event, regardless of ignition state, so that the
  // counter baseline tracks across the transition boundary.
  let fuelDelta = 0;
  const rawFuelUsed = event.fuel_used_gps ?? null;
  if (rawFuelUsed !== null) {
    if (state.previousFuelUsedGps !== null) {
      const delta = rawFuelUsed - state.previousFuelUsedGps;
      if (delta < 0) {
        // Counter reset (e.g. device reboot) — treat as zero
        fuelDelta = 0;
      } else if (delta > MAX_REASONABLE_FUEL_DELTA) {
        // Sensor noise spike — discard
        fuelDelta = 0;
      } else {
        fuelDelta = delta;
      }
    }
    // Always advance the baseline to the current reading
    state.previousFuelUsedGps = rawFuelUsed;
  }

  const prevIgnition = state.prevIgnition;

  // ── Transition: no previous state and ignition is TRUE → open trip ────────
  // (first-event-for-device guard; treat as FALSE → TRUE)
  if (prevIgnition === null) {
    if (currentIgnition === true) {
      try {
        const tripId = await writeTripOpen(deviceId, null, eventTs, lat, lng);
        state.tripId = tripId;
        state.accumulator = {
          maxSpeedKmh:    speed ?? 0,
          totalFuelUsed:  fuelDelta,
          ecoScoreSamples: ecoScore !== null ? [ecoScore] : [],
        };
        console.log(`[L4] Trip opened (first-event) device=${deviceId} trip_id=${tripId}`);
      } catch (err) {
        console.error(`[L4] writeTripOpen failed device=${deviceId}:`, err.message);
      }
    }
    state.prevIgnition = currentIgnition;
    return;
  }

  // ── Accumulate metrics for the active trip ────────────────────────────────
  if (state.tripId && state.accumulator) {
    const acc = state.accumulator;
    if (speed != null && speed > acc.maxSpeedKmh) acc.maxSpeedKmh = speed;
    acc.totalFuelUsed += fuelDelta;
    if (ecoScore !== null) acc.ecoScoreSamples.push(ecoScore);
  }

  // ── FALSE → TRUE transition: open a new trip ──────────────────────────────
  if (prevIgnition === false && currentIgnition === true) {
    try {
      const tripId = await writeTripOpen(deviceId, null, eventTs, lat, lng);
      state.tripId = tripId;
      state.accumulator = {
        maxSpeedKmh:    speed ?? 0,
        totalFuelUsed:  fuelDelta,
        ecoScoreSamples: ecoScore !== null ? [ecoScore] : [],
      };
      console.log(`[L4] Trip opened device=${deviceId} trip_id=${tripId}`);
    } catch (err) {
      console.error(`[L4] writeTripOpen failed device=${deviceId}:`, err.message);
    }

  // ── TRUE → FALSE transition: close the active trip ────────────────────────
  } else if (prevIgnition === true && currentIgnition === false) {
    if (state.tripId) {
      const acc = state.accumulator;
      const maxSpeedKmh       = acc ? acc.maxSpeedKmh : null;
      const fuelConsumedLiters = acc ? Math.round(acc.totalFuelUsed * 1000) / 1000 : null;
      const avgEcoScore = (acc && acc.ecoScoreSamples.length > 0)
        ? acc.ecoScoreSamples.reduce((a, b) => a + b, 0) / acc.ecoScoreSamples.length
        : null;

      // distance_meters from trip_odometer IO 199 (latest snapshot)
      const distanceMeters = event.trip_odometer != null
        ? Math.round(event.trip_odometer)
        : null;

      try {
        await writeTripClose(
          state.tripId,
          eventTs,
          lat,
          lng,
          distanceMeters,
          null,           // durationSeconds — DB computes from ended_at - started_at
          maxSpeedKmh,
          null,           // avgSpeedKmh — not accumulated (deferred to task 3.3+)
          fuelConsumedLiters,
          avgEcoScore !== null ? Math.round(avgEcoScore * 10) / 10 : null,
        );
        console.log(`[L4] Trip closed device=${deviceId} trip_id=${state.tripId} fuel=${fuelConsumedLiters}L maxSpeed=${maxSpeedKmh}km/h`);
      } catch (err) {
        console.error(`[L4] writeTripClose failed device=${deviceId} trip_id=${state.tripId}:`, err.message);
      }

      state.tripId     = null;
      state.accumulator = null;
    } else {
      console.warn(`[L4] Ignition-off with no active trip for device=${deviceId} — ignoring`);
    }
  }

  state.prevIgnition = currentIgnition;
}

// ─── DTC detection ────────────────────────────────────────────────────────────
/**
 * Detect active DTC fault codes in the event and write/resolve dtc_events rows.
 *
 * For each DTC IO field (IO_MAP keys starting with 'dtc_code_'):
 *   - If the field value is non-zero: the code is active → write a dtc_events row
 *     and reset the absence counter for this code to 0.
 *   - If the field is absent or zero: increment the per-device per-code absence
 *     streak counter. When the counter reaches DTC_RESOLVE_THRESHOLD (3 consecutive
 *     absences), call resolveDtcEvent() to close the most recent unresolved record.
 *
 * The 3-consecutive-absence threshold avoids noisy open/close cycles caused by
 * intermittent DTC reporting from the FMC003 tracker.
 *
 * Requirements: 5.2, 5.4
 *
 * @param {object} event - Normalised telemetry event (output of normalizeEvent)
 */
export async function detectDtcEvent(event) {
  const deviceId = event.device_id;
  const eventTs  = event.timestamp;
  const eventId  = event.event_id;

  // Ensure per-device absence counter map exists
  if (!dtcAbsenceCount.has(deviceId)) {
    dtcAbsenceCount.set(deviceId, new Map());
  }
  const deviceCounters = dtcAbsenceCount.get(deviceId);

  // Collect currently active DTC codes from this event (non-zero values)
  const activeDtcCodes = new Map(); // dtcCode → rawValue
  for (const dtcKey of DTC_IO_KEYS) {
    const rawValue = event[dtcKey];
    if (rawValue != null && rawValue !== 0) {
      activeDtcCodes.set(dtcKey, rawValue);
    }
  }

  // ── Process active DTC codes ──────────────────────────────────────────────
  for (const [dtcCode, rawValue] of activeDtcCodes) {
    // Code is present and active — write a new dtc_events row
    try {
      await writeDtcEvent(deviceId, eventTs, dtcCode, rawValue, eventId);
      console.log(`[L4] DTC active device=${deviceId} code=${dtcCode} value=${rawValue}`);
    } catch (err) {
      console.error(`[L4] writeDtcEvent failed device=${deviceId} code=${dtcCode}:`, err.message);
    }
    // Reset absence streak — code is back (or was never absent)
    deviceCounters.set(dtcCode, 0);
  }

  // ── Process absent DTC codes ──────────────────────────────────────────────
  // For every code that was previously seen but is now absent (or zero),
  // increment the absence streak and resolve after DTC_RESOLVE_THRESHOLD hits.
  for (const [dtcCode, currentStreak] of deviceCounters) {
    if (activeDtcCodes.has(dtcCode)) continue; // already handled above

    const newStreak = currentStreak + 1;
    deviceCounters.set(dtcCode, newStreak);

    if (newStreak >= DTC_RESOLVE_THRESHOLD) {
      // Three consecutive absences — safe to resolve
      try {
        await resolveDtcEvent(deviceId, dtcCode);
        console.log(`[L4] DTC resolved device=${deviceId} code=${dtcCode} after ${newStreak} absences`);
      } catch (err) {
        console.error(`[L4] resolveDtcEvent failed device=${deviceId} code=${dtcCode}:`, err.message);
      }
      // Remove the counter entry — code is considered resolved; re-added if it reappears
      deviceCounters.delete(dtcCode);
    }
  }
}

// ─── Batch write buffer ───────────────────────────────────────────────────────
// Accumulate events and flush every BATCH_INTERVAL_MS or when BATCH_SIZE is hit.
const BATCH_SIZE     = 20;
const BATCH_INTERVAL = 250; // ms

let _batch = [];
let _batchTimer = null;

async function flushBatch() {
  if (_batch.length === 0) return;
  const toWrite = _batch.splice(0);
  try {
    await writeTelemetryBatch(toWrite);
  } catch (err) {
    console.error('[L4] batch write error:', err.message);
  }
}

function scheduleBatch() {
  if (_batchTimer) return;
  _batchTimer = setTimeout(async () => {
    _batchTimer = null;
    await flushBatch();
  }, BATCH_INTERVAL);
}

function addToBatch(event) {
  _batch.push(event);
  if (_batch.length >= BATCH_SIZE) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
    flushBatch();
  } else {
    scheduleBatch();
  }
}

// ─── seedTripState ────────────────────────────────────────────────────────────
/**
 * Re-seed the in-memory tripStateByDevice map at startup from DB-recovered active trips.
 *
 * Called by seedAlertStateFromDb() (alerts.js) after querying:
 *   SELECT trip_id, device_id, started_at, start_lat, start_lng, driver_id
 *   FROM trips WHERE status = 'active'
 *
 * MVP recovery strategy: accumulator metrics are reset to zero because no reliable
 * in-flight metric snapshot is available after a restart. The trip remains closeable
 * on the next ignition-OFF event and accumulation resumes from the first new event.
 *
 * Logs a WARN per recovered trip so operators know post-restart metrics are approximate.
 *
 * Requirements: 8.4, 8.5, 8.6, 8.7, 8.10
 *
 * @param {Array<{trip_id:string, device_id:string, started_at:string, start_lat:number|null, start_lng:number|null, driver_id:string|null}>} rows
 */
export function seedTripState(rows) {
  for (const row of rows) {
    const deviceId = row.device_id;
    const tripId   = row.trip_id;

    // Reconstruct the live-cache trip accumulator with zeroed metrics (MVP strategy).
    const state = {
      tripId,
      prevIgnition:        true,   // Trip was active → last known ignition was ON
      accumulator: {
        maxSpeedKmh:      0,
        totalFuelUsed:    0,
        ecoScoreSamples:  [],
      },
      previousFuelUsedGps: null,   // Unknown after restart — delta will be 0 on first event
    };

    tripStateByDevice.set(deviceId, state);

    // WARN so operators know these metrics are approximate (Requirements 8.4, 8.10).
    console.warn(
      `WARN [trip-recovery] trip_id=${tripId} device_id=${deviceId} metrics reset to zero after restart`
    );
  }
}

export async function startConsumer(broadcast) {
  const nc = await connect({
    servers: [process.env.NATS_URL || 'nats://nats:4222'],
    user: process.env.NATS_USER,
    pass: process.env.NATS_PASS,
  });
  const js  = nc.jetstream();
  const jsm = await nc.jetstreamManager();

  try {
    await jsm.streams.add({
      name: 'TELEMETRY',
      subjects: ['telemetry.raw.>'],
      retention: 'limits',
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
      storage: 'file',
      num_replicas: 1,
    });
    console.log('[L4] Created TELEMETRY stream');
  } catch {
    console.log('[L4] TELEMETRY stream already exists');
  }

  const durableName = 'l4-processor';
  const consumerConfig = {
    durable_name: durableName,
    deliver_policy: 'all',
    ack_policy: 'explicit',
    filter_subject: 'telemetry.raw.*',
    replay_policy: 'instant',
  };

  try {
    await jsm.consumers.info('TELEMETRY', durableName);
    console.log(`[L4] Reusing durable consumer ${durableName}`);
  } catch (err) {
    const desc = err?.api_error?.description || err?.message || '';
    if (err?.code === '404' || desc === 'consumer not found') {
      await jsm.consumers.add('TELEMETRY', consumerConfig);
      console.log(`[L4] Created durable consumer ${durableName}`);
    } else {
      throw err;
    }
  }

  let messages;
  let jetStreamMode = true;

  try {
    let consumer = await js.consumers.get('TELEMETRY', durableName);
    try {
      messages = await consumer.consume();
    } catch (err) {
      const desc = err?.api_error?.description || err?.message || '';
      if (err?.code === '404' || desc === 'consumer not found') {
        await jsm.consumers.add('TELEMETRY', consumerConfig);
        consumer = await js.consumers.get('TELEMETRY', durableName);
        messages = await consumer.consume();
      } else {
        throw err;
      }
    }
    console.log('[L4] JetStream consumer started');
  } catch (err) {
    jetStreamMode = false;
    console.warn('[L4] Falling back to core NATS:', err?.message || err);
    messages = nc.subscribe('telemetry.raw.*');
  }

  let processed = 0;

  for await (const msg of messages) {
    let event;
    try {
      event = normalizeEvent(JSON.parse(sc.decode(msg.data)));
    } catch (parseErr) {
      console.error('[L4] malformed JSON:', parseErr.message);
      if (jetStreamMode && typeof msg.ack === 'function') msg.ack();
      continue;
    }

    try {
      if (!isValidEvent(event)) {
        if (jetStreamMode && typeof msg.ack === 'function') msg.ack();
        continue;
      }

      const eventTs = Date.parse(event.timestamp);
      const previousTs = lastEventTsByDevice.get(event.device_id);
      if (previousTs != null && eventTs < previousTs) event.buffered = true;
      if (previousTs == null || eventTs >= previousTs) setDeviceTs(event.device_id, eventTs);

      // 1. Update live cache immediately — zero latency for dashboard
      cacheSet(event);

      // 2. Broadcast over WebSocket to all connected clients
      broadcast({ type: 'telemetry', event });

      // 3. Evaluate alerts (may broadcast additional alert events)
      await evaluateAlerts(event, broadcast);

      // 4. Detect trip boundaries (ignition transitions → open/close trips)
      await detectTripBoundary(event);

      // 5. Detect DTC fault codes (non-zero DTC IO fields → write/resolve dtc_events)
      await detectDtcEvent(event);

      // 6. Write to DB in batches — does not block the pipeline
      addToBatch(event);

      if (jetStreamMode && typeof msg.ack === 'function') msg.ack();
      processed++;
      if (processed % 100 === 0) console.log(`[L4] ${processed} events processed`);

    } catch (err) {
      if (err.code === '23514' || err.code === '23505') {
        console.error(`[L4] DB constraint (${err.code}), skipping`);
        if (jetStreamMode && typeof msg.ack === 'function') msg.ack();
      } else {
        console.error('[L4] consumer error:', err.message);
        if (jetStreamMode && typeof msg.nak === 'function') msg.nak();
      }
    }
  }
}
