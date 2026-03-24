#!/usr/bin/env node

/**
 * Fleet Telemetry Platform - MQTT to NATS Adapter
 * 
 * Bridges EMQX MQTT broker to NATS JetStream.
 * Reads normalized telemetry events from EMQX topics (telemetry/#)
 * and publishes them to NATS stream TELEMETRY.
 * 
 * This allows the simulator to send JSON to MQTT, which gets
 * forwarded to NATS for consumption by L4 processing service.
 */

const mqtt = require('mqtt');
const express = require('express');
const { randomUUID } = require('crypto');
const { connect, StringCodec } = require('nats');

// Configuration from environment
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883');
const MQTT_PROTOCOL = process.env.MQTT_PROTOCOL || 'mqtt';

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const sc = StringCodec();

// Normalized event schema validation
const REQUIRED_FIELDS = {
  event_id: 'string',
  device_id: 'string',
  timestamp: 'string',
  received_at: 'string',
  position: 'object',
  telemetry: 'object',
  io_events: 'array',
  buffered: 'boolean',
};

const POSITION_FIELDS = {
  lat: 'number',
  lng: 'number',
  altitude: 'number',
  accuracy: 'number',
  bearing: 'number',
  speed: 'number',
};

const TELEMETRY_FIELDS = {
  ignition: 'boolean',
  fuel_level: 'number',
  odometer: 'number',
  rpm: 'number',
  engine_load: 'number',
};

/**
 * Validate event against normalized schema
 * @param {object} event
 * @returns {object} { valid: boolean, errors: string[] }
 */
