param(
  [string]$DbName = "odoo",
  [string]$ModuleName = "fleet_telemetry_connector"
)

$ErrorActionPreference = "Stop"

Write-Host "== Fleet Telemetry bootstrap (fresh clone) =="

Write-Host "[1/6] Starting L1-L4 stack..."
docker compose up -d emqx traccar nats timescaledb adapter l4-service simulator

Write-Host "[2/6] Starting Odoo profile..."
docker compose --profile with-odoo up -d odoo odoo-db

Write-Host "[3/6] Initializing Odoo base DB (safe to re-run)..."
docker compose run --rm odoo odoo -d $DbName -i base --without-demo=all --stop-after-init

Write-Host "[4/6] Installing/upgrading Fleet Telemetry connector..."
docker compose run --rm odoo odoo -d $DbName -u $ModuleName --stop-after-init

Write-Host "[5/6] Restarting Odoo..."
docker compose restart odoo

Write-Host "[6/6] Current service status:"
docker compose ps

Write-Host ""
Write-Host "Bootstrap complete."
Write-Host "Odoo URL: http://localhost:8069"
Write-Host "Database: odoo"
Write-Host "Login: admin / admin"
Write-Host "Fleet page: http://localhost:8069/web#action=87&model=fleet.vehicle.telemetry&view_type=list&cids=1&menu_id=70"
