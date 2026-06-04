# Requirements Document

## Introduction

This document defines the requirements for a complete architectural redesign of the fleet telemetry
platform. The current system has a working data ingestion pipeline (C adapter → NATS → L4-Service →
TimescaleDB) but uses Odoo 17 ERP as its presentation layer — a mismatch that produces a 1-minute
polling lag, incomplete FMC003 field storage, a missing device registry, and no map, trip, or
analytics UI. The redesign retains every proven backend component and replaces the Odoo stack with a
purpose-built React / Next.js frontend that consumes the existing WebSocket and SSE streams.

The target system must be comparable in capability to commercial fleet management platforms
(Wialon, Samsara, Geotab, Traccar) while remaining fully self-hosted and container-managed.

---

## Glossary

- **Platform**: The complete fleet telemetry system described in this document.
- **FMC003**: Teltonika FMC003 GPS/IoT tracker device deployed in fleet vehicles.
- **Adapter**: The C-language TCP server (`adapter/decoder.c`) that decodes Codec 8 binary frames
  from FMC003 devices and publishes normalized JSON to NATS.
- **NATS**: The NATS JetStream message broker (`fleet-nats`), used as the backbone between the
  Adapter and the L4-Service.
- **L4-Service**: The Node.js processing service (`l4-service/`) that consumes NATS, writes to
  TimescaleDB, evaluates alerts, maintains the live cache, and serves the REST / WebSocket / SSE API.
- **TimescaleDB**: The PostgreSQL 16 + TimescaleDB instance (`fleet-timescaledb`) used for all
  time-series storage of telemetry and alerts.
- **Frontend**: The purpose-built React + TypeScript + Next.js web application that replaces Odoo as
  the presentation layer.
- **Alert_Engine**: The alert evaluation logic inside L4-Service (`l4-service/src/alerts.js`).
- **Live_Cache**: The in-process Map inside L4-Service that holds the latest state per device and
  feeds SSE and WebSocket with zero DB latency.
- **IO_Field**: A named telemetry field sourced from an FMC003 IO element (identified by numeric IO
  ID in the Codec 8 protocol).
- **Trip**: A contiguous period of vehicle movement with ignition on, bounded by ignition-on and
  ignition-off events.
- **DTC**: Diagnostic Trouble Code — a standardized fault code reported by a vehicle's OBD system.
- **Geofence**: A named geographic boundary (polygon or circle) stored in the database and evaluated
  against vehicle position in real time.
- **Driver**: A person assigned to operate a fleet vehicle, identified by name and optionally a tag
  or card ID.
- **Device_Registry**: The `devices` table in TimescaleDB, extended to hold full vehicle identity
  (VIN, IMEI, ICCID, registration number) and driver assignment.

---

## Gap Analysis

The table below compares each required capability against the current implementation. Items marked
**Missing** have no implementation. Items marked **Partial** exist but are incomplete or inaccessible
from the UI.

| Capability | Current Status | Gap Description |
|---|---|---|
| **FMC003 IO field extraction** | Partial | 23 IO fields extracted in `consumer.js` but only `ignition` and `odometer` have dedicated `telemetry` columns; all others stored in JSONB `payload` — unqueryable without JSON path operators |
| **Battery voltage / ext. power (IO 66/67/68/113)** | Partial | Extracted to event object and live cache; not in DB columns |
| **GNSS quality (IO 69/181/182)** | Partial | Extracted but JSONB-only; no queryable columns |
| **Movement / acceleration axes (IO 240/17/18/19)** | Partial | Extracted but JSONB-only |
| **GSM signal / network type (IO 21/237)** | Partial | Extracted but JSONB-only |
| **Fuel rate / fuel used (IO 13/12)** | Partial | Extracted but JSONB-only |
| **Trip odometer / eco score (IO 199/15)** | Partial | Extracted but JSONB-only |
| **Device identity (VIN, ICCID, registration)** | Missing | `devices` table has `imei` and `name` only; no VIN, ICCID, registration, serial |
| **Driver assignment** | Missing | No `drivers` table; no vehicle–driver link |
| **Trip detection and storage** | Missing | No `trips` table; no ignition-on/off boundary detection |
| **DTC codes** | Missing | No `dtc_events` table; no OBD fault code parsing or storage |
| **Geofence polygon evaluation** | Partial | `geofences` table exists; `geofence_assignments` exists; evaluation in `alerts.js` uses a single hardcoded bounding box from env vars instead of DB polygons |
| **Named multi-geofence support** | Missing | Only one rectangular fence from env vars |
| **Harsh braking / harsh acceleration alerts** | Missing | Axis data (IO 17/18/19) extracted but no threshold evaluation |
| **Battery / power disconnect alerts** | Missing | Voltage data available but no alert rules |
| **Device offline detection** | Missing | No heartbeat timeout logic |
| **Alert severity levels (LOW/MEDIUM/HIGH/CRITICAL)** | Partial | DB schema has `INFO/WARNING/CRITICAL`; API contracts reference `low/medium/high/critical`; no `LOW` severity; no `MEDIUM` severity |
| **Alert acknowledgement (write)** | Missing | `acknowledged` column exists in DB; no API endpoint to set it |
| **Real-time push to frontend** | Partial | WebSocket and SSE endpoints work; Odoo polls via cron every 60 s instead of consuming them |
| **Live map with vehicle positions** | Missing | No map UI anywhere in the system |
| **Fleet Overview page** | Missing | Odoo has a telemetry list view, not a fleet overview with map and live counters |
| **Vehicle Detail page** | Missing | Odoo has a form view; no tabbed detail page with diagnostics, trips, history, and live telemetry cards |
| **Trip replay / route history UI** | Missing | No UI; history data exists in TimescaleDB |
| **Analytics / reporting** | Missing | No UI; hourly aggregates exist as a continuous aggregate view |
| **Device Management UI** | Missing | No registration or configuration workflow |
| **Alerts Center with ACK** | Missing | Odoo shows alert list; no severity filter, no acknowledgement action, no real-time push |
| **Fuel consumption analytics** | Missing | `fuel_used_gps` and `fuel_rate_gps` extracted but not surfaced |
| **Engine hours tracking** | Missing | No `engine_hours` column; `ignition` data exists to compute it |
| **API cursor pagination** | Partial | Contracts define `next_cursor`; implementation uses `limit` only, no cursor |
| **Odoo ERP dependency** | Complete (wrong) | Odoo 17 + `odoo-db` (PostgreSQL 15) + 3 init containers add ~800 MB of image pull, 60 s startup, and cron-only data refresh — none of this serves telemetry requirements |

