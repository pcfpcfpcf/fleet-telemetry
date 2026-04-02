#!/usr/bin/env node

/**
 * Fleet Telemetry Platform - GPS Device Simulator
 *
 * Simulates 50 FMC003 GPS devices sending MQTT messages every 30 seconds
 * to EMQX broker. Used for local development and testing.
 *
 * Payload format: Normalized event schema as per architecture specification
 *
 * mTLS: When MQTT_PROTOCOL=mqtts, connects on port 8883 using client cert/key
 * and CA cert mounted at /certs inside the container.
 */

const mqtt = require('mqtt');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// Configuration
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883');
const MQTT_PROTOCOL = process.env.MQTT_PROTOCOL || 'mqtt';
const SEND_INTERVAL = 30000; // 30 seconds
const DEVICE_COUNT = Math.max(1, parseInt(process.env.SIMULATOR_DEVICE_COUNT || '50', 10) || 50);

// ─── mTLS: load certs if using mqtts ─────────────────────────────────────────
// Certs are mounted into the container at /certs by docker-compose.
// If the protocol is plain mqtt, certs are not loaded and tls is not used.
let tlsOptions = {};
if (MQTT_PROTOCOL === 'mqtts') {
  try {
    tlsOptions = {
      ca:   fs.readFileSync('/certs/ca.crt'),
      cert: fs.readFileSync('/certs/simulator-client.crt'),
      key:  fs.readFileSync('/certs/simulator-client.key'),
      rejectUnauthorized: true,
    };
    console.log('[SIMULATOR] mTLS certs loaded successfully');
  } catch (err) {
    console.error('[SIMULATOR] Failed to load mTLS certs:', err.message);
    console.error('[SIMULATOR] Make sure certs are mounted at /certs/');
    process.exit(1);
  }
}

// Generate simulated vehicles around Tunis
const devices = Array.from({ length: DEVICE_COUNT }, (_, i) => {
  const idx = i + 1;
  const latBase = 36.8 + (Math.random() - 0.5) * 0.2;
  const lngBase = 10.15 + (Math.random() - 0.5) * 0.25;
  return {
    device_id: `FMC003_SIM_${idx.toString().padStart(3, '0')}`,
    imei: `35209311430${5800 + idx}`,
    name: `Vehicle ${String.fromCharCode(65 + (idx - 1) % 26)}${idx}`,
    initialPosition: { lat: latBase, lng: lngBase },
    baseFuel: Math.round(40 + Math.random() * 60),
  };
});

// Vehicle state (position, speed, fuel)
const vehicleState = {};
devices.forEach(device => {
  vehicleState[device.device_id] = {
    lat: device.initialPosition.lat,
    lng: device.initialPosition.lng,
    fuel: device.baseFuel,
    ignition: Math.random() > 0.3,
    odometer: Math.floor(Math.random() * 200000),
    rpm: 0,
    messagesSent: 0,
  };
});

function randomizePosition(lat, lng) {
  const drift = 0.002;
  return {
    lat: lat + (Math.random() - 0.5) * drift,
    lng: lng + (Math.random() - 0.5) * drift,
  };
}

function randomizeSpeed() {
  return Math.random() * 120;
}

function updateFuel(currentFuel) {
  const fuelBurn = Math.random() * 0.5;
  let newFuel = Math.max(0, currentFuel - fuelBurn);
  if (newFuel <= 0) {
    newFuel = 60 + Math.random() * 40;
  }
  return newFuel;
}

function generateEvent(device, state) {
  const position = randomizePosition(state.lat, state.lng);
  const speed = randomizeSpeed();
  const bearing = Math.random() * 360;
  const ignition = state.ignition;
  const fuel = updateFuel(state.fuel);
  const rpm = ignition ? Math.floor(Math.random() * 3000) + 600 : 0;
  const engineLoad = ignition ? Math.random() * 100 : 0;
  const odometer = state.odometer + (speed / 3600) * 0.008;

  state.lat = position.lat;
  state.lng = position.lng;
  state.fuel = fuel;
  state.rpm = rpm;
  state.ignition = ignition;
  state.odometer = odometer;
  state.messagesSent++;

  const timestamp = new Date().toISOString();

  return {
    event_id: uuidv4(),
    device_id: device.device_id,
    timestamp,
    received_at: timestamp,
    position: {
      lat: position.lat,
      lng: position.lng,
      altitude: 10.0 + Math.random() * 30,
      accuracy: 5.0 + Math.random() * 5,
      bearing,
      speed,
    },
    telemetry: {
      ignition,
      fuel_level: Math.round(fuel * 100) / 100,
      odometer: Math.round(odometer * 100) / 100,
      rpm,
      engine_load: Math.round(engineLoad * 100) / 100,
    },
    io_events: [],
    buffered: false,
  };
}

function connectAndSimulate() {
  const clientUrl = `${MQTT_PROTOCOL}://${MQTT_HOST}:${MQTT_PORT}`;
  console.log(`[SIMULATOR] Connecting to MQTT broker at ${clientUrl}...`);

  // ─── mTLS: pass tlsOptions when protocol is mqtts ────────────────────────
  const client = mqtt.connect(clientUrl, {
    reconnectPeriod: 5000,
    keepalive: 60,
    clean: true,
    clientId: `simulator-${process.pid}`,
    ...tlsOptions,
  });

  client.on('connect', () => {
    console.log('[SIMULATOR] Connected to MQTT broker successfully');
    console.log(`[SIMULATOR] Starting to simulate ${devices.length} GPS devices`);
    console.log(`[SIMULATOR] Sending messages every ${SEND_INTERVAL / 1000} seconds\n`);

    setInterval(() => {
      devices.forEach(device => {
        const state = vehicleState[device.device_id];
        const event = generateEvent(device, state);

        const topic = `telemetry/${device.device_id}/raw`;
        const payload = JSON.stringify(event);

        client.publish(topic, payload, { qos: 1 }, (err) => {
          if (err) {
            console.error(`[ERROR] Failed to publish to ${topic}:`, err.message);
          } else {
            console.log(
              `[${new Date().toISOString()}] ${device.name} (${device.device_id}) ` +
              `→ Position: [${event.position.lat.toFixed(4)}, ${event.position.lng.toFixed(4)}] ` +
              `Speed: ${event.position.speed.toFixed(1)} km/h ` +
              `Fuel: ${event.telemetry.fuel_level.toFixed(1)}% ` +
              `Ignition: ${event.telemetry.ignition ? 'ON' : 'OFF'} ` +
              `(msg #${state.messagesSent})`
            );
          }
        });
      });
    }, SEND_INTERVAL);
  });

  client.on('error', (err) => {
    console.error('[ERROR] MQTT connection error:', err.message);
    console.error('[SIMULATOR] Retrying in 5 seconds...');
  });

  client.on('disconnect', () => {
    console.log('[SIMULATOR] Disconnected from MQTT broker');
  });

  client.on('offline', () => {
    console.log('[WARNING] MQTT client went offline');
  });

  process.on('SIGTERM', () => {
    console.log('[SIMULATOR] Received SIGTERM, shutting down gracefully...');
    client.end(false, () => {
      console.log('[SIMULATOR] MQTT connection closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('[SIMULATOR] Received SIGINT, shutting down gracefully...');
    client.end(false, () => {
      console.log('[SIMULATOR] MQTT connection closed');
      process.exit(0);
    });
  });
}

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║   Fleet Telemetry Platform - GPS Device Simulator        ║');
console.log('║   Local Development Environment                          ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

connectAndSimulate();