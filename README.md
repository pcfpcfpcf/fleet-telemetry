
# Fleet Telemetry Platform
### Local Development Environment

> A complete, modular Docker Compose stack for simulating, processing, storing, and visualizing vehicle telemetry data. Includes real-time and historical data flows, business logic, and Odoo ERP integration.

---

## How the Platform Works (End-to-End)

**1. Simulator**
    - Simulates 5 GPS devices, each sending normalized telemetry (position, speed, fuel, etc.) every 30 seconds.
    - Publishes data via MQTT to the EMQX broker.

**2. EMQX Broker**
    - Receives MQTT messages from the simulator.
    - Makes telemetry available for downstream consumption.

**3. Adapter**
    - Subscribes to EMQX MQTT topics (telemetry/#).
    - Validates and normalizes events.
    - Publishes valid events to NATS JetStream (TELEMETRY stream).

**4. NATS JetStream**
    - Message queue for telemetry events, enabling reliable, decoupled processing.

**5. L4-Service**
    - Consumes telemetry from NATS.
    - Persists events to TimescaleDB (hypertable for time-series data).
    - Exposes REST endpoints (e.g., /vehicles) and WebSocket for real-time data.
    - Evaluates alerts and broadcasts events to clients.

**6. TimescaleDB**
    - Stores all telemetry events with efficient time-series queries.

**7. Odoo & Fleet Telemetry Connector**
    - Odoo ERP runs with its own Postgres DB.
    - The custom connector module fetches vehicle data from L4-service (/vehicles endpoint).
    - Syncs and upserts telemetry into Odoo for dashboards and business logic.

**Data Flow Summary:**

Simulator → EMQX (MQTT) → Adapter → NATS → L4-service → TimescaleDB (+ WebSocket/REST) → Odoo (via connector)

**CI/CD:**
    - GitHub Actions workflow brings up the stack, waits for health, runs integration tests, and validates Odoo sync.

---

## Fresh Clone Quickstart (Everything Visible)

For a new developer cloning this repository, use this flow to get all services up and immediately see telemetry in Odoo.

Note: this quickstart is for onboarding and UI checks. The CI pipeline remains the quality gate for merge/release decisions.

Prerequisites:

- Docker Desktop running
- Git installed
- PowerShell 5+ (Windows)

1. Clone and open the repo

```powershell
git clone https://github.com/fedibenam/Fleet-Telemetry-Platform_test.git
cd Fleet-Telemetry-Platform_test
```

2. Run one command startup

```powershell
docker compose up -d
```

3. Open Odoo and log in

- URL: `http://localhost:8069`
- Database: `odoo`
- User: `admin`
- Password: `admin`

4. Open Fleet Telemetry list view

- `http://localhost:8069/web#action=87&model=fleet.vehicle.telemetry&view_type=list&cids=1&menu_id=70`

What this command does:

- Starts L1-L4 services (simulator, EMQX, NATS, adapter, TimescaleDB, L4)
- Starts Odoo + Odoo DB
- Initializes Odoo base database (idempotent)
- Installs/upgrades fleet_telemetry_connector automatically via one-shot init container
- Simulator vehicles cruise by default, so the Odoo list view shows live non-zero speeds on a fresh start

---


## Architecture

```
┌─────────────────────────┐
│   GPS Device Simulator  │  5 fake FMC003 devices — Tunis area
└────────────┬────────────┘
             │ MQTT (plain, local only)
             ▼
┌─────────────────────────┐
│       EMQX Broker       │  Receives all device connections
└────────────┬────────────┘
             │ subscribes to telemetry/#
             ▼
┌─────────────────────────┐
│    Adapter Service      │  MQTT → NATS bridge (custom Node.js)
└────────────┬────────────┘
             │ JetStream publish
             ▼
┌─────────────────────────┐
│    NATS JetStream       │  Message queue — 24hr retention
└────────────┬────────────┘
             │ NATS subscription (when L4 is ready)
             ▼
┌─────────────────────────┐
│   L4 Node.js Service    │  Business logic + REST + WebSocket
└────────────┬────────────┘
             │ PostgreSQL
             ▼
┌─────────────────────────┐
│      TimescaleDB        │  Time-series database
└─────────────────────────┘

── optional paths ────────────────
┌─────────────────────────┐
│        Traccar          │  Teltonika binary decoder
└─────────────────────────┘

┌─────────────────────────┐
│        Odoo 17          │  Fleet manager dashboard + L5 connector module
└────────────┬────────────┘
             │ PostgreSQL
             ▼
┌─────────────────────────┐
│     Odoo Database       │  Separate from TimescaleDB
└─────────────────────────┘
```

---

## What Is Working Right Now

Validated live in adapter logs:

```
✓ FMC003_SIM_001 (Speed: 22.1 km/h, Fuel: 97.0%, Ignition: ON) → NATS
✓ FMC003_SIM_002 (Speed: 11.6 km/h, Fuel: 82.5%, Ignition: ON) → NATS
✓ FMC003_SIM_003 (Speed: 88.1 km/h, Fuel: 66.6%, Ignition: OFF) → NATS
✓ FMC003_SIM_004 (Speed: 35.5 km/h, Fuel: 52.4%, Ignition: ON) → NATS
✓ FMC003_SIM_005 (Speed: 100.2 km/h, Fuel: 36.9%, Ignition: ON) → NATS
```

Full pipeline validated:

- EMQX starts healthy and accepts MQTT connections
- NATS starts healthy with JetStream enabled
- Adapter bridges EMQX → NATS successfully
- Simulator sends 5 vehicles every 30 seconds continuously
- TimescaleDB initialized with full schema — ready for writes
- L4 consumes telemetry from NATS and persists to TimescaleDB
- L4 REST endpoints (`/health`, `/vehicles`, `/alerts`) are serving data
- L4 WebSocket endpoint (`ws://localhost:3001`) streams live events

Important: this project includes a GitHub Actions workflow runner for automated smoke validation on every push/PR, so pipeline health is continuously verified in CI.

---

## What We Added During This Setup

To make onboarding easy and CI stable, we implemented:

- Local one-command pipeline script: `demo.ps1`
- Local reset script: `demo-reset.ps1`
- GitHub Actions smoke pipeline: `.github/workflows/smoke-demo.yml`
- GitHub Actions Terraform validation pipeline: `.github/workflows/terraform-validate.yml`

Key reliability fixes applied:

- Adapter startup race condition fixed (reliable MQTT subscription)
- Adapter now ensures NATS `TELEMETRY` stream exists before publish
- EMQX switched to environment-based config in Compose (no mounted `emqx.conf` in runtime path)
- NATS command/config corrected for Compose and CI
- TimescaleDB schema fixed for hypertable constraints
- CI bind-mount permissions hardened (`data/*` prepared and chmod in workflow)
- CI teardown hardened to include simulator profile and tolerate cleanup leftovers

---

## CI/CD Pipelines

![CI](https://github.com/fedibenam/Fleet-Telemetry-Platform_test/actions/workflows/smoke-demo.yml/badge.svg)
![Terraform Validation](https://github.com/fedibenam/Fleet-Telemetry-Platform_test/actions/workflows/terraform-validate.yml/badge.svg)

This repository uses GitHub Actions to continuously validate both the local runtime pipeline and Terraform infrastructure code.

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| Demo Smoke Pipeline | .github/workflows/smoke-demo.yml | Push, Pull Request, Manual | Starts core Docker services, verifies health, runs simulator traffic, and checks adapter forwarding to NATS |
| Odoo Integration Smoke | .github/workflows/smoke-demo.yml | Push, Pull Request, Manual | Initializes Odoo DB, installs connector module, runs sync from L4, and verifies telemetry rows in Odoo |
| Terraform Validation | .github/workflows/terraform-validate.yml | Push/Pull Request on infra/terraform, Manual | Runs terraform fmt -check, terraform init --backend=false, terraform validate, and dry-run terraform plan |

Validation policy:

- smoke-demo validates end-to-end integration of Simulator, EMQX, Adapter, NATS, TimescaleDB, and L4 REST/WebSocket paths
- odoo-smoke validates end-to-end L4 to L5 presentation path (Odoo DB init, connector install, sync, and fleet rows)
- terraform-validate blocks malformed or syntactically invalid IaC before merge

---

## L5 Odoo Connector (New)

A starter Odoo module is now included at `odoo/addons/fleet_telemetry_connector`.

What it does:

- Fetches vehicle snapshots from L4 endpoint `/vehicles`
- Stores/upserts records in Odoo model `fleet.vehicle.telemetry`
- Provides Vehicles list and detail views in Odoo
- Adds a scheduled sync job (every minute)
- Adds settings field to configure L4 base URL

To use it:

1. Start Odoo services with `docker compose up -d odoo odoo-db`
2. Open Odoo on `http://localhost:8069`
3. Install app `Fleet Telemetry Connector`
4. Open Fleet Telemetry > Vehicles and run refresh


## Run It manually :

**Start core services:**
```powershell
docker compose up -d emqx traccar nats timescaledb adapter l4-service simulator
```

**Confirm everything is healthy:**
```powershell
docker compose ps
```

Expected: core services show `Up (healthy)`

**Watch live data flow:**
```powershell
docker logs fleet-adapter --tail 100
```

**Stop everything:**
```powershell
docker compose down
```

---

## Python FMC003 Simulator (Codec 8)

This simulator sends Teltonika-style binary Codec 8 packets over TCP.

### Quick start

Install dependency once:

```powershell
python -m pip install pynput
```

Terminal A (packet inspector):

```powershell
python simulator/demo_server.py
```

Terminal B (simulator):

```powershell
python simulator/main.py --host 127.0.0.1 --port 5055 --imei 352093114305816
```

#### Alternative ways

Terminal B (bridge)

````powershell
py -u game_bridge.py --debug
````

Terminal C (monitor)

````powershell
py monitor.py --host 127.0.0.1 --port 8765 --interval 1
````

Controls: WASD/arrow keys, Ctrl+C to stop.

### Simulator files at a glance

- `simulator/main.py`: CLI device simulator entry point (connects, logs in, sends Codec 8 AVL).
- `simulator/fmc003.py`: FMC003 behavior model (OBD-like metrics, events, geofence logic).
- `simulator/encoder.py`: Codec 8 binary packet builder and CRC framing.
- `simulator/network.py`: TCP session handling (IMEI login + AVL ACK flow).
- `simulator/demo_server.py`: local packet inspector to verify what is actually sent.
- `simulator/game_bridge.py`: HTTP bridge from MTA telemetry to Teltonika Codec 8 TCP.
- `simulator/monitor.py`: terminal dashboard for devices, events, geofence status, and live stats.
- `simulator/profiles/fmc003.default.json`: tuning profile (thresholds, geofences, IO mappings).
- `simulator/mta_resource/`: MTA client/server Lua resource that publishes vehicle telemetry.

### Most useful options

```text
--debug --no-ui --profile simulator/profiles/fmc003.default.json --no-gps-noise
```

Example:

```powershell
python simulator/main.py --host 127.0.0.1 --port 5055 --imei 352093114305816 --no-ui --debug --profile simulator/profiles/fmc003.default.json
```

### Replay real packets (byte-for-byte)

Use replay mode if you want to transmit captured FMC003 packets exactly as-is:

```powershell
python simulator/main.py --host 127.0.0.1 --port 5055 --imei 352093114305816 --replay-hex-file .\packets.hex --debug
```

Loop replay:

```powershell
python simulator/main.py --host 127.0.0.1 --port 5055 --imei 352093114305816 --replay-hex-file .\packets.hex --replay-loop --replay-interval 1.0 --debug
```

### MTA bridge (LAN)

1. Start target receiver (Traccar on 5055 or local demo server).
2. Start bridge:

```powershell
python simulator/game_bridge.py --listen-host 0.0.0.0 --listen-port 8765 --target-host 127.0.0.1 --target-port 5055 --debug
```

3. Copy `simulator/mta_resource` to MTA resources as `resources/fmc003_bridge/`.
4. In MTA server console:

```text
refresh
start fmc003_bridge
```

### Quick troubleshooting

- If no traffic appears, kill duplicate Python processes and start only one bridge + one demo server.
- If MTA client is remote, set bridge host in `simulator/mta_resource/client.lua` to bridge LAN IP (not 127.0.0.1).
- If monitor shows data but bridge terminal does not, you are likely watching a different bridge process.

---

## Reset From Scratch

```powershell
docker compose down
Remove-Item -Recurse -Force ".\data\timescaledb\*"
docker compose up -d emqx traccar nats timescaledb adapter l4-service simulator
```

---

## Delivery Status

| Component | Owner | Status |
|---|---|---|
| Infrastructure (servers, network, volumes) | Cloud Engineer | ✅ Done |
| EMQX → NATS data pipeline | Cloud Engineer | ✅ Done |
| GPS device simulator | Cloud Engineer | ✅ Done |
| TimescaleDB schema | Cloud Engineer | ✅ Done |
| L4 Node.js processing service | Software Engineer | ✅ Done |
| TimescaleDB writes | Software Engineer | ✅ Done |
| Odoo fleet module | Software Engineer | 🚧 In Progress (L5 connector scaffolded) |

-----------------


## What Is Out of Scope for This Phase

- TLS encryption (production concern)
- Device authentication (production concern)
- Cloud deployment — AWS infrastructure via Terraform (next phase)
- Advanced Odoo dashboards/maps and real-time UX polish