---

## What Should Be Deleted

The following components must be removed from the repository and from `docker-compose.yml`:

1. **`odoo/` directory** — entire Odoo 17 ERP installation, including the
   `fleet_telemetry_connector` addon, all Python models, XML views, cron definitions, and
   `__manifest__.py`.
2. **`config/odoo/` directory** — `odoo.conf`, `module-init.sh`.
3. **`data/odoo/` directory** — Odoo filestore and database initialization artifacts.
4. **`data/odoo-db/` directory** — PostgreSQL 15 data volume for Odoo.
5. **`docker-compose.yml` services**: `odoo`, `odoo-init`, `odoo-module-init`, `odoo-db` — all
   four services and their dependency declarations must be removed.
6. **`config/traccar/` directory** and the `traccar` service in `docker-compose.yml` — Codec 8
   binary decoding is already handled entirely by the C adapter; Traccar is redundant.
7. **`config/emqx/` directory** and the EMQX service references where the C adapter uses direct
   TCP on port 18883 (not MQTT) — EMQX is not in the current `docker-compose.yml` services block
   but config artifacts remain on disk.
8. **`ALLOWED_ORIGINS` references to `localhost:8069`** in `.env.example` and `api.js` — replace
   with the React dev server origin (`localhost:3000` for Next.js dev, or the production domain).

---

## What Is Reusable

The following components must be kept without modification, or extended rather than replaced:

1. **`adapter/decoder.c` + `decoder.h` + `main.c` + `tcp-listen.c` + `nats-pub.c`** — complete,
   correct Codec 8 binary decoder for FMC003. Keep entirely.
2. **NATS JetStream configuration** (`config/nats/nats.conf`, `data/nats/`) — stream definition,
   retention policy, and per-user auth. Keep entirely.
3. **TimescaleDB hypertable setup** (`init/timescaledb/01_schema.sql`) — hypertable creation,
   continuous aggregate, retention policies. Keep and extend with migration scripts.
4. **`l4-service/src/consumer.js`** — IO_MAP field extraction (23 fields), normalization pipeline,
   bounded device-timestamp tracking, batch write buffer. Keep and extend IO writes to new columns.
5. **`l4-service/src/api.js`** — Live cache endpoints, SSE stream, WebSocket server, API key auth,
   rate limiting, CORS middleware, audit logging. Keep and extend.
6. **`l4-service/src/alerts.js`** — Bounded cooldown maps, memory-safe implementation pattern.
   Keep and extend with new alert types.
7. **`l4-service/src/live-cache.js`** — In-process cache + subscriber pattern used by SSE. Keep.
8. **`.azure/telemetry-api-contracts.md`** — API contract definitions. Implement them in full.
9. **Docker Compose orchestration structure** — Service dependency graph, health checks, log
   rotation, named network. Keep structure; remove Odoo services; add Frontend service.
10. **Simulator stack** (`simulator/`) — Useful for development and CI. Keep entirely.

---

## Architecture Recommendation

```
FMC003 Device  ──TCP:18883──►  Adapter (C)  ──NATS──►  L4-Service (Node.js)  ──►  TimescaleDB
                                                                │
                                              ┌─────────────────┼──────────────────┐
                                              │                 │                  │
                                           REST API         WebSocket           SSE Stream
                                           :3000             :3001              :3000/stream
                                              │                 │                  │
                                              └─────────────────▼──────────────────┘
                                                         Frontend (React / Next.js)
                                                         - Fleet Overview (map)
                                                         - Vehicle Detail
                                                         - Fleet Map
                                                         - Alerts Center
                                                         - Analytics
                                                         - Device Management
```

**Removed from the path:** Odoo, odoo-db, EMQX, Traccar.

**New components to add:**
- `frontend/` — Next.js application container (`fleet-frontend`, port 4000).
- Redis (optional, phase 2) — for rate-limited API key sessions and geofence polygon caching.
- `init/timescaledb/02_schema_v2.sql` — migration adding new columns and tables.

---

## Implementation Roadmap

