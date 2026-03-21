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
| Terraform Validation | .github/workflows/terraform-validate.yml | Push/Pull Request on infra/terraform, Manual | Runs terraform fmt -check, terraform init --backend=false, terraform validate, and dry-run terraform plan |

Validation policy:

- smoke-demo validates runtime integration of EMQX, NATS, Adapter, TimescaleDB, and Simulator
- terraform-validate blocks malformed or syntactically invalid IaC before merge


## Run It manually :

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
