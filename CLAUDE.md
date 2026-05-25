# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## What This Project Is

Fleet Telemetry Platform — a Docker Compose stack that simulates, ingests, stores, and visualizes vehicle telemetry. The complete data flow is:

```
Simulator (MQTT) → EMQX → Adapter (Node.js) → NATS JetStream → L4-Service (Node.js) → TimescaleDB
                                                                                       ↓
                                                                            Odoo 17 (via connector)
```

## Commands

### Start / Stop

```bash
# Start everything (including Odoo)
docker compose up -d

# Core services only (no Odoo)
docker compose up -d emqx traccar nats timescaledb adapter l4-service simulator

# Stop
docker compose down

# Full reset (destroys data volumes)
make reset
```

### Observe

```bash
make health                        # curl all service endpoints
make status                        # docker compose ps
docker compose logs -f adapter     # watch MQTT→NATS forwarding
docker compose logs -f l4-service  # watch DB writes + alerts
make db                            # psql into TimescaleDB (fleet/fleet)
```

### Test pipeline end-to-end

```bash
make test-pipeline                 # inject a test MQTT event and query TimescaleDB
```

### Python simulator (standalone, no Docker)

```bash
pip install paho-mqtt pynput
python simulator/main.py --host 127.0.0.1 --port 5055 --imei 352093114305816
# Useful flags: --no-ui --debug --no-tcp --mqtt-host emqx --mqtt-port 1883
```

### Odoo

- URL: `http://localhost:8069` — user `admin`, password `admin`, database `odoo`
- Module is auto-installed on first `docker compose up` via `odoo-init` and `odoo-module-init` one-shot containers.
- To reinstall the module manually:
  ```bash
  docker exec fleet-odoo odoo -d odoo -u fleet_telemetry_connector --stop-after-init
  ```

## Architecture

### Service layers

| Layer | Container(s) | Role |
|---|---|---|
| L1 | `simulator`, `simulator-2..5` | 5 fake FMC003 GPS devices publishing JSON to MQTT `telemetry/#` every 30 s |
| L2 | `emqx` (port 1883/8883) | MQTT broker; admin dashboard on port 18083 |
| L3 | `adapter` | Node.js bridge: subscribes `telemetry/#` on EMQX, validates payload, publishes to NATS `telemetry.raw.<device_id>` |
| L3 | `nats` (port 4222) | NATS JetStream; `TELEMETRY` stream retains 7 days, monitoring on port 8222 |
| L3 | `traccar` (port 5055/8082) | Optional Teltonika binary (Codec 8) decoder; forwards to adapter `/events` webhook |
| L4 | `l4-service` (port 3000/3001) | Node.js: consumes NATS, writes to TimescaleDB, exposes REST + WebSocket |
| L4 | `timescaledb` (port 5432) | TimescaleDB (PostgreSQL 16); schema in `init/timescaledb/01_schema.sql` |
| L5 | `odoo` (port 8069) | Odoo 17 ERP; `fleet_telemetry_connector` module syncs vehicle state from L4 `/vehicles` |
| L5 | `odoo-db` (port 5433) | Separate PostgreSQL 15 for Odoo — distinct from TimescaleDB |

### Adapter (`adapter/adapter.js`)

- Connects to NATS first, ensures `TELEMETRY` stream exists, then connects to MQTT.
- Validates all incoming events against a strict schema before publishing (required fields, type checks, coordinate/value range checks).
- Also exposes `POST /events` for Traccar webhook ingestion.
- `device_id` is sanitized before use in NATS subjects (only `[a-zA-Z0-9_-]` allowed).

### L4-Service (`l4-service/src/`)

- `index.js` — entry point; waits for DB, then starts API and consumer in parallel.
- `consumer.js` — JetStream durable consumer (`l4-processor`) on `TELEMETRY` / `telemetry.raw.*`. Normalizes C-adapter payloads (coerces integers to booleans/numbers), tracks per-device timestamps (bounded at 10 000 entries), calls `writeTelemetry` + `evaluateAlerts`.
- `api.js` — Express (port 3000) + WebSocket (port 3001). Auth via `X-API-Key` header. Rate-limited (100 req/15 min general, 30 req/15 min for per-device history). CORS restricted to `ALLOWED_ORIGINS`.
- `db.js` — pg pool + `writeTelemetry` / `writeAuditLog`.
- `alerts.js` — alert evaluation per event.

**REST endpoints** (all except `/health` require `X-API-Key`):
- `GET /health`
- `GET /vehicles[?all=true]` — latest snapshot per vehicle (default: active in last 15 min)
- `GET /vehicles/:id/telemetry` — up to 500 historical records
- `GET /alerts` — last 100 alerts

### TimescaleDB schema (`init/timescaledb/01_schema.sql`)

Hypertables: `telemetry`, `alerts`, `audit_log` (all partitioned by `timestamp`).  
Regular tables: `devices`, `geofences`, `geofence_assignments`.  
Materialized view: `telemetry_hourly_summary` (continuous aggregate, 1-hour buckets).  
Retention: raw telemetry 90 days, alerts 180 days, audit log 365 days.

### Odoo connector (`odoo/addons/fleet_telemetry_connector/`)

- Model `fleet.vehicle.telemetry` — stores vehicle snapshots fetched from L4.
- Model `fleet.vehicle.alert` — mirrors L4 alerts.
- `res_config_settings.py` — adds L4 base URL setting in Odoo Settings.
- Scheduled sync cron (`ir_cron.xml`) runs every minute.
- Odoo init flow: `odoo-init` (DB + base module) → `odoo-module-init` (installs connector) → `odoo` (runtime). All one-shot containers exit cleanly; `odoo` depends on `odoo-module-init` completing.

### NATS auth (`config/nats/nats.conf`)

Adapter uses credentials `NATS_ADAPTER_PASSWORD`; L4 service uses `NATS_L4_PASSWORD`. Both set via `.env` (copy `.env.example` → `.env`).

## Environment

Copy `.env.example` to `.env` before first run. Required variables:
- `TIMESCALE_DB`, `TIMESCALE_USER`, `TIMESCALE_PASSWORD`, `DATABASE_URL`
- `NATS_ADAPTER_PASSWORD`, `NATS_L4_PASSWORD`
- `API_KEY` — shared secret for L4 REST endpoints and Odoo connector
- `ALLOWED_ORIGINS` — comma-separated CORS origins
- `ODOO_USER`, `ODOO_PASSWORD`, `ODOO_DB`

## CI

GitHub Actions (`smoke-demo.yml`) runs on push/PR to `main`, `master`, `testing`:
1. Generates mTLS certs.
2. Starts all services via `docker compose up`.
3. Waits for health, then validates: adapter forwards to NATS, L4 REST endpoints serve data, TimescaleDB has rows, Odoo shows synced fleet records.

Terraform validation runs separately on changes to `infra/terraform/` (`terraform-validate.yml`).
