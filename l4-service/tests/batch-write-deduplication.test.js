/**
 * Property 5: Batch Write Deduplication
 *
 * Generate batches containing forced duplicate `event_id` values and assert
 * that `writeTelemetryBatch()` completes without error and the table holds
 * exactly one row per unique `event_id`.
 *
 * **Validates: Requirements 7.2**
 *
 * How to run:
 *   # Start TimescaleDB locally first (e.g. via docker-compose up timescaledb -d)
 *   # Then run:
 *   TEST_DATABASE_URL=postgresql://fleet:SomeStrongPassword123!@localhost:5432/fleet \
 *     npm test -- tests/batch-write-deduplication.test.js
 *
 * The TEST_DATABASE_URL environment variable controls the connection.
 * If the database is unreachable the test suite is skipped with a warning.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import * as fc from 'fast-check';
import pg from 'pg';
import { writeTelemetryBatch } from '../src/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://fleet:SomeStrongPassword123!@localhost:5432/fleet';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid telemetry event for a given event_id.
 * Uses a fixed timestamp so that duplicate event_id values produce conflicts
 * on the (event_id, timestamp) primary key — which is exactly what
 * ON CONFLICT (event_id, timestamp) DO NOTHING guards against.
 */
function buildEvent(eventId, deviceId, timestamp) {
  return {
    event_id:    eventId,
    device_id:   deviceId,
    timestamp:   timestamp ?? new Date().toISOString(),
    received_at: new Date().toISOString(),
    position: {
      lat:      51.5,
      lng:      -0.1,
      altitude: null,
      accuracy: null,
      bearing:  null,
      speed:    0,
    },
    telemetry: {
      ignition:    false,
      fuel_level:  50,
      odometer:    1000,
      rpm:         null,
      engine_load: null,
    },
    buffered: false,
    // IO fields — all nullable, set to null for minimal event
    ext_voltage:   null,
    bat_voltage:   null,
    bat_level:     null,
    bat_current:   null,
    gnss_status:   null,
    gnss_hdop:     null,
    gnss_pdop:     null,
    movement:      null,
    gsm_signal:    null,
    network_type:  null,
    axis_x:        null,
    axis_y:        null,
    axis_z:        null,
    trip_odometer: null,
    eco_score:     null,
    fuel_rate_gps: null,
    fuel_used_gps: null,
    sleep_mode:    null,
  };
}

/**
 * Delete all telemetry rows for a set of event_ids.
 * Used for test isolation — cleans up rows inserted during each property run.
 */
async function cleanupEvents(client, eventIds) {
  if (eventIds.length === 0) return;
  await client.query(
    'DELETE FROM telemetry WHERE event_id = ANY($1::uuid[])',
    [eventIds],
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Property 5: Batch Write Deduplication', () => {
  let pool;
  let dbAvailable = false;

  beforeAll(async () => {
    // Override DATABASE_URL so writeTelemetryBatch() uses the test database.
    // The pool in db.js is initialised at module load time from process.env.DATABASE_URL.
    // Setting it here before the first import would be ideal, but since db.js has already
    // been imported by the time beforeAll runs we use process.env as a signal and rely on
    // the TEST_DATABASE_URL being set before the test process starts (or falling back to
    // the same default URL that db.js uses).
    process.env.DATABASE_URL = TEST_DB_URL;

    pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 3 });

    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      dbAvailable = true;
    } catch (err) {
      console.warn(
        `[batch-write-deduplication] TimescaleDB not reachable at ${TEST_DB_URL} — skipping tests.\n` +
        `  Start the database with: docker-compose up timescaledb -d\n` +
        `  Error: ${err.message}`,
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  // ── Deterministic baseline ───────────────────────────────────────────────────

  it('duplicate event_id in same batch writes exactly one row', async () => {
    if (!dbAvailable) {
      console.warn('SKIP: database not available');
      return;
    }

    const eventId   = crypto.randomUUID();
    const deviceId  = 'dedup-test-device';
    const timestamp = new Date().toISOString();

    // Build a batch with the same event_id three times
    const batch = [
      buildEvent(eventId, deviceId, timestamp),
      buildEvent(eventId, deviceId, timestamp),
      buildEvent(eventId, deviceId, timestamp),
    ];

    const client = await pool.connect();
    try {
      await writeTelemetryBatch(batch);

      const result = await client.query(
        'SELECT COUNT(*) AS cnt FROM telemetry WHERE event_id = $1',
        [eventId],
      );

      expect(Number(result.rows[0].cnt)).toBe(1);
    } finally {
      await cleanupEvents(client, [eventId]);
      client.release();
    }
  });

  // ── Property-based test ──────────────────────────────────────────────────────
  // For each generated list of unique UUIDs (3–10 IDs), each ID is duplicated
  // 1–3 extra times inside the batch.  After the write, exactly one row must
  // exist per unique event_id — no more, no less.
  //
  // **Validates: Requirements 7.2**

  it('table holds exactly one row per unique event_id for any batch with duplicates', async () => {
    if (!dbAvailable) {
      console.warn('SKIP: database not available');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        // Generate between 3 and 10 distinct UUIDs
        fc.array(fc.uuid(), { minLength: 3, maxLength: 10 }),
        // For each UUID, how many extra duplicates to add (1–3)
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 10 }),
        async (uniqueIds, duplicateCounts) => {
          // Align arrays — use the shorter length
          const len = Math.min(uniqueIds.length, duplicateCounts.length);
          const ids   = uniqueIds.slice(0, len);
          const dups  = duplicateCounts.slice(0, len);

          // Deduplicate the generated UUIDs (fast-check does not guarantee uniqueness)
          const deduped = [...new Set(ids)];

          // Build a batch where each ID appears at least twice
          const timestamp = new Date().toISOString();
          const deviceId  = 'dedup-prop-device';
          const batch = [];
          for (let i = 0; i < deduped.length; i++) {
            const extraCopies = dups[i] ?? 1;
            // First copy + extraCopies duplicates = (1 + extraCopies) total
            for (let k = 0; k <= extraCopies; k++) {
              batch.push(buildEvent(deduped[i], deviceId, timestamp));
            }
          }

          const client = await pool.connect();
          try {
            // writeTelemetryBatch must complete without throwing
            await writeTelemetryBatch(batch);

            // Query the actual row count per event_id
            const result = await client.query(
              `SELECT event_id, COUNT(*) AS cnt
               FROM telemetry
               WHERE event_id = ANY($1::uuid[])
               GROUP BY event_id`,
              [deduped],
            );

            // Every event_id in the batch must have exactly one row
            const rowMap = Object.fromEntries(
              result.rows.map(r => [r.event_id, Number(r.cnt)]),
            );

            for (const id of deduped) {
              expect(rowMap[id]).toBe(1);
            }

            return true;
          } finally {
            await cleanupEvents(client, deduped);
            client.release();
          }
        },
      ),
      {
        numRuns: 10,
        seed: 42,
        verbose: true,
      },
    );
  });
});
