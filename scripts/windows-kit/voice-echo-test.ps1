# Real-device voice test on one PC: an echo bot joins your voice channel and
# plays your microphone back to you through the full app path
# (mic -> WASAPI -> AEC/NS -> Opus -> LiveKit -> bot -> LiveKit -> jitter buffer -> speaker).
#
# Keep start-local.ps1 running in another window, then:
#   powershell -ExecutionPolicy Bypass -File voice-echo-test.ps1 -PgPassword YOURPASS [-PgPort 5432]
#
# Measure round trip: put a phone between mic and speakers and record a few
# sharp claps. Each clap appears twice in the recording (live, then echoed);
# the gap is the full round trip. One-way mouth-to-ear ~= gap / 2.
param(
  [Parameter(Mandatory = $true)][string]$PgPassword,
  [string]$PgBin = "C:\Program Files\PostgreSQL\16\bin",
  [int]$PgPort = 5432,
  [int]$Pick = 0
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
$psql = Join-Path $PgBin "psql.exe"
if (-not (Test-Path $psql)) { throw "psql.exe not found in $PgBin (pass -PgBin)" }
$env:PGPASSWORD = $PgPassword
$rows = & $psql -h 127.0.0.1 -p $PgPort -U postgres -d hopon -tA -F "|" -c "SELECT c.id, s.name, c.name FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.kind = 1 ORDER BY c.id DESC LIMIT 20"
if ($LASTEXITCODE -ne 0 -or -not $rows) { throw "no voice channels found. Sign up in the app first (it has a server with a 'Voice' channel), or create a server." }
$rows = @($rows)
for ($i = 0; $i -lt $rows.Count; $i++) { $f = $rows[$i].Split("|"); "[{0}] {1} / {2}" -f $i, $f[1], $f[2] }
$f = $rows[$Pick].Split("|")
Write-Host "`nEcho bot joining '$($f[1]) / $($f[2])'. Join that voice channel in HopOn and talk: you will hear yourself."
Write-Host "Use speakers (not headphones) for the clap test. Ctrl+C to stop.`n"
& .\voice_loopback.exe --mode echo --from any --room "ch_$($f[0])" --url ws://127.0.0.1:7880 --key devkey --secret secret-secret-secret-secret-secret
