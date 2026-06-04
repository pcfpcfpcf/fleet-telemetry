/**
 * Property 2: Migration Idempotence
 *
 * Run all three migration files (02_telemetry_columns.sql, 03_domain_tables.sql,
 * 04_views_and_alerts.sql) twice against a test TimescaleDB database and assert
 * that the resulting schema is identical after both runs.
 *
 * **Validates: Requirements 1.5**
 *
 * How to run:
 *   # Start TimescaleDB locally first (e.g. via docker-compose up timescaledb -d)
 *   # Then run:
 *   TEST_DATABASE_URL=postgresql://fleet:SomeStrongPassword123!@localhost:5432/fleet \
 *     npm test -- tests/migration-idempotence.test.js
 *
 * The TEST_DATABASE_URL environment variable controls the connection.
 * If the database is unreachable the test suite is skipped with a warning.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import * as fc from 'fast-check';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../init/timescaledb');

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://fleet:SomeStrongPassword123!@localhost:5432/fleet';

// Isolated test schema — dropped and recreated each test run
const TEST_SCHEMA = 'migration_idempotence_test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read a SQL migration file and return its content.
 */
async function readMigration(filename) {
  return readFile(join(MIGRATIONS_DIR, filename), 'utf8');
}

/**
 * Split a SQL file into individual statements.
 *
 * PostgreSQL statements like CREATE MATERIALIZED VIEW ... WITH DATA and
 * create_hypertable() must run outside a multi-statement implicit transaction.
 * The pg driver runs each query() call in autocommit mode, so we split files
 * into individual statements and execute them one at a time.
 *
 * The splitter handles:
 *   - Dollar-quoted blocks ($$ ... $$ and $BODY$ ... $BODY$) — these may
 *     contain semicolons that are NOT statement delimiters.
 *   - Single-line comments (--)
 *   - Multi-line comments (slash-star ... star-slash)
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Dollar-quoting: find the tag (e.g. $$ or $BODY$) and skip until closing tag
    if (ch === '$') {
      // Look ahead for the closing $ of the tag
      const tagEnd = sql.indexOf('$', i + 1);
      if (tagEnd !== -1) {
        const tag = sql.slice(i, tagEnd + 1); // e.g. "$$" or "$BODY$"
        const closeTag = sql.indexOf(tag, tagEnd + 1);
        if (closeTag !== -1) {
          current += sql.slice(i, closeTag + tag.length);
          i = closeTag + tag.length;
          continue;
        }
      }
    }

    // Single-line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) {
        current += sql.slice(i);
        i = sql.length;
      } else {
        current += sql.slice(i, end + 1);
        i = end + 1;
      }
      continue;
    }

    // Multi-line comment  /* ... */
    if (ch === '/' && sql[i + 1] === '*') {
      const CLOSE = '*' + '/';
      const end = sql.indexOf(CLOSE, i + 2);
      if (end === -1) {
        current += sql.slice(i);
        i = sql.length;
      } else {
        current += sql.slice(i, end + 2);
        i = end + 2;
      }
      continue;
    }

    // Statement delimiter
    if (ch === ';') {
      current += ';';
      const trimmed = current.trim();
      if (trimmed && trimmed !== ';') {
        statements.push(trimmed);
      }
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // Any trailing content without a semicolon
  const trimmed = current.trim();
  if (trimmed) {
    statements.push(trimmed);
  }

  return statements;
}

/**
 * Execute a single SQL statement outside any transaction block.
 * Some DDL (CREATE MATERIALIZED VIEW WITH DATA, create_hypertable, etc.)
 * requires autocommit — never call this inside a BEGIN/COMMIT block.
 */
async function execStatement(client, stmt) {
  // Skip empty or comment-only statements
  const clean = stmt.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!clean || clean === ';') return;
  await client.query(stmt);
}

/**
 * Apply all migration files in order against the given client.
 * Each statement in each file is executed individually in autocommit mode.
 */
async function applyMigrations(client) {
  const files = [
    '01_schema.sql',
    '02_telemetry_columns.sql',
    '03_domain_tables.sql',
    '04_views_and_alerts.sql',
  ];
  for (const f of files) {
    const sql = await readMigration(f);
    const stmts = splitStatements(sql);
    for (const stmt of stmts) {
      await execStatement(client, stmt);
    }
  }
}

/**
 * Snapshot the current schema: returns a sorted JSON string describing
 * columns, constraints, indexes, and views visible in the test schema.
 * This is used to compare schema state before and after a second run.
 */
