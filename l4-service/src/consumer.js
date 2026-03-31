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

export async function startConsumer(broadcast) {
  const nc = await connect({
    servers: [process.env.NATS_URL || 'nats://nats:4222'],
    user: process.env.NATS_USER,
    pass: process.env.NATS_PASS,
  });
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();

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
    try {
      const event = JSON.parse(sc.decode(msg.data));

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
      console.error('[L4] consumer error:', err.message);
      msg.nak();
    }
  }
}