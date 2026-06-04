import { startApi } from './api.js';
import { startConsumer } from './consumer.js';
import { pool } from './db.js';
import { createTelemetryRepository } from './telemetry-repository.js';
import { createTelemetryService } from './telemetry-service.js';
import { startOfflineMonitor, loadGeofences, setupGeofenceListener, seedAlertStateFromDb } from './alerts.js';

console.log('[L4] Starting Fleet Telemetry L4 Processing Service...');

async function waitForDb(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('[L4] TimescaleDB connected');
      return;
    } catch {
      console.log(`[L4] Waiting for DB... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('Could not connect to TimescaleDB');
}

await waitForDb();
const repository = createTelemetryRepository(pool);
const service = createTelemetryService(repository);
const broadcast = startApi(service);
startOfflineMonitor(broadcast);
await loadGeofences();
await setupGeofenceListener();
await seedAlertStateFromDb();
await startConsumer(broadcast);
