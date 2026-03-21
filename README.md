# Fleet Telemetry Platform
### Local Development Environment

> A complete Docker Compose setup for building and testing the fleet telemetry system locally.
> Simulates a real-world deployment tracking 20,000 vehicles at 667 messages/second peak.

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
│       Port: 1883        │  Admin UI: 18083
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
│    Port: 4222           │  Monitor: 8222
└────────────┬────────────┘
             │ NATS subscription (when L4 is ready)
             ▼
┌─────────────────────────┐
│   L4 Node.js Service    │  Business logic — NOT built yet
│   Port: 3000 / 3001     │  Software Engineer responsibility
└────────────┬────────────┘
             │ PostgreSQL
             ▼
┌─────────────────────────┐
│      TimescaleDB        │  Time-series database — ready and waiting
│      Port: 5432         │
└─────────────────────────┘

── optional paths ──────────────────────────────────────────

┌─────────────────────────┐
│        Traccar          │  Teltonika binary decoder
│        Port: 5055       │  Only needed for real FMC003 devices
└─────────────────────────┘

┌─────────────────────────┐
│        Odoo 17          │  Fleet manager dashboard
│        Port: 8069       │  Module not built yet
└────────────┬────────────┘
             │ PostgreSQL
             ▼
┌─────────────────────────┐
│     Odoo Database       │  Separate from TimescaleDB
│     Port: 5433          │
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

---

## Run It

**One-command demo pipeline (recommended for cloners):**
```powershell
.\demo.ps1
```

This script automatically:
- Starts emqx, nats, timescaledb, adapter
- Waits for healthy state
- Starts simulator
- Verifies all 5 mock vehicles are forwarded to NATS

**Clean reset helper:**
```powershell
.\demo-reset.ps1
```

Or run manually:

**Start core services:**
```powershell
docker compose up -d emqx nats timescaledb adapter
```

**Confirm everything is healthy:**
```powershell
docker compose ps
```

Expected: all four services show `Up (healthy)`

**Start the GPS simulator:**
```powershell
docker compose --profile simulate up -d simulator
```

**Watch live data flow:**
```powershell
docker logs fleet-adapter --tail 100
```

**Stop everything:**
```powershell
docker compose down
```

---

## Reset From Scratch

```powershell
docker compose down
Remove-Item -Recurse -Force ".\data\timescaledb\*"
docker compose up -d emqx nats timescaledb adapter
```

---

## Delivery Status

| Component | Owner | Status |
|---|---|---|
| Infrastructure (servers, network, volumes) | Cloud Engineer | ✅ Done |
| EMQX → NATS data pipeline | Cloud Engineer | ✅ Done |
| GPS device simulator | Cloud Engineer | ✅ Done |
| TimescaleDB schema | Cloud Engineer | ✅ Done |
| L4 Node.js processing service | Software Engineer | ⏳ Pending |
| TimescaleDB writes | Software Engineer | ⏳ Waiting on L4 |
| Odoo fleet module | Software Engineer | ⏳ Pending |

---

## What Is Out of Scope for This Phase

- TLS encryption (production concern)
- Device authentication (production concern)
- Cloud deployment — AWS infrastructure via Terraform (next phase)
- L4 business logic and alert rules (Software Engineer)
- Odoo fleet dashboard (Software Engineer)

---

*Last updated: March 21, 2026 — Infrastructure ready, pipeline validated to NATS*