### Phase 1 — Schema and Backend Completeness (no UI)
- Migrate TimescaleDB schema: add dedicated columns to `telemetry`, extend `devices`, add `trips`,
  `drivers`, `dtc_events`, `device_config` tables.
- Extend `consumer.js` to write all IO fields to their new dedicated columns.
- Extend `alerts.js` with all missing alert types and DB-backed polygon geofences.
- Add alert acknowledgement `PATCH /api/alerts/:alertId` endpoint to `api.js`.
- Add fleet-scoped alert list `GET /api/alerts` endpoint.
- Add driver and device CRUD endpoints.
- Add trip boundary detection and writes to `trips` table.

### Phase 2 — Frontend Foundation
- Scaffold Next.js application in `frontend/`.
- Implement API client layer consuming all L4-Service endpoints.
- Connect to SSE stream for live updates and WebSocket for real-time events.
- Implement Fleet Overview page: live map (Leaflet/MapLibre), vehicle status counters, active
  alert list.
- Implement Vehicle Detail page: telemetry cards, diagnostics panel, alert history, trip list.

### Phase 3 — Advanced UI and Analytics
- Implement Fleet Map page: clustered markers, per-vehicle filters, geofence overlays.
- Implement Alerts Center: severity filtering, bulk acknowledgement, alert history export.
- Implement Analytics page: utilization charts, fuel consumption, trip metrics, downtime.
- Implement Device Management page: FMC003 registration, IMEI/VIN/ICCID management, driver
  assignment.

### Phase 4 — Infrastructure Cleanup
- Remove Odoo services from `docker-compose.yml`.
- Remove Traccar and EMQX config artifacts.
- Add `fleet-frontend` service to `docker-compose.yml`.
- Update CI smoke tests in `.github/workflows/smoke-demo.yml` to validate the new frontend.
- Add Terraform definitions for production deployment (if applicable).

---

## Requirements

### Requirement 1: Schema — Extended Telemetry Columns

**User Story:** As a fleet operations engineer, I want all FMC003 IO fields stored in dedicated,
indexed database columns so that I can query, aggregate, and alert on any field without JSON path
operators.

#### Acceptance Criteria

1. THE Platform SHALL add the following columns to the `telemetry` hypertable: `ext_voltage FLOAT`,
   `bat_voltage FLOAT`, `bat_level INTEGER`, `bat_current INTEGER`, `gnss_status INTEGER`,
   `gnss_hdop FLOAT`, `gnss_pdop FLOAT`, `movement BOOLEAN`, `gsm_signal INTEGER`,
   `network_type INTEGER`, `axis_x INTEGER`, `axis_y INTEGER`, `axis_z INTEGER`,
   `trip_odometer FLOAT`, `eco_score FLOAT`, `fuel_rate_gps FLOAT`, `fuel_used_gps FLOAT`,
   `sleep_mode INTEGER`.
2. WHEN a telemetry event is written to the database, THE L4-Service SHALL populate each new column
   from the corresponding extracted IO field; NULL when the IO field is absent in the event.
3. THE Platform SHALL add a `CHECK` constraint `ext_voltage >= 0 AND ext_voltage <= 36` and
   `bat_voltage >= 0 AND bat_voltage <= 5` to prevent out-of-range values from corrupt frames.
4. THE Platform SHALL create indexes `idx_telemetry_movement ON telemetry (device_id, movement)`
   and `idx_telemetry_bat_voltage ON telemetry (device_id, bat_voltage)` for efficient alert and
   analytics queries.
5. THE Platform SHALL provide a migration script `init/timescaledb/02_schema_v2.sql` that adds all
   new columns and indexes idempotently using `IF NOT EXISTS` guards so that existing deployments
   can be upgraded without recreating the hypertable.

---

### Requirement 2: Schema — Extended Device Registry

**User Story:** As a fleet manager, I want each device record to contain the full vehicle identity
so that I can search by registration plate, VIN, or IMEI without cross-referencing separate systems.

#### Acceptance Criteria

1. THE Platform SHALL add the following columns to the `devices` table: `vin TEXT`, `iccid TEXT`,
   `serial_number TEXT`, `registration_number TEXT`, `make TEXT`, `model TEXT`,
   `year INTEGER`, `fuel_type TEXT`.
2. THE Platform SHALL add a `UNIQUE` constraint on `vin` (nullable — not all devices are vehicle-
   mounted) and a `UNIQUE` constraint on `iccid`.
3. WHEN a device record is created or updated, THE Platform SHALL validate that `imei` contains
   exactly 15 digits and `iccid` (when provided) contains between 19 and 22 digits.
4. THE Platform SHALL add a `driver_id UUID` foreign key column to `devices` referencing the new
   `drivers` table (Requirement 3), set `ON DELETE SET NULL`.
5. THE Platform SHALL expose `GET /api/devices` and `GET /api/devices/:deviceId` endpoints that
   return the full device record including all new identity fields.
6. THE Platform SHALL expose `POST /api/devices` and `PATCH /api/devices/:deviceId` endpoints for
   device registration and updates, protected by the existing `X-API-Key` middleware.

---

### Requirement 3: Schema — Drivers Table

**User Story:** As a fleet manager, I want to assign drivers to vehicles so that trip reports,
alerts, and history can be attributed to the correct person.

#### Acceptance Criteria

