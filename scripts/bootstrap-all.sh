#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${1:-odoo}"
MODULE_NAME="${2:-fleet_telemetry_connector}"

echo "== Fleet Telemetry bootstrap (fresh clone, Linux) =="

echo "[1/6] Starting L1-L4 stack..."
docker compose up -d emqx traccar nats timescaledb adapter l4-service simulator

echo "[2/6] Starting Odoo profile..."
docker compose --profile with-odoo up -d odoo odoo-db

echo "[3/6] Initializing Odoo base DB (safe to re-run)..."
docker compose run --rm odoo odoo -d "$DB_NAME" -i base --without-demo=all --stop-after-init

echo "[4/6] Installing/upgrading Fleet Telemetry connector..."
docker compose run --rm odoo odoo -d "$DB_NAME" -u "$MODULE_NAME" --stop-after-init

echo "[5/6] Restarting Odoo..."
docker compose restart odoo

echo "[6/6] Current service status:"
docker compose ps

echo ""
echo "Bootstrap complete."
echo "Odoo URL: http://localhost:8069"
echo "Database: odoo"
echo "Login: admin / admin"
echo "Fleet page: http://localhost:8069/web#action=87&model=fleet.vehicle.telemetry&view_type=list&cids=1&menu_id=70"
