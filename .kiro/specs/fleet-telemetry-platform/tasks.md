# Implementation Plan: Fleet Telemetry Platform

## Overview

Incremental implementation across four phases: (1) TimescaleDB schema migration and L4-Service
backend extensions, (2) Next.js frontend foundation with live data, (3) advanced UI pages, and
(4) infrastructure cleanup removing Odoo/Traccar/EMQX artifacts. Each task builds on the previous
so the system remains deployable after every step.

---

## Tasks

- [x] 1. Write TimescaleDB migration scripts under `init/timescaledb/`
  - Split the v2 schema additions into three focused files executed in order:
    - `02_telemetry_columns.sql` — 18 new `telemetry` columns, CHECK constraints, and two indexes
    - `03_domain_tables.sql` — `drivers`, `trips`, `dtc_events`, `device_config` tables; `devices`
      column extensions; FK constraints; retention policies
    - `04_views_and_alerts.sql` — `telemetry_daily_summary` continuous aggregate; `alerts` severity
      CHECK update; GRANT statements; `telemetry_daily_summary` refresh policy:
      `start_offset => INTERVAL '2 days'`, `end_offset => INTERVAL '1 hour'`,
      `schedule_interval => INTERVAL '1 day'`; include this explicitly in the SQL file — without it
      the view is never automatically refreshed and analytics data will be stale
  - Verify `telemetry_hourly_summary` already exists in `01_schema.sql` before creating
    `telemetry_daily_summary` — add an explicit comment in `04_views_and_alerts.sql` noting the
    dependency and confirming no duplicate creation is needed
  - All DDL wrapped with `IF NOT EXISTS` / `EXCEPTION WHEN duplicate_column` guards in every file
  - Add a comment block at the top of each file listing its prerequisites (prior migration files)
  - _Requirements: 1.1–1.5, 2.1–2.4, 3.1, 4.1, 5.1, 6.1, 8.8–8.9_

  - [x] 1.1 Write property test for migration idempotence (Property 2)
    - **Property 2: Migration Idempotence**
    - Run all three migration files twice against a test DB and assert schema is identical after both runs
    - **Validates: Requirements 1.5**

- [ ] 2. Extend `l4-service/src/db.js` — new write helpers
  - [x] 2.1 Update `writeTelemetryBatch()` INSERT to include all 18 new columns
    - Add the 18 new column names to the INSERT column list and corresponding `$N` placeholders
    - Map each column to its field in the normalised event object (IO_MAP names)
    - Keep `ON CONFLICT (event_id) DO NOTHING` behaviour unchanged
    - _Requirements: 7.1, 7.2, 7.3_

  - [-] 2.2 Write property test for batch write deduplication (Property 5)
    - **Property 5: Batch Write Deduplication**
    - Generate batches containing forced duplicate `event_id` values via `fc.array(fc.uuid())`
    - Assert `writeTelemetryBatch()` completes without error and the table holds exactly one row per unique `event_id`
    - **Validates: Requirements 7.2**

  - [x] 2.3 Add `writeTripOpen()`, `writeTripClose()`, `writeDriverAssignment()` helpers
    - `writeTripOpen(deviceId, driverId, startedAt, startLat, startLng)` — INSERT into `trips`,
      returns the generated `trip_id` for storage in the live cache
    - `writeTripClose(tripId, endedAt, endLat, endLng, distanceMeters, durationSeconds, maxSpeedKmh, avgSpeedKmh, fuelConsumedLiters, ecoScore)` — UPDATE trips with all
      accumulated metrics; compute `duration_seconds = EXTRACT(EPOCH FROM ended_at - started_at)`
    - `writeDriverAssignment(deviceId, driverId)` — UPDATE devices SET driver_id
    - _Requirements: 3.3, 4.2, 4.3_

  - [x] 2.4 Add `writeDtcEvent()` and `resolveDtcEvent()` helpers
    - `writeDtcEvent(deviceId, timestamp, dtcCode, rawValue, eventId)` — INSERT into `dtc_events`
    - `resolveDtcEvent(deviceId, dtcCode)` — UPDATE dtc_events SET resolved_at = NOW() WHERE resolved_at IS NULL
    - _Requirements: 5.2, 5.4_

  - [x] 2.5 Add `writeDeviceConfig()` and `readDeviceConfig()` helpers
    - INSERT into `device_config`, SELECT latest record for device
    - _Requirements: 6.1, 6.2_

  - [x] 2.6 Update `devices.last_seen` on valid event receipt
    - Add an UPDATE statement inside `writeTelemetryBatch()` (or a separate `touchDeviceLastSeen()`) to set `last_seen = NOW()` for the device
    - _Requirements: 7.4_

