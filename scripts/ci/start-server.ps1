# CI (windows-latest): start the preinstalled Postgres and a HopOn server on
# 127.0.0.1:18080. Logs go to $env:RUNNER_TEMP\logs.
param([Parameter(Mandatory = $true)][string]$ServerExe)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $ServerExe)) { throw "server binary not found: $ServerExe" }
$ServerExe = (Resolve-Path $ServerExe).Path
$svc = Get-Service -Name "postgresql*" | Select-Object -First 1
Set-Service $svc.Name -StartupType Manual
Start-Service $svc.Name
$env:PGPASSWORD = "root"
& "$env:PGBIN\psql.exe" -h 127.0.0.1 -U postgres -c "CREATE DATABASE hopon"

$env:DATABASE_URL = "postgres://postgres:root@127.0.0.1:5432/hopon"
$env:HOPON_JWT_SECRET = "ci-secret"
$env:LIVEKIT_URL = "ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY = "devkey"
$env:LIVEKIT_API_SECRET = "secret-secret-secret-secret-secret"
$env:HOPON_SEND_RATE = "100000"
$env:HOPON_BIND = "127.0.0.1:18080"
$env:RUST_LOG = "warn"
New-Item -ItemType Directory -Force "$env:RUNNER_TEMP\logs" | Out-Null
Start-Process $ServerExe -NoNewWindow `
  -RedirectStandardError "$env:RUNNER_TEMP\logs\server.err.log" -RedirectStandardOutput "$env:RUNNER_TEMP\logs\server.out.log"
for ($i = 0; $i -lt 100; $i++) {
  try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18080/health | Out-Null; Write-Host "server up"; return } catch { Start-Sleep -Milliseconds 300 }
}
Get-Content "$env:RUNNER_TEMP\logs\server.err.log"
throw "server did not start"
