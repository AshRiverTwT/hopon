# CI (windows-latest): run the native app (published folder) against the local
# server and measure it. Writes results to $Out (summary.md, JSON, screenshot).
#   1. startup: 5 runs with --perf-exit (process start -> first frame)
#   2. e2e: e2e_feed sends 200 messages from another user; the app reports
#      remote input -> painted (same instrumentation as the Tauri build)
#   3. idle: working set / private bytes and CPU over 30 s after the feed
#   4. a screenshot of the window
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$E2eFeed,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $Out | Out-Null
$exe = Join-Path $AppDir "HopOn.exe"
$env:HOPON_URL = "ws://127.0.0.1:18080/ws"
$summary = @("# Native app on windows-latest", "", "| item | result |", "|---|---|")

# --- startup ---
$starts = @()
for ($i = 0; $i -lt 5; $i++) {
  $f = Join-Path $env:TEMP "hopon-startup.json"
  Remove-Item $f -ErrorAction SilentlyContinue
  $p = Start-Process $exe -ArgumentList "--perf-exit" -PassThru
  if (-not $p.WaitForExit(30000)) { $p.Kill(); throw "--perf-exit run did not exit" }
  if (Test-Path $f) {
    $s = Get-Content $f | ConvertFrom-Json
    $starts += $s
    Write-Host ("startup run {0}: process->paint {1} ms, main->paint {2} ms, main->connected {3}" -f $i, $s.processToPaintMs, $s.mainToPaintMs, $s.mainToConnectedMs)
  } else { Write-Host "startup run $i wrote no result (exit $($p.ExitCode))" }
}
$starts | ConvertTo-Json | Set-Content (Join-Path $Out "startup.json")
if ($starts.Count -gt 0) {
  $vals = $starts | ForEach-Object { $_.processToPaintMs } | Sort-Object
  $summary += "| process start -> first frame (5 runs) | median **$($vals[[int]($vals.Count / 2)]) ms**, worst $($vals[-1]) ms |"
}

# --- e2e feed ---
$creds = Join-Path $Out "creds.txt"
$dump = Join-Path $Out "dump.json"
$feed = Start-Process $E2eFeed -ArgumentList "--url", $env:HOPON_URL, "--creds", $creds, "--n", "200", "--rate", "20", "--wait-file", $dump `
  -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $Out "feed.log")
for ($i = 0; $i -lt 100 -and -not (Test-Path $creds); $i++) { Start-Sleep -Milliseconds 200 }
$env:HOPON_PERF_LOGIN = (Get-Content $creds -Raw).Trim()
$env:HOPON_PERF_DUMP = $dump
$app = Start-Process $exe -PassThru
if (-not $feed.WaitForExit(120000)) { $feed.Kill(); Write-Host "feed timed out" }
Start-Sleep -Seconds 4   # last dump (every 2 s)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save((Join-Path $Out "screenshot.png"))
if (Test-Path $dump) {
  $d = Get-Content $dump | ConvertFrom-Json
  foreach ($r in $d.rows) {
    $summary += "| $($r.name) ($($r.count)) | p50 $([math]::Round($r.p50_ms, 1)) ms, p95 **$([math]::Round($r.p95_ms, 1)) ms**, p99 $([math]::Round($r.p99_ms, 1)) ms |"
  }
} else { $summary += "| e2e | no dump written |" }

# --- idle ---
$app.Refresh()
$cpu0 = $app.TotalProcessorTime
Start-Sleep -Seconds 30
$app.Refresh()
$cpu = ($app.TotalProcessorTime - $cpu0).TotalSeconds / 30 / [Environment]::ProcessorCount * 100
$summary += "| idle CPU, 30 s | $([math]::Round($cpu, 3)) % of all cores |"
$summary += "| idle RAM | private $([math]::Round($app.PrivateMemorySize64 / 1MB, 1)) MB, working set $([math]::Round($app.WorkingSet64 / 1MB, 1)) MB |"
$app.Kill()

# --- size (without hopon_ffi.dll: CI uses a debug core; the release DLL is measured separately) ---
$files = Get-ChildItem $AppDir -Recurse -File | Where-Object { $_.Name -ne "hopon_ffi.dll" }
$size = ($files | Measure-Object Length -Sum).Sum
$summary += "| published app without the core DLL | $([math]::Round($size / 1MB, 1)) MB uncompressed |"
$stage = Join-Path $env:RUNNER_TEMP "size-stage"
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item "$AppDir\*" $stage -Recurse -Force
Remove-Item (Join-Path $stage "hopon_ffi.dll") -ErrorAction SilentlyContinue
$zip = Join-Path $env:RUNNER_TEMP "app.7z"
& 7z a -t7z -m0=lzma2 -mx=9 $zip "$stage\*" | Out-Null
$summary += "| same, LZMA2 (installer-like) | **$([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB** |"
$summary += ""
$summary += "Largest files:"
$summary += ""
$files | Sort-Object Length -Descending | Select-Object -First 12 | ForEach-Object {
  $summary += "- $($_.Name): $([math]::Round($_.Length / 1MB, 2)) MB"
}
$summary | Set-Content (Join-Path $Out "summary.md")
$summary | Out-String | Write-Host
if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content $env:GITHUB_STEP_SUMMARY }