- [ ] 3. Extend `l4-service/src/consumer.js` — trip and DTC side-effects
  - [-] 3.1 Implement `detectTripBoundary(event, prevIgnition)` in `consumer.js`
    - Compare `event.ignition` with the previously cached `ignition` state for the device
    - On `FALSE → TRUE` transition: call `writeTripOpen()`; store active `trip_id` in live cache
    - On `TRUE → FALSE` transition: call `writeTripClose()` using cached active `trip_id`
    - Guard against missing previous state (first event for device) — treat as trip open if ignition is TRUE
    - **Trip metric accumulation**: maintain an in-memory accumulator per active trip in the live
      cache with fields `maxSpeedKmh`, `totalFuelUsed` (sum of `fuel_used_gps` IO 12 deltas),
      `ecoScoreSamples` (array for averaging); flush accumulated values into `writeTripClose()`
    - `fuel_used_gps` (IO 12) is treated as a **cumulative counter** on FMC003; compute delta as
      `current - previous` per event; the FMC003 simulator reports at `moving_interval_s = 1.0 s`
      (idle: 5 s, ignition-off: 10 s) — set `MAX_REASONABLE_FUEL_DELTA = 0.5` litres per event
      (≈ 1 800 L/h, safely above any HGV at a 1 s reporting rate); if `delta < 0` (counter reset
      on device reboot) set delta to 0; if `delta > MAX_REASONABLE_FUEL_DELTA` discard as sensor
      noise and set delta to 0; store `previousFuelUsedGps` per device in the live cache alongside
      the trip accumulator; if the production device uses a different reporting interval, update
      `MAX_REASONABLE_FUEL_DELTA` to `<max_litres_per_hour> / 3600 * <interval_seconds>`
    - _Requirements: 4.2, 4.3_

  - [~] 3.2 Write property test for trip round-trip open/close (Property 4)
    - **Property 4: Trip Round-Trip (Open then Close)**
    - Generate arbitrary ignition sequences using `fc.array(fc.boolean())` for a device
    - Assert that for every `FALSE → TRUE → FALSE` transition the resulting `trips` row has `status = 'completed'`, `ended_at > started_at`, and matching `end_lat`/`end_lng`
    - **Validates: Requirements 4.2, 4.3**

  - [-] 3.3 Implement `detectDtcEvent(event)` in `consumer.js`
    - Extract non-zero DTC IO field values from the event
    - Call `writeDtcEvent()` for each detected code
    - Track per-device DTC absence streak in the live cache as `dtcAbsenceCount[deviceId][dtcCode]`;
      increment on each event where the code is absent; call `resolveDtcEvent()` only after **3
      consecutive absences** to avoid noisy open/close cycles from intermittent tracker emissions;
      reset the counter to 0 when the code reappears
    - _Requirements: 5.2, 5.4_

  - [~] 3.4 Write property test for DTC detection round-trip (Property 11)
    - **Property 11: DTC Detection Round-Trip**
    - Generate events with `fc.record({ dtc_value: fc.nat(), device_id: fc.string() })`
    - Assert that after a non-zero DTC event followed by an event without that code, `dtc_events` contains exactly one unresolved record then one resolved record
    - **Validates: Requirements 5.2, 5.4**

  - [~] 3.5 Write property test for IO field persistence (Property 1)
    - **Property 1: IO Field Persistence**
    - Generate arbitrary `io_events` arrays via `fc.array(fc.record({ id: fc.nat(300), val: fc.integer() }))`
    - After `normalizeEvent()` and `writeTelemetryBatch()`, assert each IO field present maps to its column and absent fields are NULL
    - **Validates: Requirements 1.2, 7.1**

