Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Stopping stack..." -ForegroundColor Cyan
docker compose down | Out-Host

Write-Host "Clearing TimescaleDB data..." -ForegroundColor Cyan
if (Test-Path ".\data\timescaledb") {
    Remove-Item -Recurse -Force ".\data\timescaledb\*" -ErrorAction SilentlyContinue
}

Write-Host "Restarting core services..." -ForegroundColor Cyan
docker compose up -d --build emqx nats timescaledb adapter | Out-Host

Write-Host "Reset complete." -ForegroundColor Green
