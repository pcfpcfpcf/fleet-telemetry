$ErrorActionPreference = "Stop"

Write-Host "== Fleet Telemetry bootstrap (fresh clone) =="

$requiredCertFiles = @(
	"certs/ca.crt",
	"certs/server.crt",
	"certs/server.key",
	"certs/simulator-client.crt",
	"certs/simulator-client.key"
)

$missingCerts = $requiredCertFiles | Where-Object { -not (Test-Path $_) }
if ($missingCerts.Count -gt 0) {
	if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
		throw "OpenSSL not found in PATH. Install OpenSSL or provide cert files under ./certs. Missing: $($missingCerts -join ', ')"
	}

	Write-Host "[preflight] Missing TLS certs detected. Generating local dev certs..."
	New-Item -ItemType Directory -Force -Path "certs" | Out-Null

	& openssl genrsa -out certs/ca.key 4096
	& openssl req -new -x509 -days 3650 -key certs/ca.key -out certs/ca.crt -subj "/C=TN/ST=Tunis/L=Tunis/O=FleetPlatform/CN=FleetCA"

	& openssl genrsa -out certs/server.key 2048
	& openssl req -new -key certs/server.key -out certs/server.csr -subj "/C=TN/ST=Tunis/L=Tunis/O=FleetPlatform/CN=emqx"
	& openssl x509 -req -days 825 -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial -out certs/server.crt

	& openssl genrsa -out certs/simulator-client.key 2048
	& openssl req -new -key certs/simulator-client.key -out certs/simulator-client.csr -subj "/C=TN/ST=Tunis/L=Tunis/O=FleetPlatform/CN=simulator"
	& openssl x509 -req -days 825 -in certs/simulator-client.csr -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial -out certs/simulator-client.crt

	Write-Host "[preflight] Cert generation complete."
}

Write-Host "[1/3] Starting the full stack defined in docker-compose.yml..."
docker compose up -d

Write-Host "[2/3] Current service status:"
docker compose ps

Write-Host "[3/3] Fresh-clone entrypoints:"
Write-Host "- Odoo URL: http://localhost:8069"
Write-Host "- Database: odoo"
Write-Host "- Login: admin / admin"
Write-Host "- Fleet page: http://localhost:8069/web#action=87&model=fleet.vehicle.telemetry&view_type=list&cids=1&menu_id=70"

Write-Host ""
Write-Host "Bootstrap complete."