- [ ] 4. Extend `l4-service/src/alerts.js` — new alert types and DB-backed geofences
  - [-] 4.1 Add `harsh_braking` and `harsh_acceleration` alert evaluations
    - `harsh_braking`: emit when `axis_x > 3000` AND `speed > 20`, severity `HIGH`, cooldown 60 s
    - `harsh_acceleration`: emit when `axis_x > 3000` (accel context) AND `speed > 20`, severity `MEDIUM`, cooldown 60 s
    - _Requirements: 8.1, 8.2_

  - [-] 4.2 Add `battery_low` alert evaluation
    - Emit when `bat_voltage < 3.0`, severity `HIGH`, cooldown 300 s
    - _Requirements: 8.3_

  - [-] 4.3 Add `power_disconnect` alert evaluation
    - Track previous `ext_voltage` per device in a bounded Map (capped at `MAX_TRACKED_DEVICES`)
    - Emit when `prevExtVoltage > 11.0` AND `currExtVoltage < 7.0`, severity `CRITICAL`; no cooldown reset until voltage recovers
    - _Requirements: 8.4_

  - [~] 4.4 Write property test for alert threshold invariant (Property 6)
    - **Property 6: Alert Threshold Invariant**
    - Generate `fc.record({ axis_x: fc.integer(-10000, 10000), speed: fc.nat(200), bat_voltage: fc.float(0, 6) })`
    - Assert `evaluateAlerts()` emits `harsh_braking` iff `axis_x > 3000 AND speed > 20` and `battery_low` iff `bat_voltage < 3.0`; never emits for events outside those bounds
    - **Validates: Requirements 8.1, 8.3**

  - [~] 4.5 Write property test for power disconnect state transition (Property 7)
    - **Property 7: Power Disconnect State Transition**
    - Generate `fc.tuple(fc.float(0, 36), fc.float(0, 36))` for consecutive `ext_voltage` pairs
    - Assert `power_disconnect` alert is emitted iff `first > 11.0 AND second < 7.0`; assert no emission for all other pairs
    - **Validates: Requirements 8.4**

  - [-] 4.6 Add `device_offline` heartbeat detection
    - Add a `setInterval` sweep every 60 s over the live cache
    - Emit `device_offline` (severity `HIGH`) for any device whose last event age > 600 s with cached `ignition = TRUE`
    - Persist cooldown in a bounded Map until a recovery event is received (do not re-emit until then)
    - _Requirements: 8.5, 8.10_

  - [-] 4.7 Implement DB-backed polygon geofence evaluation and replace env-var rectangle
    - Add `loadGeofences()` function that SELECTs from `geofences` and `geofence_assignments` at startup
    - Implement `pointInPolygon(lat, lng, ring)` ray casting function in JavaScript
    - Document explicitly in code comments: all internal calls use `pointInPolygon(lat, lng, ring)`
      where `ring` is a GeoJSON coordinate array in **[lng, lat]** order per the GeoJSON spec
      (RFC 7946 §3.1.1); destructure as `const [xi, yi] = ring[i]` where `xi = lng` and `yi = lat`;
      add a unit test asserting a known point (e.g. `[51.5, -0.1]` inside a London bounding polygon)
      evaluates correctly with the stored ring ordering
    - **Bounding-box pre-filter**: before running `pointInPolygon`, check that the vehicle position
      falls within the geofence's axis-aligned bounding box (`minLng ≤ lng ≤ maxLng` AND
      `minLat ≤ lat ≤ maxLat`); compute and store the bounding box at cache-load time so the check
      is O(1); skip `pointInPolygon` entirely for vehicles outside the bbox
    - Emit `geofence_exit` (severity `MEDIUM`, cooldown 300 s) and `geofence_enter` (severity `LOW`, cooldown 300 s) based on polygon evaluation
    - Subscribe to `NOTIFY fleet_geofence_change` via `pg` LISTEN; reload cache within 5 s and
      recompute bounding boxes for changed geofences
    - On `fleet_geofence_change` notification, construct the entire new geofence map as a fresh
      object (`const newCache = buildGeofenceCache(rows)`) and atomically replace the module-level
      reference (`geofenceCache = newCache`) in a single assignment; never mutate arrays inside the
      existing cache object while evaluation may be running; this eliminates partially-loaded
      geofence state without requiring a mutex
    - Remove hardcoded `GEOFENCE_BOUNDS` env-var evaluation from `alerts.js`
    - _Requirements: 8.6, 8.7, 9.1–9.4, 9.7_

  - [~] 4.8 Write property test for point-in-polygon correctness (Property 8)
    - **Property 8: Point-in-Polygon Correctness (strengthened)**
    - Generate arbitrary polygons via `fc.array(fc.tuple(fc.float(-180, 180), fc.float(-90, 90)), { minLength: 4 })`
    - Assert **translation invariance**: shifting all ring coordinates by a fixed delta and shifting the test point by the same delta must yield the same result
    - Assert **winding invariance**: reversing the ring coordinate order (CW vs CCW) must yield the same result — this is the bug that catches GeoJSON winding assumptions
    - Assert **known interior point → true** using a fixed unit square `[[0,0],[1,0],[1,1],[0,1],[0,0]]` with test point `[0.5, 0.5]`; assert **known exterior point → false** with test point `[2.0, 2.0]` — these two deterministic assertions act as fast regression guards when the geometry code is later edited
    - **Validates: Requirements 9.4**

  - [~] 4.9 Define and implement alert state restart behavior
    - On L4-Service startup, query TimescaleDB for each device's last known state to re-seed
      in-memory alert maps:
      - `lastExtVoltage` per device: `SELECT ext_voltage FROM telemetry WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1`
      - Active `device_offline` cooldown: skip re-emitting offline alert if the most recent alert
        of type `device_offline` for the device is already unacknowledged and < 600 s old
      - Geofence inside/outside state per device: derive from last known position against loaded
        geofence polygons so `geofence_enter`/`geofence_exit` do not misfire on restart
      - Query `SELECT trip_id, device_id, started_at, start_lat, start_lng, driver_id FROM trips
        WHERE status = 'active'` at startup; for each row reconstruct the live-cache trip
        accumulator with `maxSpeedKmh = 0`, `totalFuelUsed = 0`, `ecoScoreSamples = []` — this is
        the MVP recovery strategy: the trip remains closeable and the service logs
        `WARN [trip-recovery] trip_id=<id> metrics reset to zero after restart` so operators know
        post-restart metrics are approximate; accumulation resumes correctly from the next event
        onward; store the recovered `trip_id` in the live cache so a subsequent ignition-off can
        close the trip correctly rather than leaving it permanently open
    - Document the restart warm-up window: the service may miss offline detection for devices
      that go dark exactly during a restart; log a `WARN` message listing devices whose offline
      state could not be confirmed
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.10_