1. THE Platform SHALL create a `drivers` table with columns: `driver_id UUID PRIMARY KEY DEFAULT
   gen_random_uuid()`, `name TEXT NOT NULL`, `employee_id TEXT UNIQUE`, `license_number TEXT`,
   `phone TEXT`, `tag_id TEXT UNIQUE`, `status TEXT DEFAULT 'active' CHECK (status IN ('active',
   'inactive'))`, `created_at TIMESTAMPTZ DEFAULT NOW()`, `updated_at TIMESTAMPTZ DEFAULT NOW()`.
2. THE Platform SHALL expose `GET /api/drivers`, `POST /api/drivers`, `PATCH /api/drivers/:driverId`,
   and `GET /api/drivers/:driverId` endpoints, all protected by `X-API-Key`.
3. WHEN a driver is assigned to a device via `PATCH /api/devices/:deviceId`, THE L4-Service SHALL
   store the `driver_id` in the `devices.driver_id` column and return the updated device record.
4. WHEN a telemetry event is stored, THE L4-Service SHALL record the current `driver_id` from the
   `devices` row into the `telemetry` event's `payload.driver_id` field for historical attribution.

---

### Requirement 4: Schema — Trips Table

**User Story:** As a fleet manager, I want trips automatically detected and stored so that I can
view per-trip distance, duration, and fuel consumption without manual analysis.

#### Acceptance Criteria

1. THE Platform SHALL create a `trips` table with columns: `trip_id UUID PRIMARY KEY DEFAULT
   gen_random_uuid()`, `device_id TEXT NOT NULL REFERENCES devices(device_id)`, `driver_id UUID
   REFERENCES drivers(driver_id) ON DELETE SET NULL`, `started_at TIMESTAMPTZ NOT NULL`,
   `ended_at TIMESTAMPTZ`, `start_lat DOUBLE PRECISION`, `start_lng DOUBLE PRECISION`,
   `end_lat DOUBLE PRECISION`, `end_lng DOUBLE PRECISION`, `distance_meters INTEGER`,
   `duration_seconds INTEGER`, `fuel_consumed_liters FLOAT`, `max_speed_kmh FLOAT`,
   `avg_speed_kmh FLOAT`, `idle_seconds INTEGER`, `eco_score FLOAT`, `status TEXT DEFAULT
   'active' CHECK (status IN ('active', 'completed'))`.
2. WHEN a telemetry event is received with `ignition = TRUE` and the previous event for the same
   device had `ignition = FALSE` (or no previous event exists), THE L4-Service SHALL create a new
   `trips` row with `status = 'active'`, `started_at` set to the event timestamp, and
   `start_lat` / `start_lng` from the event position.
3. WHEN a telemetry event is received with `ignition = FALSE` and an active trip exists for the
   device, THE L4-Service SHALL update the active trip row: set `ended_at`, `end_lat`, `end_lng`,
   `distance_meters` (from `trip_odometer` IO 199), `duration_seconds`, and `status = 'completed'`.
4. THE Platform SHALL expose `GET /api/vehicles/:deviceId/trips` with query parameters `from`,
   `to`, `limit`, and `cursor` for paginated trip history.
5. THE Platform SHALL expose `GET /api/trips/:tripId/route` returning the ordered telemetry
   events (lat/lng/speed/timestamp) belonging to that trip.

---

### Requirement 5: Schema — DTC Events Table

**User Story:** As a fleet maintenance manager, I want DTC fault codes stored per event so that I
can track diagnostic history and schedule maintenance proactively.

#### Acceptance Criteria

1. THE Platform SHALL create a `dtc_events` table with columns: `dtc_id UUID PRIMARY KEY DEFAULT
   gen_random_uuid()`, `device_id TEXT NOT NULL`, `timestamp TIMESTAMPTZ NOT NULL`,
   `dtc_code TEXT NOT NULL`, `description TEXT`, `raw_value INTEGER`, `resolved_at TIMESTAMPTZ`,
   `event_id UUID`.
2. WHEN a telemetry event contains a non-zero DTC IO field, THE L4-Service SHALL insert a row into
   `dtc_events` with the device ID, timestamp, and raw DTC value.
3. THE Platform SHALL expose `GET /api/vehicles/:deviceId/dtc` returning all DTC events for the
   device, ordered by `timestamp DESC`.
4. IF a DTC code that was previously recorded is absent from the next event for the same device,
   THEN THE L4-Service SHALL set `resolved_at` on the most recent unresolved record for that code.

---

### Requirement 6: Schema — Device Configuration Table

**User Story:** As a system administrator, I want device configuration records stored so that I can
audit what firmware version and tracking interval each FMC003 is running.

#### Acceptance Criteria

1. THE Platform SHALL create a `device_config` table with columns: `config_id UUID PRIMARY KEY
   DEFAULT gen_random_uuid()`, `device_id TEXT NOT NULL REFERENCES devices(device_id)`,
   `firmware_version TEXT`, `tracking_interval_seconds INTEGER`, `sleep_mode INTEGER`,
   `config_applied_at TIMESTAMPTZ DEFAULT NOW()`, `notes TEXT`.
2. THE Platform SHALL expose `GET /api/devices/:deviceId/config` and `POST
   /api/devices/:deviceId/config` endpoints to read and write configuration records.

---

### Requirement 7: L4-Service — Complete IO Field Persistence

