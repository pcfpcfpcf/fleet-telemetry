import { connect, StringCodec } from 'nats';
import { writeTelemetry } from './db.js';
import { evaluateAlerts } from './alerts.js';

const sc = StringCodec();

// ─── FIX 2: bounded device timestamp map ─────────────────────────────────────
// Original Map grew forever with no upper limit — a flood of unique fake device
// IDs would cause unbounded memory growth.
// Cap at 10,000 entries. When full, evict the oldest entry before inserting.
const MAX_TRACKED_DEVICES = 10_000;
const lastEventTsByDevice = new Map();

function setDeviceTs(deviceId, ts) {
  if (!lastEventTsByDevice.has(deviceId) && lastEventTsByDevice.size >= MAX_TRACKED_DEVICES) {
    // Evict oldest entry (Maps preserve insertion order)
    const oldestKey = lastEventTsByDevice.keys().next().value;
    lastEventTsByDevice.delete(oldestKey);
  }
  lastEventTsByDevice.set(deviceId, ts);
}

// ─── FIX 1: basic NATS message validation ────────────────────────────────────
// Events arriving from NATS should already be clean (adapter validated them),
// but we validate the minimum required fields here as a defence-in-depth check
// before writing to the database.
function isValidEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.event_id !== 'string' || !event.event_id) return false;
  if (typeof event.device_id !== 'string' || !event.device_id) return false;
  if (typeof event.timestamp !== 'string' || isNaN(Date.parse(event.timestamp))) return false;
  if (!event.position || typeof event.position !== 'object') return false;
  return true;
}

// ─── Normalize raw C-adapter payloads ────────────────────────────────────────
// The C adapter sends raw Teltonika IO values (integers) rather than cooked
// values. This function coerces them into the types expected downstream.
function normalizeEvent(event) {
  const pos = event.position || {};
  const tel = event.telemetry || {};

  // Position: ensure numbers
  pos.lat = pos.lat != null ? Number(pos.lat) : null;
  pos.lng = pos.lng != null ? Number(pos.lng) : null;
  pos.altitude = pos.altitude != null ? Number(pos.altitude) : null;
  pos.accuracy = pos.accuracy != null ? Number(pos.accuracy) : null;
  pos.bearing = pos.bearing != null ? Number(pos.bearing) : null;
  pos.speed = pos.speed != null ? Number(pos.speed) : null;

  // Telemetry: coerce ignition to boolean (C adapter sends 0/1 or true/false)
  if (tel.ignition != null && typeof tel.ignition !== 'boolean') {
    tel.ignition = Boolean(Number(tel.ignition));
  }
  // Ensure numeric telemetry
  if (tel.fuel_level != null) tel.fuel_level = Number(tel.fuel_level);
  if (tel.odometer != null) tel.odometer = Number(tel.odometer);
  if (tel.rpm != null) tel.rpm = Number(tel.rpm);
  if (tel.engine_load != null) tel.engine_load = Number(tel.engine_load);

  // Fallback: extract from io_events array if telemetry fields are null
  if (Array.isArray(event.io_events)) {
    for (const io of event.io_events) {
      if (!io || io.id == null) continue;
      switch (io.id) {
        case 239: if (tel.ignition == null) tel.ignition = Boolean(io.value); break;
        case 12:  if (tel.fuel_level == null) tel.fuel_level = Number(io.value); break;
        case 16:  if (tel.odometer == null) tel.odometer = Number(io.value); break;
        case 24:  if (pos.speed == null) pos.speed = Number(io.value); break;
      }
    }
  }

  event.position = pos;
  event.telemetry = tel;
  return event;
}

export async function startConsumer(broadcast) {
  const nc = await connect({
    servers: [process.env.NATS_URL || 'nats://nats:4222'],
    user: process.env.NATS_USER,
    pass: process.env.NATS_PASS,
  });
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();

  // Ensure the TELEMETRY stream exists (captures telemetry.raw.* subjects)
  try {
    await jsm.streams.add({
      name: 'TELEMETRY',
      subjects: ['telemetry.raw.>'],
      retention: 'limits',
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanoseconds
      storage: 'file',
      num_replicas: 1,
    });
    console.log('[L4] Created TELEMETRY stream');
  } catch (_err) {
    // Stream already exists — safe to ignore
    console.log('[L4] TELEMETRY stream already exists');
  }

  try {
    await jsm.consumers.add('TELEMETRY', {
      durable_name: 'l4-processor',
      deliver_policy: 'all',
      ack_policy: 'explicit',
      filter_subject: 'telemetry.raw.*',
      replay_policy: 'instant',
    });
  } catch (_err) {
    // Consumer likely already exists; this is safe to ignore.
  }

  const consumer = await js.consumers.get('TELEMETRY', 'l4-processor');
  const messages = await consumer.consume();

  console.log('[L4] NATS consumer started - processing telemetry.raw.*');

  let processed = 0;
  for await (const msg of messages) {
    let event;
    try {
      event = normalizeEvent(JSON.parse(sc.decode(msg.data)));
    } catch (parseErr) {
      console.error('[L4] consumer: malformed JSON, acking to skip:', parseErr.message);
      msg.ack();
      continue;
    }

    try {
      // ─── FIX 1 applied: validate before any processing ───────────────────
      if (!isValidEvent(event)) {
        console.error('[L4] consumer: invalid event structure, skipping');
        msg.ack(); // Ack to prevent redelivery of permanently bad messages
        continue;
      }

      const eventTs = Date.parse(event.timestamp);

      // Timestamp already validated in isValidEvent — no NaN check needed here
      const previousTs = lastEventTsByDevice.get(event.device_id);
      if (previousTs != null && eventTs < previousTs) {
        // Preserve offline replay semantics: process by event timestamp, not receive order.
        event.buffered = true;
      }

      // ─── FIX 2 applied: use bounded setter instead of Map.set directly ────
      if (previousTs == null || eventTs >= previousTs) {
        setDeviceTs(event.device_id, eventTs);
      }

      await writeTelemetry(event);
      await evaluateAlerts(event, broadcast);
      broadcast({ type: 'telemetry', event });

      msg.ack();
      processed++;

      if (processed % 100 === 0) {
        console.log(`[L4] ${processed} events processed`);
      }
    } catch (err) {
      // DB constraint violations are permanent — ack to avoid infinite loop
      if (err.code === '23514' || err.code === '23505') {
        console.error(`[L4] consumer: DB constraint error (${err.code}), skipping: ${err.message}`);
        msg.ack();
      } else {
        console.error('[L4] consumer error:', err.message);
        msg.nak();
      }
    }
  }
}