- [~] 5. Checkpoint — schema + core backend complete
  - Ensure migration script runs idempotently on the local TimescaleDB container
  - Ensure all unit tests pass, ask the user if questions arise

- [ ] 6. Add `l4-service/src/telemetry-repository.js` — cursor pagination queries
  - [~] 6.1 Implement `encodeCursor(timestamp, eventId)` and `decodeCursor(cursor)` helpers
    - Use `Buffer.from(JSON.stringify({ t, id })).toString('base64url')` and inverse
    - Export both functions for use by `api.js` and for property testing
    - _Requirements: 12.2_

  - [~] 6.2 Write property test for cursor round-trip (Property 9)
    - **Property 9: Cursor Round-Trip**
    - Generate `fc.tuple(fc.date(), fc.uuid())` pairs
    - Assert `decodeCursor(encodeCursor(t, id))` returns `{ timestamp: t, eventId: id }` for all inputs
    - **Validates: Requirements 12.2**

  - [~] 6.3 Implement keyset-paginated query functions
    - `queryTelemetryHistory(deviceId, from, to, limit, cursor)` — keyset `WHERE (timestamp, event_id) < (cursorTs, cursorId) ORDER BY timestamp DESC`; all paginated queries MUST use `ORDER BY timestamp DESC, event_id DESC` (two-column tie-break) to guarantee stable sort order when multiple events share the same millisecond timestamp; the keyset condition must correspondingly be `WHERE (timestamp, event_id) < ($cursorTs, $cursorId)` — a single-column timestamp ORDER BY is insufficient for Property 10 correctness
    - `queryTripList(deviceId, from, to, limit, cursor)`
    - `queryAlertList(filters, limit, cursor)` — fleet-scoped
    - `queryDtcList(deviceId, limit, cursor)`
    - Return `{ records, nextCursor }` shape; `nextCursor = null` on last page
    - _Requirements: 12.1, 12.3, 12.4_

  - [~] 6.4 Write property test for pagination — no duplicates and no gaps (Property 10)
    - **Property 10: Cursor Pagination — No Duplicates and No Gaps**
    - Generate `fc.array(fc.record({ ... }))` of N records with varying page size P < N
    - Iterate all pages and assert the union equals all N records with no duplicates
    - **Validates: Requirements 12.3, 12.4**

- [ ] 7. Add `l4-service/src/telemetry-service.js` and `telemetry-contracts.js`
  - [~] 7.1 Create `telemetry-contracts.js` with TypeScript-like JSDoc response shape definitions
    - Define shapes for `TelemetryEvent`, `TripRecord`, `AlertRecord`, `DeviceRecord`, `DriverRecord`, `GeofenceRecord`, `DtcEvent`, `FleetSummary`, `PaginatedResponse`
    - Reference `.azure/telemetry-api-contracts.md` for exact field names
    - _Requirements: 11.1–11.4, 12.1_

  - [~] 7.2 Create `telemetry-service.js` with contract-shaping and business logic
    - `shapeVehicleLive(cacheEntry)` — project live cache entry to API contract fields
    - `shapeFleetSummary(cacheAll)` — include `avg_bat_voltage`, `low_battery_count`, `offline_count`, `unacknowledged_alerts`
    - `shapeTrip(dbRow)`, `shapeAlert(dbRow)`, `shapeDevice(dbRow)`, `shapeDriver(dbRow)`
    - _Requirements: 10.4, 11.1–11.4_

- [~] 8. Extend `l4-service/src/live-cache.js` — extended summary fields
  - Update `buildLiveSummary()` to include `avg_bat_voltage`, `low_battery_count`, `offline_count`
  - Wire `unacknowledged_alerts` counter from `alerts.js` into the summary
  - Ensure per-vehicle entries include all 14 new fields from live cache requirements
  - Define source-of-truth contract: SSE `summary` events are the sole source for fleet-level
    aggregates (`total_vehicles`, `ignition_on`, `avg_bat_voltage`, counters); WebSocket `telemetry`
    events are the sole source for per-vehicle position and field updates; the frontend MUST NOT
    merge fleet-level counters from WebSocket telemetry events, and MUST NOT update per-vehicle
    positions from SSE summary events — this prevents conflicting update races
  - _Requirements: 10.4, 11.1–11.4_

