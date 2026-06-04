#!/bin/bash
# Full clean rebuild of the Fleet Telemetry stack.
# Run this when you need a completely fresh start.
#
# WARNING: This destroys all Odoo DB data, sessions, and the .initialized flag.
# TimescaleDB telemetry data is also wiped (data/timescaledb).
# The NATS JetStream data is preserved unless you also remove data/nats.
#
# Usage:
#   bash rebuild.sh          # full wipe + rebuild
#   bash rebuild.sh --soft   # keep DB data, just restart containers

set -e

SOFT=false
for arg in "$@"; do
  [[ "$arg" == "--soft" ]] && SOFT=true
done

echo "=== Fleet Telemetry Stack Rebuild ==="

echo "--- Stopping all containers..."
docker compose down --remove-orphans

if [ "$SOFT" = false ]; then
  echo "--- Clearing Odoo state (DB data, sessions, init flag)..."
  rm -rf ./data/odoo-db/*
  rm -rf ./data/odoo/sessions/*
  rm -f  ./data/odoo/.initialized
  # Wipe TimescaleDB so schema init runs fresh
  rm -rf ./data/timescaledb/*
  echo "--- State cleared."
else
  echo "--- Soft restart: preserving DB data."
  echo "--- Clearing Odoo sessions only..."
  rm -rf ./data/odoo/sessions/*
fi

echo "--- Rebuilding images..."
docker compose build --no-cache

echo "--- Starting stack..."
docker compose up -d

echo ""
echo "=== Stack starting. Monitor with: docker compose logs -f ==="
echo "=== Odoo will be available at: http://localhost:8069 ==="
echo "=== Login: admin / admin ==="
echo ""
echo "Init sequence:"
echo "  1. odoo-db        → PostgreSQL ready"
echo "  2. odoo-init      → Creates DB + installs base,web,mail,fleet"
echo "  3. odoo-module-init → Installs fleet_telemetry_connector + sets web.base.url"
echo "  4. odoo           → Main server starts"
