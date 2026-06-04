import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ESM-native project — no transform needed
    environment: 'node',
    globals: false,
    // Generous timeout for property tests that spin up real DB connections
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // Provide a default DATABASE_URL so db.js can initialise its Pool during tests.
    // Individual test files override this via process.env.DATABASE_URL in beforeAll
    // or via the TEST_DATABASE_URL environment variable at run time.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        process.env.DATABASE_URL ??
        'postgresql://fleet:SomeStrongPassword123!@localhost:5432/fleet',
    },
  },
});