**User Story:** As a backend developer, I want every extracted IO field written to its dedicated
database column so that query performance is predictable and retrospective data analysis is possible.

#### Acceptance Criteria

1. THE L4-Service SHALL write the following fields to their respective `telemetry` columns on every
   batch flush: `ext_voltage`, `bat_voltage`, `bat_level`, `bat_current`, `gnss_status`,
   `gnss_hdop`, `gnss_pdop`, `movement`, `gsm_signal`, `network_type`, `axis_x`, `axis_y`,
   `axis_z`, `trip_odometer`, `eco_score`, `fuel_rate_gps`, `fuel_used_gps`, `sleep_mode`.
2. WHEN a batch of events is written, THE L4-Service SHALL use a single `INSERT ... ON CONFLICT DO
   NOTHING` statement per batch to maintain write performance within the 250 ms batch window.
3. IF any single event in the batch has a constraint violation (duplicate `event_id` or out-of-range
   value), THEN THE L4-Service SHALL skip that event, log the constraint code, and continue writing
   the remaining events.
4. THE L4-Service SHALL update the `devices.last_seen` column whenever a valid event is received
   for a device that is registered in the `devices` table.

---

### Requirement 8: Alert Engine — Extended Alert Types

**User Story:** As a fleet safety manager, I want the system to detect and fire all safety-relevant
alert conditions automatically so that I can respond to incidents in real time.

#### Acceptance Criteria

1. WHEN an event's `axis_x` value exceeds 3000 mg (deceleration) or drops below -3000 mg AND the
   vehicle speed is above 20 km/h, THE Alert_Engine SHALL emit a `harsh_braking` alert with severity
   `HIGH`.
2. WHEN an event's `axis_x` value exceeds 3000 mg (acceleration) AND the vehicle speed is above
   20 km/h, THE Alert_Engine SHALL emit a `harsh_acceleration` alert with severity `MEDIUM`.
3. WHEN an event's `bat_voltage` value is below 3.0 V, THE Alert_Engine SHALL emit a
   `battery_low` alert with severity `HIGH`.
4. WHEN an event's `ext_voltage` value drops from above 11.0 V to below 7.0 V in consecutive
   events for the same device, THE Alert_Engine SHALL emit a `power_disconnect` alert with severity
   `CRITICAL`.
5. WHEN no telemetry event has been received for a device within 600 seconds and that device's last
   known `ignition` state was TRUE, THE Alert_Engine SHALL emit a `device_offline` alert with
   severity `HIGH`.
6. WHEN a vehicle position is detected outside any geofence in the `geofences` table that has been
   assigned to that device via `geofence_assignments`, THE Alert_Engine SHALL emit a `geofence_exit`
   alert referencing the geofence name, with severity `MEDIUM`.
7. WHEN a vehicle position is detected inside a geofence after being outside, THE Alert_Engine SHALL
   emit a `geofence_enter` alert referencing the geofence name, with severity `LOW`.
