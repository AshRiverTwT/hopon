# HopOn local Windows test: runs Postgres (already installed), LiveKit and the
# HopOn server on this PC, then the smoke test and the text + voice benchmarks.
#
#   1. Install PostgreSQL 16 once:  winget install PostgreSQL.PostgreSQL.16
#      (remember the password you set for the "postgres" user)
#   2. powershell -ExecutionPolicy Bypass -File start-local.ps1 -PgPassword YOURPASS
#   3. Install HopOn_0.1.0_x64-setup.exe, log in (server ws://127.0.0.1:8080/ws),
#      then run measure-windows.ps1 for cold start / idle RAM / idle CPU.
#
# Leave this window open: Ctrl+C stops the servers.
param(
  [Parameter(Mandatory = $true)][string]$PgPassword,
  [string]$PgBin = "C:\Program Files\PostgreSQL\16\bin",
  [int]$VoiceSecs = 60,
  [switch]$NoBench
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
New-Item -ItemType Directory -Force results | Out-Null

# --- Postgres ---
$psql = Join-Path $PgBin "psql.exe"
if (-not (Test-Path $psql)) { throw "psql.exe not found in $PgBin. Install with: winget install PostgreSQL.PostgreSQL.16 (or pass -PgBin)" }
$env:PGPASSWORD = $PgPassword
$exists = & $psql -h 127.0.0.1 -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='hopon'"
if ($LASTEXITCODE -ne 0) { throw "could not connect to Postgres as 'postgres' (wrong -PgPassword, or the service is not running)" }
if ($exists -ne "1") { & $psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE hopon" | Out-Null }
Write-Host "postgres: ok"

# --- LiveKit ---
$lk = Join-Path $here "livekit-server.exe"
if (-not (Test-Path $lk)) {
  Write-Host "downloading LiveKit v1.13.11..."
  $zip = Join-Path $env:TEMP "livekit.zip"
  Invoke-WebRequest "https://github.com/livekit/livekit/releases/download/v1.13.11/livekit_1.13.11_windows_amd64.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath (Join-Path $env:TEMP "livekit") -Force
  Copy-Item (Get-ChildItem (Join-Path $env:TEMP "livekit") -Recurse -Filter livekit-server.exe | Select-Object -First 1).FullName $lk
}
$lkProc = Start-Process $lk -ArgumentList "--config", (Join-Path $here "livekit-local.yaml") -PassThru -NoNewWindow `
  -RedirectStandardError (Join-Path $here "results\livekit.log")

# --- HopOn server ---
$env:DATABASE_URL = "postgres://postgres:$([uri]::EscapeDataString($PgPassword))@127.0.0.1/hopon"
$env:HOPON_JWT_SECRET = "local-test-secret-change-for-real-use"
$env:LIVEKIT_URL = "ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY = "devkey"
$env:LIVEKIT_API_SECRET = "secret-secret-secret-secret-secret"
$env:HOPON_SEND_RATE = "100000"   # benchmarks send faster than the 10/s user limit
$env:RUST_LOG = "warn"
$srv = Start-Process (Join-Path $here "hopon-server.exe") -PassThru -NoNewWindow `
  -RedirectStandardError (Join-Path $here "results\server.log")

try {
  $ok = $false
  for ($i = 0; $i -lt 50; $i++) { try { if ((Invoke-WebRequest http://127.0.0.1:8080/health -UseBasicParsing -TimeoutSec 1).Content -eq "ok") { $ok = $true; break } } catch { Start-Sleep -Milliseconds 200 } }
  if (-not $ok) { throw "server did not start; see results\server.log" }
  for ($i = 0; $i -lt 50; $i++) { try { Invoke-WebRequest http://127.0.0.1:7880 -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 200 } }
  Write-Host "servers: ok (chat ws://127.0.0.1:8080/ws, voice ws://127.0.0.1:7880)`n"

  if (-not $NoBench) {
    & .\smoke.exe
    & .\voice_grant_check.exe
    Write-Host "`n== text round trip =="
    & .\msg_rtt.exe --n 2000 --rate 100 --label windows-local
    Write-Host "`n== voice network path through LiveKit ($VoiceSecs s) =="
    & .\voice_loopback.exe --url ws://127.0.0.1:7880 --key devkey --secret secret-secret-secret-secret-secret --secs $VoiceSecs --label windows-local
    Write-Host "`nraw results: $here\results"
  }
  Write-Host "`nServers are running. Install/open HopOn now (server ws://127.0.0.1:8080/ws)."
  Write-Host "Ctrl+Shift+P in the app shows live latency. Press Enter here to stop the servers."
  [void][Console]::ReadLine()
} finally {
  Stop-Process -Id $srv.Id -ErrorAction SilentlyContinue
  Stop-Process -Id $lkProc.Id -ErrorAction SilentlyContinue
}