- [ ] 9. Extend `l4-service/src/api.js` — new REST endpoints
  - [~] 9.1 Add IMEI/ICCID validation helper and device registry endpoints
    - Implement `isValidImei(s)` (15 ASCII digits) and `isValidIccid(s)` (19–22 ASCII digits)
    - `GET /api/devices` — return all devices with full identity fields
    - `POST /api/devices` — validate IMEI/ICCID, INSERT, return 201
    - `GET /api/devices/:deviceId` — return single device
    - `PATCH /api/devices/:deviceId` — validate fields, UPDATE, return updated record
    - _Requirements: 2.3, 2.5, 2.6_

  - [~] 9.2 Write property test for IMEI/ICCID validation (Property 3)
    - **Property 3: IMEI and ICCID Validation**
    - Generate `fc.string()` and digit strings of lengths 14–16 and 18–23 via `fc.stringOf`
    - Assert `isValidImei(s)` returns true iff length === 15 and all digits; `isValidIccid(s)` returns true iff length ∈ [19,22] and all digits
    - **Validates: Requirements 2.3**

  - [~] 9.3 Add device config endpoints
    - `GET /api/devices/:deviceId/config` — return latest config record
    - `POST /api/devices/:deviceId/config` — INSERT new config record, return 201
    - _Requirements: 6.2_

  - [~] 9.4 Add driver management endpoints
    - `GET /api/drivers` — return all drivers
    - `POST /api/drivers` — INSERT driver, return 201
    - `GET /api/drivers/:driverId` — return single driver
    - `PATCH /api/drivers/:driverId` — UPDATE driver, return updated record
    - _Requirements: 3.2_

  - [~] 9.5 Add alert acknowledgement and fleet alert list endpoints
    - `PATCH /api/alerts/:alertId/acknowledge` — UPDATE `acknowledged=true`, `acknowledged_at=NOW()`, store `ack_note` in metadata
    - `GET /api/alerts` — fleet-scoped list with filters: `device_id`, `severity`, `alert_type`, `acknowledged`, `from`, `to`, `limit`, `cursor`
    - _Requirements: 10.1, 10.2, 10.3_

  - [~] 9.6 Add trip and DTC endpoints
    - `GET /api/vehicles/:deviceId/trips` — paginated with `from`, `to`, `limit`, `cursor`
    - `GET /api/trips/:tripId/route` — ordered telemetry events for trip route replay
    - `GET /api/vehicles/:deviceId/dtc` — DTC event history ordered by `timestamp DESC`
    - _Requirements: 4.4, 4.5, 5.3_

  - [~] 9.7 Add geofence endpoints
    - `GET /api/geofences` — return all geofences
    - `POST /api/geofences` — INSERT geofence with GeoJSON polygon, return 201
    - `POST /api/geofences/:geofenceId/assign` — INSERT into `geofence_assignments`, accept array of device IDs
    - _Requirements: 9.5, 9.6_

  - [~] 9.8 Add analytics endpoints
    - `GET /api/analytics/utilization` — hourly active vehicle count from `telemetry_hourly_summary`
    - `GET /api/analytics/fuel` — daily `fuel_used_gps` per vehicle from `telemetry_daily_summary`
    - `GET /api/analytics/trips` — per-vehicle trip metrics for a date range
    - _Requirements: 18.2–18.4_

  - [~] 9.9 Update CORS `ALLOWED_ORIGINS` to include `http://localhost:4000`
    - Replace `localhost:8069` reference in `api.js` and `.env.example`
    - _Requirements: 21.2, 24.4_

  - [~] 9.10 Add rate limiting and request size caps to all mutating endpoints
    - Install `express-rate-limit` (exact version pinned in package.json)
    - Apply a rate limiter of 60 requests/minute per IP to all `POST` and `PATCH` routes
    - Set `express.json({ limit: '1mb' })` on all routes that accept a request body; this prevents oversized payloads from exhausting the Node.js heap
    - _Requirements: (hardening — no direct requirement reference)_

- [~] 10. Checkpoint — full backend API complete
  - Ensure all new endpoints return correct shapes against the local TimescaleDB + NATS stack
  - Ensure all property tests and unit tests pass, ask the user if questions arise