8. THE Alert_Engine SHALL support four severity levels: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`.
9. THE Platform SHALL update the `alerts` table `CHECK` constraint to accept all four values:
   `CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))`.
10. WHILE a device is in `device_offline` state, THE Alert_Engine SHALL NOT re-emit the offline
    alert until the device resumes sending events (i.e., the cooldown for `device_offline` persists
    until first recovery event).

---

### Requirement 9: Alert Engine — DB-Backed Polygon Geofences

**User Story:** As a fleet manager, I want to define named geofences as polygons stored in the
database so that I can manage fence boundaries without redeploying the service.

#### Acceptance Criteria

1. THE L4-Service SHALL load all geofences and their `geofence_assignments` from TimescaleDB at
   startup and cache them in memory.
2. WHEN a `NOTIFY fleet_geofence_change` message is received on the PostgreSQL notification channel,
   THE L4-Service SHALL reload the geofence cache within 5 seconds without restarting.
3. THE Platform SHALL store geofence polygons as GeoJSON in `geofences.polygon` (TEXT column
   containing a GeoJSON `Polygon` or `MultiPolygon` object).
4. WHEN evaluating a vehicle position against a geofence polygon, THE L4-Service SHALL use a
   point-in-polygon algorithm (ray casting) computed in JavaScript, requiring no PostGIS extension.
5. THE Platform SHALL expose `POST /api/geofences` and `GET /api/geofences` endpoints for geofence
   creation and listing.
6. THE Platform SHALL expose `POST /api/geofences/:geofenceId/assign` to assign a geofence to one
   or more device IDs.
7. THE Platform SHALL remove the hardcoded `GEOFENCE_BOUNDS` environment variable evaluation from
   `alerts.js` after DB-backed geofences are operational.

---

### Requirement 10: Alert Engine — Alert Acknowledgement

**User Story:** As a dispatcher, I want to acknowledge alerts from the UI so that resolved
incidents are not shown as open to the rest of the team.

#### Acceptance Criteria

1. THE L4-Service SHALL expose `PATCH /api/alerts/:alertId/acknowledge` accepting `{ "acknowledged":
   true, "note": "optional string" }` in the request body, protected by `X-API-Key`.
2. WHEN `acknowledged = true` is received, THE L4-Service SHALL set `alerts.acknowledged = TRUE`,
   `alerts.acknowledged_at = NOW()`, and store the optional note in `alerts.metadata.ack_note`.
3. THE Platform SHALL expose `GET /api/alerts` with query parameters `device_id` (optional),
   `severity`, `alert_type`, `acknowledged`, `from`, `to`, `limit`, and `cursor` for fleet-scoped
   alert listing.
4. WHEN the SSE stream sends a `summary` event, THE summary SHALL include a count of
   `unacknowledged_alerts` broken down by severity.

---

### Requirement 11: L4-Service — Real-Time Field Coverage in Live Cache

**User Story:** As a frontend developer, I want every relevant FMC003 field available in the live
cache payload so that I can render complete vehicle cards without issuing additional API calls.

#### Acceptance Criteria

1. THE Live_Cache SHALL include the following fields in every cached vehicle entry: `ext_voltage`,
   `bat_voltage`, `bat_level`, `movement`, `gsm_signal`, `gnss_status`, `gnss_hdop`, `axis_x`,
   `axis_y`, `axis_z`, `trip_odometer`, `eco_score`, `fuel_rate_gps`, `sleep_mode`.
2. THE L4-Service SHALL expose all cached fields in the `GET /api/vehicles/live` response body.
3. THE L4-Service SHALL expose all cached fields in WebSocket `telemetry` events broadcast to
   connected clients.
4. WHEN the SSE `summary` event is constructed by `buildLiveSummary()`, THE L4-Service SHALL
   include fleet-level aggregates for `avg_bat_voltage`, `low_battery_count` (bat_voltage < 3.0 V),
   and `offline_count` (no event in last 600 s) in the `totals` section.

---

### Requirement 12: API — Cursor Pagination

**User Story:** As a frontend developer, I want cursor-based pagination on all history endpoints
so that I can page through large datasets without gaps or duplicates caused by new inserts.

#### Acceptance Criteria

1. THE L4-Service SHALL implement cursor pagination on `GET /api/vehicles/:deviceId/history`,
   `/timeline`, `/alerts`, `/trips`, and `/dtc` endpoints.
2. WHEN `next_cursor` is present in the response, THE cursor SHALL encode the `timestamp` and
   `event_id` of the last record returned, base64-encoded.
3. WHEN a request includes a `cursor` query parameter, THE L4-Service SHALL return only records
   that come strictly before the encoded `timestamp` and `event_id`.
4. WHEN there are no further records, THE L4-Service SHALL return `"next_cursor": null`.

---

### Requirement 13: Frontend — Project Structure and Technology Stack

**User Story:** As a development team, I want the frontend to be a first-class project in the
repository so that it can be containerized and deployed alongside the backend services.

#### Acceptance Criteria

1. THE Platform SHALL contain a `frontend/` directory at the repository root holding a Next.js
   (v14 or later) application with TypeScript configured.
2. THE Frontend SHALL be added to `docker-compose.yml` as a service named `fleet-frontend` on port
   4000, depending on `l4-service`.
3. THE Frontend SHALL use MapLibre GL JS or Leaflet for map rendering, with tile configuration
   defaulting to OpenStreetMap tiles (no API key required).
4. THE Frontend SHALL manage application state with React Query (TanStack Query) for server data
   and React Context or Zustand for local UI state.
5. THE Frontend SHALL consume the L4-Service WebSocket on port 3001 for real-time telemetry and
   alert events, and the SSE endpoint `GET /api/stream/dashboard` for fleet summary updates.
6. WHEN the WebSocket connection is lost, THE Frontend SHALL attempt reconnection with exponential
   backoff starting at 1 second, capped at 30 seconds, without user intervention.
7. THE Frontend SHALL be accessibility-compliant with WCAG 2.1 Level AA as a target, with all
   interactive controls reachable by keyboard and labelled with ARIA attributes.

---

### Requirement 14: Frontend — Fleet Overview Page

**User Story:** As a fleet dispatcher, I want a single overview page showing all vehicle positions
on a map with live status counters so that I can assess fleet state at a glance.

#### Acceptance Criteria

1. THE Frontend SHALL render a Fleet Overview page at route `/` containing a full-viewport map,
   a status summary panel, and an active alerts panel.
2. WHEN the SSE `summary` event is received, THE Frontend SHALL update the status counters —
   `total_vehicles`, `active_vehicles`, `ignition_on`, `low_fuel`, `overspeed`,
   `unacknowledged_alerts` — within 1 second without a full page reload.
3. WHEN a WebSocket `telemetry` event is received, THE Frontend SHALL update the corresponding
   vehicle marker position on the map within 500 ms.
4. THE Frontend SHALL display vehicle markers color-coded by state: green (moving, ignition on),
   amber (idle, ignition on, speed = 0), red (alert active), grey (stale / offline).
5. WHEN a vehicle marker is clicked, THE Frontend SHALL display a popup with the vehicle's
   `device_id`, speed, ignition state, fuel level, battery voltage, and a link to the Vehicle
   Detail page.
6. THE Frontend SHALL cluster vehicle markers when more than 20 vehicles are within the same map
   viewport area.
7. THE status summary panel SHALL show counters for: total vehicles, active (moving), idle,
   low fuel, overspeeding, and open critical alerts.

---

### Requirement 15: Frontend — Vehicle Detail Page

**User Story:** As a fleet manager, I want a dedicated page for each vehicle showing all telemetry
fields, diagnostic data, trip history, and alerts so that I can conduct a complete vehicle review
without switching between tools.

#### Acceptance Criteria

1. THE Frontend SHALL render a Vehicle Detail page at route `/vehicles/:deviceId` with tabbed
   sections: Overview, Trips, History, Alerts, Diagnostics.
2. THE Overview tab SHALL display: live position on a mini-map, a telemetry card grid covering
   speed, ignition, fuel level, odometer, RPM, engine load, battery voltage, ext voltage, GNSS
   quality, GSM signal, movement state, and eco score.
3. WHEN a WebSocket `telemetry` event is received for the current device, THE Frontend SHALL update
   all telemetry card values within 500 ms.
4. THE Trips tab SHALL display a paginated list of completed trips with start/end time, distance,
   duration, fuel consumed, max speed, and eco score.
5. WHEN a trip row is selected, THE Frontend SHALL render the trip route on the mini-map as a
   polyline, loaded from `GET /api/trips/:tripId/route`.
6. THE History tab SHALL display a time-series chart of speed and fuel level, using data from
   `GET /api/vehicles/:deviceId/history`, with date-range filter controls.
7. THE Alerts tab SHALL display the vehicle's alert history with severity badges, alert type, and
   an acknowledge button that calls `PATCH /api/alerts/:alertId/acknowledge`.
8. THE Diagnostics tab SHALL display: RPM, engine load, DTC codes, and all extended IO field
   values from the latest event.

---

### Requirement 16: Frontend — Fleet Map Page

**User Story:** As a dispatcher, I want a full-screen fleet map with filtering so that I can focus
on a subset of vehicles during an incident.

#### Acceptance Criteria

1. THE Frontend SHALL render a Fleet Map page at route `/map` with a full-screen map and a
   collapsible vehicle filter panel.
2. THE filter panel SHALL support filtering vehicles by: status (active / idle / offline), alert
   type, driver (when assigned), vehicle type.
3. WHEN a filter is changed, THE Frontend SHALL update the visible markers on the map within 300 ms
   without a network request (filter applied client-side against the cached live data).
4. THE map SHALL display geofence polygon overlays fetched from `GET /api/geofences`.
5. WHEN a geofence polygon is clicked, THE Frontend SHALL display the geofence name, assigned
   devices, and enter/exit alert status.

---

### Requirement 17: Frontend — Alerts Center Page

**User Story:** As a safety manager, I want a dedicated alerts page with severity filters and bulk
acknowledgement so that I can work through an alert backlog efficiently.

#### Acceptance Criteria

1. THE Frontend SHALL render an Alerts Center page at route `/alerts` displaying a sortable,
   filterable table of all fleet alerts.
2. THE table SHALL support filtering by severity (LOW / MEDIUM / HIGH / CRITICAL), alert type,
   device, date range, and acknowledgement status.
3. WHEN a WebSocket `alert` event is received, THE Frontend SHALL prepend the new alert to the
   table and increment the severity counter without a full table reload.
4. THE Frontend SHALL provide a per-row acknowledge button and a bulk acknowledge action for
   selected rows, both calling `PATCH /api/alerts/:alertId/acknowledge`.
5. THE Frontend SHALL display an alert detail drawer showing the full alert metadata, position
   on a mini-map, and the telemetry event that triggered it.

---

### Requirement 18: Frontend — Analytics Page

**User Story:** As a fleet manager, I want aggregated analytics charts so that I can report on
fleet utilization, fuel consumption, and driver behavior over configurable time periods.

#### Acceptance Criteria

1. THE Frontend SHALL render an Analytics page at route `/analytics` with a date range selector
   and fleet-level charts.
2. THE Fleet Utilization chart SHALL display hourly active vehicle count sourced from the
   `telemetry_hourly_summary` continuous aggregate via a new `GET /api/analytics/utilization`
   endpoint.
3. THE Fuel Consumption chart SHALL display total `fuel_used_gps` per vehicle per day.
4. THE Trip Metrics table SHALL display per-vehicle totals for: trip count, total distance,
   total fuel, average eco score, and maximum speed for the selected date range.
5. WHERE a driver is assigned to a vehicle, THE Analytics page SHALL allow filtering all charts
   and tables by driver.

---

### Requirement 19: Frontend — Device Management Page

**User Story:** As a system administrator, I want a device management page so that I can register
new FMC003 devices, assign VINs and drivers, and review configuration without accessing the
database directly.

#### Acceptance Criteria

1. THE Frontend SHALL render a Device Management page at route `/devices` displaying the full
   device registry from `GET /api/devices`.
2. THE page SHALL provide a form to register a new device by entering IMEI, name, VIN, ICCID,
   registration number, vehicle type, and optionally assigning a driver.
3. WHEN a new device is submitted, THE Frontend SHALL call `POST /api/devices` and display a
   success or validation error notification within 2 seconds.
4. THE page SHALL allow editing all device fields via an inline form, calling
   `PATCH /api/devices/:deviceId` on save.
5. THE page SHALL show the last-seen timestamp for each device, with devices unseen for more than
   600 seconds highlighted in red.
6. THE Device Management page SHALL display the current configuration record from
   `GET /api/devices/:deviceId/config` in a read-only panel.

---

### Requirement 20: Real-Time Performance

**User Story:** As a fleet dispatcher, I want live vehicle positions and alerts to appear within
20 seconds of the event occurring on the device so that I can react to incidents in near real time.

#### Acceptance Criteria

1. THE Platform SHALL deliver telemetry events from FMC003 device transmission to Frontend map
   marker update within 20 seconds end-to-end under normal network conditions.
2. THE L4-Service SHALL update the Live_Cache and broadcast the WebSocket `telemetry` event within
   250 ms of receiving the NATS message.
3. THE Frontend SHALL render the updated marker position within 500 ms of receiving the WebSocket
   `telemetry` event.
4. WHILE the WebSocket connection is active, THE Frontend SHALL NOT poll the REST API for live
   vehicle positions; all live updates SHALL flow through the WebSocket.
5. THE SSE stream SHALL send a `heartbeat` comment every 15 seconds to prevent proxy timeouts.
6. WHEN a batch of 20 events is accumulated, THE L4-Service SHALL flush the batch to TimescaleDB
   within the 250 ms batch window defined in `consumer.js`.

---

### Requirement 21: Security and Access Control

**User Story:** As a system administrator, I want all API endpoints protected by an API key and
the frontend served behind proper CORS restrictions so that the system cannot be accessed without
credentials.

#### Acceptance Criteria

1. THE L4-Service SHALL require a valid `X-API-Key` header on all REST, WebSocket, and SSE
   endpoints except `GET /health`.
2. THE L4-Service SHALL reject requests from origins not listed in the `ALLOWED_ORIGINS`
   environment variable with a `403 Forbidden` response.
3. THE L4-Service SHALL rate-limit general endpoints to 500 requests per 15 minutes per IP and
   history/analytics endpoints to 60 requests per 15 minutes per IP.
4. THE L4-Service SHALL log all authentication failures to the `audit_log` table with the client
   IP address.
5. THE Frontend SHALL store the API key in an environment variable (`NEXT_PUBLIC_API_KEY`) and
   include it in all API requests; the key SHALL NOT be embedded in client-side bundle code in
   production (use server-side Next.js API routes as a proxy).
6. IF an API key is not configured in production (`NODE_ENV = production` and `API_KEY` is empty),
   THEN THE L4-Service SHALL respond to all protected endpoints with `503 Service Unavailable`.

---

### Requirement 22: Observability and Health

**User Story:** As a system administrator, I want health endpoints and structured logs for every
service so that I can monitor the platform and diagnose issues without accessing container internals.

#### Acceptance Criteria

1. THE L4-Service SHALL expose `GET /health` returning `{ "status": "ok", "ts": "<ISO timestamp>",
   "db": "ok" | "error", "nats": "ok" | "error", "cache_size": <integer> }`.
2. THE L4-Service SHALL emit a structured JSON log line for every processed event batch, including
   `batch_size`, `flush_duration_ms`, and `total_processed`.
3. THE Frontend SHALL expose `GET /api/health` (Next.js API route) returning its own build version
   and the last successful L4-Service health check result.
4. THE Platform SHALL retain all service logs in Docker `json-file` driver with `max-size: 10m`
   and `max-file: 3` to prevent unbounded disk growth.
5. WHEN the NATS connection is lost, THE L4-Service SHALL log the disconnection, attempt
   reconnection every 5 seconds, and resume consuming from the durable consumer's last ack
   sequence once reconnected.

---

### Requirement 23: Data Retention and Aggregation

**User Story:** As a platform operator, I want clear data retention policies so that storage costs
are predictable and old data is cleaned up automatically.

#### Acceptance Criteria

1. THE Platform SHALL retain raw `telemetry` events for 90 days via the existing TimescaleDB
   retention policy.
2. THE Platform SHALL retain `alerts` records for 180 days.
3. THE Platform SHALL retain `audit_log` records for 365 days.
4. THE Platform SHALL retain `trips` records for 365 days.
5. THE Platform SHALL retain `dtc_events` records for 365 days.
6. THE `telemetry_hourly_summary` continuous aggregate SHALL refresh every hour covering data up
   to 1 hour before `NOW()`, with a start offset of 3 hours.
7. THE Platform SHALL add a new continuous aggregate `telemetry_daily_summary` bucketing by
   `1 day`, computing `avg_speed`, `max_speed`, `total_fuel_used_gps`, `total_distance`
   (via max-min `trip_odometer`), and `event_count` per device per day.

---

### Requirement 24: Docker Compose — Odoo Removal and Frontend Addition

**User Story:** As a developer, I want the Docker Compose stack to reflect the redesigned
architecture so that `docker compose up -d` starts all required services and nothing more.

#### Acceptance Criteria

1. THE Platform SHALL remove the following services from `docker-compose.yml`: `odoo`,
   `odoo-init`, `odoo-module-init`, `odoo-db`.
2. THE Platform SHALL add a `fleet-frontend` service to `docker-compose.yml` building from
   `./frontend`, exposing port 4000, depending on `l4-service: condition: service_healthy`.
3. THE `fleet-frontend` service SHALL accept the following environment variables:
   `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_API_KEY`.
4. THE `ALLOWED_ORIGINS` environment variable in `.env.example` SHALL be updated to reference
   `http://localhost:4000` instead of `http://localhost:8069`.
5. THE Platform SHALL update the CI smoke test (`.github/workflows/smoke-demo.yml`) to validate
   that the frontend container responds on port 4000 with HTTP 200 after `docker compose up`.
