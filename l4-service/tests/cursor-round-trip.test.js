/**
 * Property test — Cursor Round-Trip (Property 9)
 *
 * **Validates: Requirements 12.2**
 *
 * Property: For all (timestamp, eventId) pairs,
 *   decodeCursor(encodeCursor(t, id)) returns { timestamp: t, eventId: id }
 *
 * The cursor encodes the timestamp as-is (Date objects are serialised via
 * JSON.stringify which calls .toISOString()) and decodes back to the ISO 8601
 * string.  The property therefore compares the encoded string representation
 * rather than the original Date object.
 *
 * How to run:
 *   npm test -- tests/cursor-round-trip.test.js
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { encodeCursor, decodeCursor } from '../src/telemetry-repository.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * fast-check arbitrary that generates RFC 4122-compliant UUID v4 strings.
 * Matches the canonical xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx pattern.
 */
const uuidArbitrary = fc.uuid();

// ─── Deterministic regression guard ──────────────────────────────────────────

describe('encodeCursor / decodeCursor — deterministic regression guards', () => {

  it('round-trips a known (timestamp, eventId) pair unchanged', () => {
    const ts = new Date('2026-06-03T12:00:00.000Z');
    const id = '550e8400-e29b-41d4-a716-446655440000';

    const cursor = encodeCursor(ts, id);
    const decoded = decodeCursor(cursor);

    // JSON.stringify(Date) produces the ISO 8601 string representation
    expect(decoded.timestamp).toBe(ts.toISOString());
    expect(decoded.eventId).toBe(id);
  });

  it('produces a non-empty base64url string (no + / = characters)', () => {
    const ts = new Date('2026-01-01T00:00:00.000Z');
    const id = '00000000-0000-4000-8000-000000000000';

    const cursor = encodeCursor(ts, id);

    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);
    // base64url characters only — no standard base64 padding or + /
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('different (timestamp, id) pairs produce different cursors', () => {
    const id = '550e8400-e29b-41d4-a716-446655440001';
    const c1 = encodeCursor(new Date('2026-06-03T12:00:00.000Z'), id);
    const c2 = encodeCursor(new Date('2026-06-03T13:00:00.000Z'), id);
    expect(c1).not.toBe(c2);
  });
});

// ─── Property 9: Cursor Round-Trip ───────────────────────────────────────────

describe('Property 9: Cursor Round-Trip', () => {

  it('decodeCursor(encodeCursor(t, id)) is identity for all (Date, UUID) pairs', () => {
    /**
     * **Validates: Requirements 12.2**
     *
     * For any Date object and UUID string, encoding and then decoding the cursor
     * must return:
     *   { timestamp: t.toISOString(), eventId: id }
     *
     * This verifies that the base64url ↔ JSON serialisation is lossless and
     * that the opaque cursor representation correctly preserves both fields.
     */
    fc.assert(
      fc.property(
        fc.date(),    // arbitrary Date objects (valid JS Date range)
        uuidArbitrary,
        (t, id) => {
          const cursor = encodeCursor(t, id);
          const decoded = decodeCursor(cursor);

          // The timestamp is serialised through JSON.stringify, which calls
          // Date.prototype.toISOString() — so we compare against that.
          const expectedTimestamp = t.toISOString();

          expect(decoded.timestamp).toBe(expectedTimestamp);
          expect(decoded.eventId).toBe(id);
        }
      ),
      { numRuns: 1000, verbose: false }
    );
  });

  it('decode(encode(t, id)).eventId is preserved for all UUID strings', () => {
    /**
     * **Validates: Requirements 12.2**
     *
     * Isolates the eventId field: UUIDs must survive the encode → decode round-trip
     * byte-for-byte without any normalisation or truncation.
     */
    fc.assert(
      fc.property(
        fc.date(),
        uuidArbitrary,
        (t, id) => {
          const decoded = decodeCursor(encodeCursor(t, id));
          expect(decoded.eventId).toBe(id);
        }
      ),
      { numRuns: 1000, verbose: false }
    );
  });

  it('decode(encode(t, id)).timestamp is the ISO 8601 representation of t', () => {
    /**
     * **Validates: Requirements 12.2**
     *
     * Isolates the timestamp field: the decoded timestamp must equal the ISO 8601
     * string that JSON.stringify produces from the Date object.
     */
    fc.assert(
      fc.property(
        fc.date(),
        uuidArbitrary,
        (t, id) => {
          const decoded = decodeCursor(encodeCursor(t, id));
          expect(decoded.timestamp).toBe(t.toISOString());
        }
      ),
      { numRuns: 1000, verbose: false }
    );
  });

  it('encode is deterministic — same inputs always produce the same cursor', () => {
    /**
     * **Validates: Requirements 12.2**
     *
     * Cursors are used as stable page tokens in API responses.  A deterministic
     * encode function ensures that retrying the same request returns the same cursor.
     */
    fc.assert(
      fc.property(
        fc.date(),
        uuidArbitrary,
        (t, id) => {
          const c1 = encodeCursor(t, id);
          const c2 = encodeCursor(t, id);
          expect(c1).toBe(c2);
        }
      ),
      { numRuns: 500, verbose: false }
    );
  });
});