- [ ] 11. Scaffold Next.js frontend application
  - [~] 11.1 Create `frontend/` directory with Next.js 14 App Router + TypeScript
    - Run `npx create-next-app@14 frontend --typescript --app --no-src-dir` (user runs this manually)
    - Install dependencies: `maplibre-gl`, `@tanstack/react-query`, `zustand`, `@tanstack/react-query-devtools`
    - Install `zod` as a runtime dependency; create `src/lib/api/schemas.ts` defining Zod schemas
      for every API response type (`TelemetryEventSchema`, `TripRecordSchema`, `AlertRecordSchema`,
      `DeviceRecordSchema`, `FleetSummarySchema`, `PaginatedResponseSchema`); call
      `schema.parse(await res.json())` inside `apiFetch<T>()` in `client.ts` so any unexpected
      payload shape throws a typed `ZodError` at the boundary rather than causing a silent
      downstream crash
    - Configure `next.config.ts` with `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_API_KEY` env vars
    - Create `tsconfig.json` path alias `@/*` → `./src/*`
    - Write `src/types/telemetry.ts` with all shared TypeScript interfaces from API contracts
    - _Requirements: 13.1, 13.3, 13.4_

  - [~] 11.2 Create `frontend/Dockerfile` and add `fleet-frontend` service to `docker-compose.yml`
    - Multistage Dockerfile: `node:20-alpine` builder + runner stages, expose port 4000
    - Add `fleet-frontend` service: `build: ./frontend`, ports `4000:4000`, env vars, `depends_on: l4-service: condition: service_healthy`
    - _Requirements: 13.2, 24.2, 24.3_

  - [~] 11.3 Create `src/lib/api/client.ts` typed fetch wrapper
    - Implement `apiFetch<T>(path, init?)` with `X-API-Key` and `Content-Type` headers
    - Implement `ApiError` class with `status` and `message` fields
    - Set `BASE_URL` from `NEXT_PUBLIC_API_URL`, fallback `http://localhost:3000`
    - _Requirements: 13.4, 21.5_

  - [~] 11.4 Create domain API modules under `src/lib/api/`
    - `fleet.ts` — `getFleetSummary()`, `getLiveVehicles()`
    - `vehicles.ts` — `getVehicleLatest()`, `getVehicleHistory()`, `getVehicleTimeline()`, `getVehicleAlerts()`, `getVehicleDiagnostics()`
    - `alerts.ts` — `getAlerts(filters)`, `acknowledgeAlert(alertId, note?)`
    - `trips.ts` — `getVehicleTrips()`, `getTripRoute()`
    - `devices.ts` — `getDevices()`, `createDevice()`, `updateDevice()`, `getDevice()`, `getDeviceConfig()`, `createDeviceConfig()`
    - `drivers.ts` — `getDrivers()`, `createDriver()`, `updateDriver()`, `getDriver()`
    - `geofences.ts` — `getGeofences()`, `createGeofence()`, `assignGeofence()`
    - `analytics.ts` — `getUtilization()`, `getFuelConsumption()`, `getTripMetrics()`
    - _Requirements: 13.4, 13.5_

  - [~] 11.5 Create `src/lib/realtime/useWebSocket.ts` hook
    - Connect to `NEXT_PUBLIC_WS_URL` (default `ws://localhost:3001`)
    - Handle `snapshot`, `telemetry`, `alert`, `pong` message types
    - Implement exponential backoff reconnect starting at 1 s, capped at 30 s
    - Expose a toast after 3 consecutive failures
    - _Requirements: 13.5, 13.6, 20.4_

  - [~] 11.6 Create `src/lib/realtime/useSSE.ts` hook
    - Connect to `GET /api/stream/dashboard` via `EventSource`
    - Handle `summary` event → dispatch to Zustand store; `heartbeat` → noop
    - Let `EventSource` handle reconnection automatically
    - _Requirements: 13.5, 14.2_

  - [~] 11.7 Create `src/lib/store/vehicleStore.ts` Zustand store
    - State: `vehicles: Record<string, LiveVehicle>`, `fleetSummary: FleetSummary | null`, `alertsQueue: AlertRecord[]`
    - Actions: `setAll()`, `updateVehicle()`, `setFleetSummary()`, `prependAlert()`
    - Enforce source-of-truth split in the store: `setFleetSummary()` is called ONLY from the SSE
      handler; `updateVehicle()` is called ONLY from the WebSocket `telemetry` handler; add a
      comment block in `vehicleStore.ts` documenting this contract
    - _Requirements: 13.4, 14.2, 14.3_

  - [~] 11.8 Create root layout `src/app/layout.tsx` with navigation and React Query provider
    - Navigation links: `/` (Overview), `/map`, `/alerts`, `/analytics`, `/devices`
    - Wrap with `QueryClientProvider` and `ToastProvider`
    - Add `src/app/api/health/route.ts` Next.js health API route
    - _Requirements: 13.1, 22.3_