async function snapshotSchema(client) {
  const [columns, constraints, indexes, views] = await Promise.all([
    // All column definitions in user tables
    client.query(`
      SELECT table_name, column_name, data_type,
             is_nullable, column_default, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name NOT LIKE 'pg_%'
      ORDER BY table_name, ordinal_position
    `, [TEST_SCHEMA]),

    // Check and unique constraints
    client.query(`
      SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
             cc.check_clause
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.check_constraints cc
        ON cc.constraint_schema = tc.constraint_schema
       AND cc.constraint_name   = tc.constraint_name
      WHERE tc.constraint_schema = $1
      ORDER BY tc.table_name, tc.constraint_name
    `, [TEST_SCHEMA]),

    // Indexes (pg_indexes is schema-aware)
    client.query(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = $1
      ORDER BY tablename, indexname
    `, [TEST_SCHEMA]),

    // Materialized views
    client.query(`
      SELECT matviewname, definition
      FROM pg_matviews
      WHERE schemaname = $1
      ORDER BY matviewname
    `, [TEST_SCHEMA]),
  ]);

  return JSON.stringify({
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    views: views.rows,
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Property 2: Migration Idempotence', () => {
  let adminPool;
  let dbAvailable = false;

  beforeAll(async () => {
    // Try to connect; if unreachable, mark as unavailable and skip all tests.
    adminPool = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });
    try {
      const client = await adminPool.connect();
      await client.query('SELECT 1');
      client.release();
      dbAvailable = true;
    } catch (err) {
      console.warn(
        `[migration-idempotence] TimescaleDB not reachable at ${TEST_DB_URL} — skipping tests.\n` +
        `  Start the database with: docker-compose up timescaledb -d\n` +
        `  Error: ${err.message}`
      );
    }
  });

  afterAll(async () => {
    await adminPool.end();
  });

  // ── Deterministic baseline test ─────────────────────────────────────────────

  it('schema is identical after applying all migrations a second time', async () => {
    if (!dbAvailable) {
      // Soft-skip: vitest does not have a built-in skip inside beforeAll,
      // so we use a conditional return with a note.
      console.warn('SKIP: database not available');
      return;
    }

    const client = await adminPool.connect();
    try {
      // Create a fresh isolated schema for this run
      await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
      await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
      // Ensure all DDL resolves into the test schema
      await client.query(`SET search_path TO "${TEST_SCHEMA}", public`);

      // ── First run ──
      await applyMigrations(client);
      const snapshotAfterFirstRun = await snapshotSchema(client);

      // ── Second run (idempotence check) ──
      await applyMigrations(client);
      const snapshotAfterSecondRun = await snapshotSchema(client);

      expect(snapshotAfterSecondRun).toEqual(snapshotAfterFirstRun);
    } finally {
      // Reset search_path and clean up
      try {
        await client.query(`SET search_path TO public`);
        await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
      } catch (_) { /* best-effort cleanup */ }
      client.release();
    }
  });

  // ── Property-based test ─────────────────────────────────────────────────────
  // fast-check drives arbitrary run counts (between 2 and 5 inclusive).
  // For each generated count the migrations are applied that many times and
  // we assert every snapshot after the first is equal to the first.
  //
  // **Validates: Requirements 1.5**

  it('schema remains stable across N ≥ 2 consecutive migration runs', async () => {
    if (!dbAvailable) {
      console.warn('SKIP: database not available');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        // Generate a run count between 2 and 5
        fc.integer({ min: 2, max: 5 }),
        async (runCount) => {
          const client = await adminPool.connect();
          const schemaName = `${TEST_SCHEMA}_${runCount}_${Date.now()}`;
          try {
            await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
            await client.query(`CREATE SCHEMA "${schemaName}"`);
            await client.query(`SET search_path TO "${schemaName}", public`);

            // First application — establishes baseline
            await applyMigrations(client);
            const baseline = await snapshotSchema(client);

            // Subsequent applications must leave the schema unchanged
            for (let i = 1; i < runCount; i++) {
              await applyMigrations(client);
              const snapshot = await snapshotSchema(client);
              if (snapshot !== baseline) {
                // Return the failing details so fast-check can shrink
                throw new Error(
                  `Schema changed on run ${i + 1} of ${runCount}.\n` +
                  `Expected: ${baseline.slice(0, 300)}…\n` +
                  `Received: ${snapshot.slice(0, 300)}…`
                );
              }
            }

            return true;
          } finally {
            try {
              await client.query(`SET search_path TO public`);
              await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
            } catch (_) { /* best-effort cleanup */ }
            client.release();
          }
        }
      ),
      {
        // Run 4 examples (2, 3, 4, 5 runs)
        numRuns: 4,
        // Use a fixed seed for deterministic CI reproduction
        seed: 42,
        verbose: true,
      }
    );
  });
});
