import { startApi } from './api.js';
import { startConsumer } from './consumer.js';
import { pool } from './db.js';

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
const broadcast = startApi();
await startConsumer(broadcast);
