#!/usr/bin/env node

/**
 * Fleet Telemetry Platform - GPS Device Simulator
 * 
 * Simulates 5 FMC003 GPS devices sending MQTT messages every 30 seconds
 * to EMQX broker. Used for local development and testing.
 * 
 * Payload format: Normalized event schema as per architecture specification
 */

const mqtt = require('mqtt');
const { v4: uuidv4 } = require('uuid');

// Configuration
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883');
const MQTT_PROTOCOL = process.env.MQTT_PROTOCOL || 'mqtt';
const SEND_INTERVAL = 30000; // 30 seconds

// Simulated vehicles - 5 fake devices around Tunis
const devices = [
  {
    device_id: 'FMC003_SIM_001',
    imei: '352093114305816',
    name: 'Vehicle Alpha',
    initialPosition: { lat: 36.8065, lng: 10.1815 }, // City center
    baseFuel: 100,
  },
  {
    device_id: 'FMC003_SIM_002',
    imei: '352093114305817',
    name: 'Vehicle Beta',
    initialPosition: { lat: 36.7372, lng: 10.2352 }, // South
    baseFuel: 85,
  },
  {
    device_id: 'FMC003_SIM_003',
    imei: '352093114305818',
    name: 'Vehicle Gamma',
    initialPosition: { lat: 36.8901, lng: 10.1234 }, // North
    baseFuel: 70,
  },
  {
    device_id: 'FMC003_SIM_004',
    imei: '352093114305819',
    name: 'Vehicle Delta',
    initialPosition: { lat: 36.8200, lng: 10.0800 }, // West
    baseFuel: 55,
  },
  {
    device_id: 'FMC003_SIM_005',
    imei: '352093114305820',
    name: 'Vehicle Epsilon',
    initialPosition: { lat: 36.8100, lng: 10.3000 }, // East
    baseFuel: 40,
  },
];

// Vehicle state (position, speed, fuel)
const vehicleState = {};
devices.forEach(device => {
  vehicleState[device.device_id] = {
    lat: device.initialPosition.lat,
    lng: device.initialPosition.lng,
    fuel: device.baseFuel,
    ignition: Math.random() > 0.3, // 70% of vehicles running
    odometer: Math.floor(Math.random() * 200000),
    rpm: 0,
    messagesSent: 0,
  };
});

/**
 * Randomize position with small drift (simulate vehicle movement)
 */
function randomizePosition(lat, lng) {
  const drift = 0.002; // ~200 meters in lat/lng degrees
  return {
    lat: lat + (Math.random() - 0.5) * drift,
    lng: lng + (Math.random() - 0.5) * drift,
  };
}

/**
 * Randomize speed (0-120 km/h)
 */
function randomizeSpeed() {
  return Math.random() * 120;
}

/**
 * Randomize fuel level (slowly decreasing)
 */
function updateFuel(currentFuel) {
  const fuelBurn = Math.random() * 0.5; // Lose 0-0.5% per 30 seconds
  return Math.max(0, currentFuel - fuelBurn);
}

/**
 * Generate normalized telemetry event schema
 */
function generateEvent(device, state) {
  const position = randomizePosition(state.lat, state.lng);
  const speed = randomizeSpeed();
  const bearing = Math.random() * 360;
  const ignition = state.ignition;
  const fuel = updateFuel(state.fuel);
  const rpm = ignition ? Math.floor(Math.random() * 3000) + 600 : 0;
  const engineLoad = ignition ? Math.random() * 100 : 0;
  const odometer = state.odometer + (speed / 3600) * 0.008; // Approximate km traveled in 30s

  // Update state
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
      altitude: 10.0 + Math.random() * 30, // 10-40 meters
      accuracy: 5.0 + Math.random() * 5,
      bearing,
      speed,
    },
    telemetry: {
      ignition,
      fuel_level: Math.round(fuel * 100) / 100,
      odometer: Math.round(odometer * 100) / 100,
      rpm: rpm,
      engine_load: Math.round(engineLoad * 100) / 100,
    },
    io_events: [],
    buffered: false,
  };
}

/**
 * Connect to MQTT broker and start sending messages
 */
function connectAndSimulate() {
  const clientUrl = `${MQTT_PROTOCOL}://${MQTT_HOST}:${MQTT_PORT}`;
  console.log(`[SIMULATOR] Connecting to MQTT broker at ${clientUrl}...`);

  const client = mqtt.connect(clientUrl, {
    reconnectPeriod: 5000,
    keepalive: 60,
    clean: true,
    clientId: `simulator-${process.pid}`,
  });

  client.on('connect', () => {
    console.log('[SIMULATOR] Connected to MQTT broker successfully');
    console.log(`[SIMULATOR] Starting to simulate ${devices.length} GPS devices`);
    console.log(`[SIMULATOR] Sending messages every ${SEND_INTERVAL / 1000} seconds\n`);

    // Start sending messages
    setInterval(() => {
      devices.forEach(device => {
        const state = vehicleState[device.device_id];
        const event = generateEvent(device, state);

        // Publish to MQTT topic
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

  // Graceful shutdown
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

// Start the simulator
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║   Fleet Telemetry Platform - GPS Device Simulator         ║');
console.log('║   Local Development Environment                           ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

connectAndSimulate();
