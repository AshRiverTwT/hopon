# Run on Windows after installing HopOn. Measures cold start, idle RAM and
# idle CPU of the whole app (hopon.exe + its WebView2 processes), and
# optionally runs the text benchmark against your server.
#
#   powershell -ExecutionPolicy Bypass -File measure-windows.ps1 `
#       [-Exe "$env:LOCALAPPDATA\HopOn\hopon.exe"] [-Runs 5] [-Url ws://server:8080/ws] [-Bench .\msg_rtt.exe]
param(
  [string]$Exe = "$env:LOCALAPPDATA\HopOn\hopon.exe",
  [int]$Runs = 5,
  [int]$IdleSeconds = 60,
  [string]$Url = "",
  [string]$Bench = ""
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Exe)) { throw "hopon.exe not found at $Exe (pass -Exe)" }

function Get-Tree([int]$RootId) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($RootId)
  do {
    $added = $false
    foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId); $added = $true } }
  } while ($added)
  $ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
}

Write-Host "== Cold start ($Runs runs; first run warms the disk cache and is dropped) =="
$startup = @()
for ($i = 0; $i -le $Runs; $i++) {
  $f = Join-Path $env:TEMP "hopon-startup.json"; Remove-Item $f -ErrorAction SilentlyContinue
  $p = Start-Process $Exe -ArgumentList "--perf-exit" -PassThru
  $p.WaitForExit(15000) | Out-Null
  if (Test-Path $f) { $j = Get-Content $f | ConvertFrom-Json; if ($i -gt 0) { $startup += $j.processToPaintMs } }
}
$sorted = $startup | Sort-Object
"process start -> first paint: median {0:N0} ms, worst {1:N0} ms (target < 1000)" -f $sorted[[int]($sorted.Count / 2)], $sorted[-1]

Write-Host "`n== Idle (logged in, window open, not in voice) for $IdleSeconds s =="
$p = Start-Process $Exe -PassThru
Start-Sleep 15
function Cpu-Ms($procs) { $t = 0.0; foreach ($x in $procs) { try { $t += $x.TotalProcessorTime.TotalMilliseconds } catch {} }; $t }
$cpu0 = Cpu-Ms (Get-Tree $p.Id)
$t0 = Get-Date
Start-Sleep $IdleSeconds
$tree = Get-Tree $p.Id
$cpu1 = Cpu-Ms $tree
$wall = ((Get-Date) - $t0).TotalMilliseconds * [Environment]::ProcessorCount
$ws = ($tree | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB
$priv = ($tree | Measure-Object -Property PrivateMemorySize64 -Sum).Sum / 1MB
"processes: {0}  ({1})" -f $tree.Count, (($tree | ForEach-Object { $_.ProcessName }) -join ", ")
"idle RAM: working set {0:N0} MB, private {1:N0} MB (target < 150)" -f $ws, $priv
"idle CPU: {0:N2} % of all cores (target < 1)" -f (100 * ($cpu1 - $cpu0) / $wall)
Stop-Process -Id $p.Id

if ($Url -and $Bench) {
  Write-Host "`n== Text round trip =="
  & $Bench --url $Url --n 2000 --rate 50 --label windows
}
