param(
    [int]$HealthTimeoutSec = 180,
    [int]$SimulatorWarmupSec = 35
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$CoreServices = @("emqx", "nats", "timescaledb", "adapter")
$RequiredPaths = @(
    ".\docker-compose.yml",
    ".\config\emqx\emqx.conf",
    ".\config\nats\nats.conf",
    ".\init\timescaledb\01_schema.sql",
    ".\adapter\Dockerfile",
    ".\simulator\Dockerfile"
)

function Write-Step($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Assert-CommandExists([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Required command '$name' is not installed or not in PATH."
    }
}

function Assert-DockerCompose {
    docker compose version | Out-Null
}

function Assert-DockerDaemon {
    docker info | Out-Null
}

function Assert-RequiredFiles {
    foreach ($path in $RequiredPaths) {
        if (-not (Test-Path $path)) {
            throw "Required file/folder missing: $path"
        }
    }
}

function Show-Diagnostics {
    Write-Host "`n--- Diagnostics ---" -ForegroundColor Yellow
    try { docker compose ps | Out-Host } catch {}
    foreach ($svc in $CoreServices) {
        try {
            Write-Host "`n[$svc logs]" -ForegroundColor Yellow
            docker compose logs --tail 60 $svc | Out-Host
        } catch {}
    }
}

function Wait-Healthy($services, $timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $allHealthy = $true
        foreach ($svc in $services) {
            $id = docker compose ps -q $svc
            if (-not $id) {
                $allHealthy = $false
                break
            }
            $health = docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $id
            if ($health -ne "healthy") {
                $allHealthy = $false
                break
            }
        }
        if ($allHealthy) {
            return $true
        }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Assert-AdapterEvidence {
    $logs = docker logs fleet-adapter --tail 500 2>&1 | Out-String
    $required = @(
        "FMC003_SIM_001",
        "FMC003_SIM_002",
        "FMC003_SIM_003",
        "FMC003_SIM_004",
        "FMC003_SIM_005"
    )

    foreach ($device in $required) {
        if ($logs -notmatch [Regex]::Escape($device)) {
            throw "Missing adapter evidence for $device in recent logs."
        }
    }

    if ($logs -notmatch "NATS") {
        throw "Adapter logs do not show forwarding to NATS."
    }
}

try {
    Write-Step "Preflight: checking required commands"
    Assert-CommandExists "docker"

    Write-Step "Preflight: checking Docker Compose availability"
    Assert-DockerCompose

    Write-Step "Preflight: checking Docker daemon"
    Assert-DockerDaemon

    Write-Step "Preflight: checking required project files"
    Assert-RequiredFiles

    Write-Step "Starting core services"
    docker compose up -d emqx nats timescaledb adapter | Out-Host

    Write-Step "Waiting for healthy core services (emqx, nats, timescaledb, adapter)"
    $ok = Wait-Healthy -services $CoreServices -timeoutSec $HealthTimeoutSec
    if (-not $ok) {
        Write-Host "Core services did not become healthy in time." -ForegroundColor Red
        throw "Health timeout"
    }

    Write-Step "Starting simulator profile"
    docker compose --profile simulate up -d simulator | Out-Host

    Write-Step "Warming up simulator traffic for $SimulatorWarmupSec seconds"
    Start-Sleep -Seconds $SimulatorWarmupSec

    Write-Step "Validating adapter forwarding evidence in logs"
    Assert-AdapterEvidence

    Write-Step "Demo pipeline validation succeeded"
    Write-Host "Services healthy and mock telemetry forwarded to NATS for all 5 simulated devices." -ForegroundColor Green
    Write-Host "`nUseful follow-up commands:" -ForegroundColor Yellow
    Write-Host "  docker compose ps"
    Write-Host "  docker logs fleet-adapter --tail 100"
    Write-Host "  docker compose down"
}
catch {
    Write-Host "`nPipeline failed: $($_.Exception.Message)" -ForegroundColor Red
    Show-Diagnostics
    exit 1
}
