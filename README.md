
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

2. Run one command bootstrap

```powershell
.\scripts\bootstrap-all.ps1
```

3. Open Odoo and log in

- URL: `http://localhost:8069`
- Database: `odoo`
- User: `admin`
- Password: `admin`

4. Open Fleet Telemetry list view

- `http://localhost:8069/web#action=87&model=fleet.vehicle.telemetry&view_type=list&cids=1&menu_id=70`

What this script does:

- Starts L1-L4 services (simulator, EMQX, NATS, adapter, TimescaleDB, L4)
- Starts Odoo + Odoo DB
- Initializes Odoo base database (idempotent)
- Installs/upgrades `fleet_telemetry_connector`
- Restarts Odoo and prints final service status

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

1. Start Odoo profile with `docker compose --profile with-odoo up -d odoo odoo-db`
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

This repository now includes a Python Teltonika-style simulator that sends binary Codec 8 AVL packets over TCP.

Files:

- simulator/main.py (input layer + CLI UI + main loop)
- simulator/car.py (vehicle physics)
- simulator/fmc003.py (device state + IO generation)
- simulator/encoder.py (AVL/Codec 8 binary encoding + CRC-16/IBM)
- simulator/network.py (TCP login + packet send + ACK handling)
- simulator/demo_server.py (local protocol debug server with detailed decode output)

### Quick Demo (2 terminals)

1) Install dependency (once):

```powershell
python -m pip install pynput
```

2) Terminal A: start protocol debug server:

```powershell
python simulator/demo_server.py
```

3) Terminal B: start simulator:

```powershell
python simulator/main.py --host 127.0.0.1 --port 5055 --imei 352093114305816
```

Controls:

- Arrow keys or WASD
- Ctrl+C to stop

What you should see:

- Terminal B: live CLI speedometer, heading, position, IO summary, ACK
- Terminal A: decoded packet details (timestamp, lat/lon, speed, angle, IO map, CRC check)

### Useful CLI options

- --debug (line logs mode)
- --no-ui (disable dashboard)
- --no-gps-noise
- --interval 1.0
- --latitude 36.8065 --longitude 10.1815

Example:

```powershell
python simulator/main.py --host 127.0.0.1 --port 5055 --imei 352093114305816 --no-ui --debug
```

### Run against Traccar instead of local demo server

If Traccar is running and listening on TCP 5055:

```powershell
python simulator/main.py --host 127.0.0.1 --port 5055 --imei 352093114305816
```

Then verify forwarding in adapter logs.

### Troubleshooting

- If you get ModuleNotFoundError: pynput, install with python -m pip install pynput.
- In PowerShell, use py or python consistently with the same environment.
- If key controls feel unresponsive, click/focus the simulator terminal window and use WASD.
- If ACK/reconnect loops appear, verify server host/port and firewall access.

### Realism notes and tuning points

Current simulator quality:

- Good for protocol and integration tests:
  - Valid Codec 8 framing
  - IMEI login flow
  - CRC-16/IBM
  - AVL record + grouped IO sections
- Not yet a full FMC003 profile clone.

To move closer to what a physical FMC003 sends, tune these areas:

1. IO map completeness
    - Add more AVL IDs actually enabled in your target FMC003 configuration profile.
    - Keep exact data types and scaling (1/2/4/8-byte groups) matching Teltonika docs.

2. Event IO ID behavior
    - Set event_io_id to the actual trigger source per record (not always a fixed value).

3. Multi-record buffering
    - Implement burst sending with multiple AVL records in one packet when simulating offline cache flush.

4. Realistic timing profiles
    - Different intervals for moving, stopped, ignition off, and corner cases.

5. GNSS realism
    - Add HDOP/accuracy behavior, occasional satellite drops, and speed jitter smoothing.

6. Vehicle dynamics realism
    - Use acceleration curves and turn-rate limits rather than instant steering increments.

7. Power/ignition states
    - Simulate ACC transitions, sleep/wake, and battery voltage drift.

8. Field-level validation
    - Capture real device packets from your FMC003 and compare bytes field-by-field with simulator output.

For strict parity work, use one known real-device packet capture as a golden sample and verify:

- record count values
- timestamp precision
- signed coordinate encoding
- each IO ID value, width, and ordering
- CRC over the correct payload region

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