- [ ] 12. Implement Fleet Overview page (`src/app/page.tsx`)
  - [~] 12.1 Create `src/components/map/FleetMap.tsx` MapLibre GL JS map wrapper
    - Initialize MapLibre with OSM tiles (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`)
    - Expose `onVehicleClick` callback prop
    - Handle dynamic import to disable SSR (`next/dynamic`, `ssr: false`)
    - _Requirements: 13.3, 14.1_

  - [~] 12.2 Create `src/components/map/VehicleMarker.tsx` and `MarkerCluster.tsx`
    - Color-code markers: green (moving), amber (idle), red (alert), grey (offline/stale)
    - Activate `MarkerCluster` when more than 20 vehicles are in the viewport
    - Popup: `device_id`, speed, ignition, fuel level, bat voltage, link to `/vehicles/:deviceId`
    - _Requirements: 14.4, 14.5, 14.6_

  - [~] 12.3 Create `src/components/shared/StatusCounter.tsx`
    - Display counters: total vehicles, active (moving), idle, low fuel, overspeeding, open critical alerts
    - Subscribe to `vehicleStore.fleetSummary` for reactive updates
    - _Requirements: 14.2, 14.7_

  - [~] 12.4 Wire Fleet Overview page with SSE + WebSocket live data
    - Use `useSSE()` for fleet summary counter updates
    - Use `useWebSocket()` to drive map marker position updates < 500 ms
    - Use `useQuery` (React Query) for initial fleet snapshot
    - _Requirements: 14.1–14.7, 20.1–20.4_

- [ ] 13. Implement Vehicle Detail page (`src/app/vehicles/[deviceId]/page.tsx`)
  - [~] 13.1 Create `src/components/vehicle/TelemetryCard.tsx` and `TelemetryGrid.tsx`
    - `TelemetryCard`: single field label + value + unit; ARIA label for accessibility
    - `TelemetryGrid`: card grid covering all fields from Requirement 15.2
    - _Requirements: 15.2, 13.7_

  - [~] 13.2 Create `src/components/vehicle/TripList.tsx` and `TripRouteMap.tsx`
    - `TripList`: paginated table with `start/end time`, `distance`, `duration`, `fuel`, `max speed`, `eco score`
    - `TripRouteMap`: polyline on mini-map loaded from `GET /api/trips/:tripId/route` on row select
    - _Requirements: 15.4, 15.5_

  - [~] 13.3 Create `src/components/vehicle/AlertHistory.tsx`
    - Table with severity badge, alert type, timestamp, acknowledge button
    - Acknowledge button calls `acknowledgeAlert()` and optimistically updates UI
    - _Requirements: 15.7_

  - [~] 13.4 Create `src/components/vehicle/DiagnosticsPanel.tsx`
    - Display RPM, engine load, DTC codes from `GET /api/vehicles/:deviceId/dtc`
    - Display all extended IO field values from latest event
    - _Requirements: 15.8_

  - [~] 13.5 Wire Vehicle Detail page with tabbed layout and live updates
    - Tabs: Overview, Trips, History, Alerts, Diagnostics using accessible tab pattern (ARIA roles)
    - Overview tab: mini-map + `TelemetryGrid` updated live from WebSocket telemetry events for this device
    - History tab: time-series chart (speed + fuel level) from `GET /api/vehicles/:deviceId/history` with date-range filter
    - _Requirements: 15.1–15.8, 13.7_

- [~] 14. Checkpoint — Fleet Overview and Vehicle Detail complete
  - Confirm live marker updates, telemetry cards, and trip route display work end-to-end
  - Ensure all unit tests pass, ask the user if questions arise

- [ ] 15. Implement Fleet Map page (`src/app/map/page.tsx`)
  - [~] 15.1 Create `src/components/map/GeofenceOverlay.tsx`
    - Render GeoJSON polygon layers from `GET /api/geofences` using MapLibre fill + outline layers
    - On click: display geofence name, assigned devices, enter/exit alert status
    - _Requirements: 16.4, 16.5_

  - [~] 15.2 Wire Fleet Map page with full-screen map, filter panel, and geofence overlays
    - Collapsible filter panel supporting: status, alert type, driver, vehicle type filters
    - Apply filters client-side against Zustand `vehicles` store within 300 ms (no extra network request)
    - Reuse `FleetMap`, `VehicleMarker`, `MarkerCluster`, `GeofenceOverlay` components
    - _Requirements: 16.1–16.5_

- [ ] 16. Implement Alerts Center page (`src/app/alerts/page.tsx`)
  - [~] 16.1 Create `src/components/alerts/AlertTable.tsx`, `AlertDrawer.tsx`, and `SeverityBadge.tsx`
    - `AlertTable`: sortable, filterable by severity, alert type, device, date range, acknowledgement status
    - `SeverityBadge`: colour-coded chip for LOW / MEDIUM / HIGH / CRITICAL
    - `AlertDrawer`: full metadata, mini-map of alert position, triggering event details
    - Per-row and bulk acknowledge buttons calling `acknowledgeAlert()`
    - _Requirements: 17.1, 17.2, 17.4, 17.5_

  - [~] 16.2 Wire Alerts Center page with WebSocket live alert prepending
    - Subscribe to WebSocket `alert` events; call `vehicleStore.prependAlert()` to update table without full reload
    - Display severity counters updated in real time
    - _Requirements: 17.3_

- [ ] 17. Implement Analytics page (`src/app/analytics/page.tsx`)
  - [~] 17.1 Create `src/components/analytics/UtilizationChart.tsx` and `FuelChart.tsx`
    - `UtilizationChart`: line/bar chart of hourly active vehicle count from `GET /api/analytics/utilization`
    - `FuelChart`: daily fuel consumption per vehicle from `GET /api/analytics/fuel`
    - Both use React Query with date range selector wired to query params
    - _Requirements: 18.2, 18.3_

  - [~] 17.2 Create `src/components/analytics/TripMetricsTable.tsx` and wire Analytics page
    - Table of per-vehicle trip count, total distance, total fuel, avg eco score, max speed
    - Date range selector and optional driver filter
    - _Requirements: 18.1, 18.4, 18.5_

- [ ] 18. Implement Device Management page (`src/app/devices/page.tsx`)
  - [~] 18.1 Create `src/components/devices/DeviceTable.tsx` and `DeviceForm.tsx`
    - `DeviceTable`: full registry with last-seen timestamp; highlight row red when last-seen > 600 s ago
    - `DeviceForm`: fields for IMEI, name, VIN, ICCID, registration number, vehicle type, driver assignment
    - Inline editing calls `PATCH /api/devices/:deviceId` on save
    - `POST /api/devices` on new device submission with success/validation-error toast within 2 s
    - Read-only config panel from `GET /api/devices/:deviceId/config`
    - _Requirements: 19.1–19.6_

- [~] 19. Checkpoint — all UI pages complete
  - Verify all pages render with live data; confirm filter, pagination, and acknowledge flows
  - Ensure all unit and integration tests pass, ask the user if questions arise

- [ ] 20. Infrastructure cleanup — remove Odoo, Traccar, EMQX artifacts
  - [~] 20.1 Remove Odoo services and directories
    - Delete `odoo/` directory from repository root
    - Delete `config/odoo/` directory
    - Delete `data/odoo/` and `data/odoo-db/` directories
    - Remove `odoo`, `odoo-init`, `odoo-module-init`, `odoo-db` service blocks from `docker-compose.yml`
    - _Requirements: 24.1_

  - [~] 20.2 Remove Traccar and EMQX config artifacts
    - Delete `config/traccar/` directory
    - Delete `config/emqx/` directory
    - Remove any `traccar` service block from `docker-compose.yml` if present
    - _Requirements: 24.1_

  - [~] 20.3 Update CI smoke test to validate frontend on port 4000
    - Edit `.github/workflows/smoke-demo.yml` to curl `http://localhost:4000` and assert HTTP 200
    - Remove any step that validates Odoo on port 8069
    - _Requirements: 24.5_

- [~] 21. Final checkpoint — full stack clean
  - Run `docker compose up -d` against the updated compose file; verify all services start healthy
  - Confirm no Odoo/Traccar/EMQX references remain in active code or compose; ask the user if questions arise

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Property tests use **fast-check** (`npm install --save-dev fast-check`) — install in `l4-service/` and `frontend/`
- Each property test task references its property number from the design document's "Correctness Properties" section
- Migration is split across three files (`02_telemetry_columns.sql`, `03_domain_tables.sql`, `04_views_and_alerts.sql`); run in order before deploying any L4-Service changes
- `telemetry_hourly_summary` already exists in `01_schema.sql`; `telemetry_daily_summary` is added in `04_views_and_alerts.sql`
- Trip metric accumulators (`maxSpeedKmh`, `totalFuelUsed`, `ecoScoreSamples`) live in the live cache alongside the active `trip_id` and are flushed on trip close
- Geofence bounding boxes are computed once at cache-load time and stored alongside the polygon ring — the bbox check short-circuits `pointInPolygon` for the majority of events
- Alert state is re-seeded from the DB on startup (task 4.9) to avoid stale cooldown or false alerts after a process restart
- Frontend map components must use `next/dynamic` with `ssr: false` to avoid MapLibre SSR issues
- All write endpoints are protected by the existing `requireApiKey` middleware — no auth changes needed
- Checkpoints validate incremental progress without blocking subsequent phases
- `fuel_used_gps` (IO 12) is treated as a cumulative counter; deltas must be clamped with `MAX_REASONABLE_FUEL_DELTA = 5.0 L` and set to 0 on negative delta (counter reset)
- DTC codes are resolved only after 3 consecutive absent observations to suppress intermittent tracker noise
- Geofence cache is replaced atomically on reload — never mutate the existing cache in place
- GeoJSON ring coordinates are always [lng, lat] order (RFC 7946); `pointInPolygon` parameter order is `(lat, lng, ring)` — document this inversion explicitly in the function signature comment
- All paginated queries require `ORDER BY timestamp DESC, event_id DESC` (two-column sort) for cursor correctness
- SSE owns fleet-level aggregates; WebSocket owns per-vehicle state — never merge across streams
- Rate limit all mutating endpoints: 60 req/min per IP; `express.json({ limit: '1mb' })`
- Zod schemas validate every API response at the `apiFetch` boundary in the frontend

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.3", "2.4", "2.5", "2.6"] },
    { "id": 2, "tasks": ["2.2", "3.1", "3.3", "4.1", "4.2", "4.3", "4.6", "4.7"] },
    { "id": 3, "tasks": ["3.2", "3.4", "3.5", "4.4", "4.5", "4.8", "4.9", "6.1", "7.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "7.2", "8"] },
    { "id": 5, "tasks": ["6.4", "9.1", "9.3", "9.4", "9.5", "9.6", "9.7", "9.8", "9.9", "9.10"] },
    { "id": 6, "tasks": ["9.2", "11.1", "11.2"] },
    { "id": 7, "tasks": ["11.3", "11.4"] },
    { "id": 8, "tasks": ["11.5", "11.6", "11.7", "11.8"] },
    { "id": 9, "tasks": ["12.1", "12.2", "12.3", "13.1", "13.2", "13.3", "13.4"] },
    { "id": 10, "tasks": ["12.4", "13.5", "15.1", "16.1", "17.1", "17.2", "18.1"] },
    { "id": 11, "tasks": ["15.2", "16.2", "20.1", "20.2"] },
    { "id": 12, "tasks": ["20.3"] }
  ]
}
```
