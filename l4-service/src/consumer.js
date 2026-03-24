import { connect, StringCodec } from 'nats';
import { writeTelemetry } from './db.js';
import { evaluateAlerts } from './alerts.js';

const sc = StringCodec();
const lastEventTsByDevice = new Map();

export async function startConsumer(broadcast) {
  const nc = await connect({ servers: process.env.NATS_URL || 'nats://nats:4222' });
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
      const eventTs = Date.parse(event.timestamp);
      if (Number.isNaN(eventTs)) {
        throw new Error(`invalid timestamp for ${event.device_id || 'unknown'}`);
      }

      const previousTs = lastEventTsByDevice.get(event.device_id);
      if (previousTs != null && eventTs < previousTs) {
        // Preserve offline replay semantics: process by event timestamp, not receive order.
        event.buffered = true;
      }

      if (previousTs == null || eventTs >= previousTs) {
        lastEventTsByDevice.set(event.device_id, eventTs);
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