function validateEvent(event) {
  const errors = [];

  // Check required top-level fields
  for (const [field, expectedType] of Object.entries(REQUIRED_FIELDS)) {
    if (!(field in event)) {
      errors.push(`Missing required field: ${field}`);
      continue;
    }

    let actualType = typeof event[field];
    if (actualType === 'object' && Array.isArray(event[field])) {
      actualType = 'array';
    }

    if (actualType !== expectedType && expectedType !== 'number') {
      if (expectedType === 'number' && isNaN(event[field])) {
        errors.push(`Field ${field}: expected ${expectedType}, got ${actualType}`);
      }
    }
  }

  // Validate position object
  if (event.position) {
    for (const [field, expectedType] of Object.entries(POSITION_FIELDS)) {
      if (field in event.position) {
        if (typeof event.position[field] !== expectedType) {
          errors.push(`position.${field}: expected ${expectedType}, got ${typeof event.position[field]}`);
        }
      }
    }
  }

  // Validate telemetry object
  if (event.telemetry) {
    for (const [field, expectedType] of Object.entries(TELEMETRY_FIELDS)) {
      if (field in event.telemetry && event.telemetry[field] !== null) {
        if (typeof event.telemetry[field] !== expectedType) {
          errors.push(
            `telemetry.${field}: expected ${expectedType}, got ${typeof event.telemetry[field]}`
          );
        }
      }
    }
  }

  // Validate timestamp formats (ISO 8601)
  if (event.timestamp && isNaN(Date.parse(event.timestamp))) {
    errors.push('Field timestamp: invalid ISO 8601 format');
  }
  if (event.received_at && isNaN(Date.parse(event.received_at))) {
    errors.push('Field received_at: invalid ISO 8601 format');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Main adapter loop
 */
async function startAdapter() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   Fleet Telemetry Platform - MQTT to NATS Adapter        ║');
  console.log('║   Local Development Environment                          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Connect to NATS first
  console.log(`[ADAPTER] Connecting to NATS at ${NATS_URL}...`);

  let natsConnection;
  let jetstream;
  let jetstreamManager;

  const publishToNats = async (event) => {
    const natsSubject = `telemetry.raw.${event.device_id}`;
    await jetstream.publish(natsSubject, sc.encode(JSON.stringify(event)));
  };

  try {
    natsConnection = await connect({
      servers: [NATS_URL],
      reconnect: true,
      maxReconnectAttempts: -1, // Infinite retries
      reconnectDelayHandler: () => 5000,
    });

    jetstream = natsConnection.jetstream();
    jetstreamManager = await natsConnection.jetstreamManager();

    // Ensure TELEMETRY stream exists for telemetry subjects.
    try {
      await jetstreamManager.streams.info('TELEMETRY');
      console.log('[ADAPTER] ✓ JetStream stream TELEMETRY exists');
    } catch (_) {
      await jetstreamManager.streams.add({
        name: 'TELEMETRY',
        subjects: ['telemetry.raw.>', 'telemetry.events.>'],
        max_age: 24 * 60 * 60 * 1000000000,
      });
      console.log('[ADAPTER] ✓ Created JetStream stream TELEMETRY');
    }

    console.log('[ADAPTER] ✓ Connected to NATS\n');
  } catch (err) {
    console.error('[ERROR] Failed to connect to NATS:', err.message);
    process.exit(1);
  }

  // HTTP server for health and Traccar webhook ingestion.
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', ts: new Date().toISOString() });
  });

  app.post('/events', async (req, res) => {
    try {
      const raw = req.body;
      if (!raw?.device?.uniqueId || !raw?.position) {
        return res.status(400).json({ error: 'missing device or position' });
      }

      const event = {
        event_id: randomUUID(),
        device_id: raw.device.uniqueId,
        timestamp: raw.position.fixTime || new Date().toISOString(),
        received_at: new Date().toISOString(),
        position: {
          lat: raw.position.latitude ?? null,
          lng: raw.position.longitude ?? null,
          altitude: raw.position.altitude ?? null,
          accuracy: raw.position.accuracy ?? null,
          bearing: raw.position.course ?? null,
          speed: raw.position.speed ?? null,
        },
        telemetry: {
          ignition: raw.position.attributes?.ignition ?? null,
          fuel_level: raw.position.attributes?.fuel ?? null,
          odometer: raw.position.attributes?.odometer ?? null,
          rpm: raw.position.attributes?.rpm ?? null,
          engine_load: raw.position.attributes?.engineLoad ?? null,
        },
        io_events: [],
        buffered: false,
      };

      await publishToNats(event);
      return res.status(200).json({ ok: true, event_id: event.event_id });
    } catch (err) {
      console.error('[ERROR] POST /events failed:', err.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  app.listen(3000, () => {
    console.log('[ADAPTER] HTTP server listening on :3000');
  });

  // Connect to MQTT after NATS is ready
  const mqttUrl = `${MQTT_PROTOCOL}://${MQTT_HOST}:${MQTT_PORT}`;
  console.log(`[ADAPTER] Connecting to MQTT broker at ${mqttUrl}...`);

  const mqttClient = mqtt.connect(mqttUrl, {
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    keepalive: 60,
    clean: true,
    clientId: `adapter-${process.pid}`,
  });

  // Statistics tracking
  let messageCount = 0;
  let validCount = 0;
  let invalidCount = 0;
  const startTime = Date.now();

  // MQTT event handlers
  mqttClient.on('connect', () => {
    console.log('[ADAPTER] ✓ Connected to MQTT broker');
    console.log('[ADAPTER] Subscribing to telemetry/# ...\n');

    mqttClient.subscribe('telemetry/#', (err) => {
      if (err) {
        console.error('[ERROR] Failed to subscribe:', err.message);
      }
    });
  });

  mqttClient.on('reconnect', () => {
    console.log('[ADAPTER] Reconnecting to MQTT broker...');
  });

  mqttClient.on('close', () => {
    console.warn('[WARNING] MQTT connection closed');
  });

  mqttClient.on('message', async (topic, message) => {
    messageCount++;

    try {
      // Parse message
      const eventString = message.toString();
      let event;

      try {
        event = JSON.parse(eventString);
      } catch (e) {
        console.error(
          `[ERROR] Invalid JSON from ${topic}: ${e.message}`
        );
        invalidCount++;
        return;
      }

      // Validate event
      const validation = validateEvent(event);
      if (!validation.valid) {
        console.error(
          `[ERROR] Event validation failed for ${event.device_id || 'unknown'}:`
        );
        validation.errors.forEach((err) => console.error(`         - ${err}`));
        invalidCount++;
        return;
      }

      // Publish to NATS
      await publishToNats(event);

      validCount++;

      // Log success
      console.log(
        `[${new Date().toISOString()}] ✓ ${event.device_id} ` +
        `(Speed: ${event.position.speed.toFixed(1)} km/h, ` +
        `Fuel: ${event.telemetry.fuel_level != null ? event.telemetry.fuel_level.toFixed(1) : 'N/A'}%, ` +
        `Ignition: ${event.telemetry.ignition ? 'ON' : 'OFF'}) → NATS`
      );

      // Print stats every 50 messages
      if (validCount % 50 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (validCount / elapsed).toFixed(2);
        console.log(
          `[STATS] Processed: ${validCount} valid, ${invalidCount} invalid (${rate} msg/sec)\n`
        );
      }
    } catch (err) {
      console.error(`[ERROR] Processing message: ${err.message}`);
      invalidCount++;
    }
  });

  mqttClient.on('error', (err) => {
    console.error('[ERROR] MQTT error:', err.message);
  });

  mqttClient.on('offline', () => {
    console.warn('[WARNING] MQTT client offline');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[ADAPTER] Received shutdown signal, shutting down gracefully...');

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = (validCount / elapsed).toFixed(2);

    console.log(`[STATS] Final: ${validCount} valid, ${invalidCount} invalid (${rate} msg/sec)`);
    console.log('[ADAPTER] Closing MQTT connection...');

    mqttClient.end(false, () => {
      console.log('[ADAPTER] MQTT connection closed');
    });

    if (natsConnection) {
      console.log('[ADAPTER] Closing NATS connection...');
      await natsConnection.close();
      console.log('[ADAPTER] NATS connection closed');
    }

    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Start
startAdapter().catch((err) => {
  console.error('[FATAL] Adapter failed:', err);
  process.exit(1);
});
