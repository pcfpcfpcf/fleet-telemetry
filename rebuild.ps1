# Full clean rebuild of the Fleet Telemetry stack (Windows / PowerShell).
# Run from the fleet-telemetry directory.
#
# WARNING: Destroys all Odoo DB data, sessions, and the .initialized flag.
# TimescaleDB telemetry data is also wiped.
#
# Usage:
#   .\rebuild.ps1          # full wipe + rebuild
#   .\rebuild.ps1 -Soft    # keep DB data, just restart containers

param(
    [switch]$Soft
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=== Fleet Telemetry Stack Rebuild ===" -ForegroundColor Cyan

Write-Host "--- Stopping all containers..." -ForegroundColor Yellow
docker compose down --remove-orphans

if (-not $Soft) {
    Write-Host "--- Clearing Odoo state (DB data, sessions, init flag)..." -ForegroundColor Yellow

    # Odoo DB (postgres data)
    if (Test-Path ".\data\odoo-db") {
        Remove-Item -Recurse -Force ".\data\odoo-db\*" -ErrorAction SilentlyContinue
    }
    # Odoo sessions
    if (Test-Path ".\data\odoo\sessions") {
        Remove-Item -Recurse -Force ".\data\odoo\sessions\*" -ErrorAction SilentlyContinue
    }
    # Initialization flag — forces odoo-init to re-run
    if (Test-Path ".\data\odoo\.initialized") {
        Remove-Item -Force ".\data\odoo\.initialized"
    }
    # TimescaleDB — wipe so schema init runs fresh
    if (Test-Path ".\data\timescaledb") {
        Remove-Item -Recurse -Force ".\data\timescaledb\*" -ErrorAction SilentlyContinue
    }

    Write-Host "--- State cleared." -ForegroundColor Green
} else {
    Write-Host "--- Soft restart: preserving DB data." -ForegroundColor Yellow
    Write-Host "--- Clearing Odoo sessions only..." -ForegroundColor Yellow
    if (Test-Path ".\data\odoo\sessions") {
        Remove-Item -Recurse -Force ".\data\odoo\sessions\*" -ErrorAction SilentlyContinue
    }
}

Write-Host "--- Rebuilding images..." -ForegroundColor Yellow
docker compose build --no-cache

Write-Host "--- Starting stack..." -ForegroundColor Yellow
docker compose up -d

Write-Host ""
Write-Host "=== Stack starting ===" -ForegroundColor Green
Write-Host "Monitor logs:  docker compose logs -f" -ForegroundColor Cyan
Write-Host "Odoo URL:      http://localhost:8069" -ForegroundColor Cyan
Write-Host "Login:         admin / admin" -ForegroundColor Cyan
Write-Host ""
Write-Host "Init sequence:" -ForegroundColor White
Write-Host "  1. odoo-db          -> PostgreSQL ready"
Write-Host "  2. odoo-init        -> Creates DB, installs base + web + mail + fleet"
Write-Host "  3. odoo-module-init -> Installs fleet_telemetry_connector, sets web.base.url"
Write-Host "  4. odoo             -> Main Odoo server starts"
