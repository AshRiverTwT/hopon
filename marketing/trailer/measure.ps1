# HopOn vs Discord: launch time and memory, measured the same way for both,
# on this PC. Output: hopon-vs-discord.json on your Desktop (the trailer's
# comparison scene reads it).
#
#   powershell -ExecutionPolicy Bypass -File measure.ps1            # 3 runs each
#   powershell -ExecutionPolicy Bypass -File measure.ps1 -Runs 5
#
# Both apps must be installed and signed in. The script CLOSES both apps
# between runs (leave any voice call first).
#
# Launch = from starting the app until its main window shows rendered content
#          that stays still for half a second (judged from the window's pixels,
#          so splash screens and blank windows don't count). Median of the runs.
# Memory = private working set of the whole app (HopOn + its WebView2
#          processes; every Discord process), 20 s after launch, at rest.

param([int]$Runs = 3, [int]$SettleSeconds = 20)
$ErrorActionPreference = "Stop"

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // Largest visible top-level window owned by any of these processes.
  public static IntPtr Biggest(HashSet<uint> pids, out RECT best) {
    IntPtr found = IntPtr.Zero; RECT b = new RECT(); long area = 0;
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > area) { area = a; found = h; b = r; }
      return true;
    }, IntPtr.Zero);
    best = b; return found;
  }
  // 64x40 grey thumbnail of a screen rectangle.
  public static byte[] Thumb(RECT r) {
    int w = Math.Max(1, r.R - r.L), h = Math.Max(1, r.B - r.T);
    using (var full = new Bitmap(w, h))
    using (var g = Graphics.FromImage(full)) {
      g.CopyFromScreen(r.L, r.T, 0, 0, new Size(w, h));
      using (var small = new Bitmap(full, new Size(64, 40))) {
        var px = new byte[64 * 40];
        for (int y = 0; y < 40; y++) for (int x = 0; x < 64; x++) {
          var c = small.GetPixel(x, y); px[y * 64 + x] = (byte)((c.R * 3 + c.G * 6 + c.B) / 10);
        }
        return px;
      }
    }
  }
  // How varied the picture is (a blank window is ~0) and how much it changed.
  public static double Spread(byte[] a) {
    double m = 0; foreach (var v in a) m += v; m /= a.Length;
    double s = 0; foreach (var v in a) s += (v - m) * (v - m); return Math.Sqrt(s / a.Length);
  }
  public static double Diff(byte[] a, byte[] b) {
    double d = 0; for (int i = 0; i < a.Length; i++) d += Math.Abs(a[i] - b[i]); return d / a.Length;
  }
}
"@

function Tree([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'; [void]$set.Add([uint32]$root)
  do { $added = $false
    foreach ($p in $all) { if ($set.Contains([uint32]$p.ParentProcessId) -and $set.Add([uint32]$p.ProcessId)) { $added = $true } }
  } while ($added)
  return ,$set
}
function Pids($app) {
  if ($app.Name -eq "Discord") {
    $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
    Get-Process -Name Discord -ErrorAction SilentlyContinue | ForEach-Object { [void]$set.Add([uint32]$_.Id) }
    return ,$set
  }
  $p = Get-Process -Name $app.Proc -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { return ,(New-Object 'System.Collections.Generic.HashSet[uint32]') }
  return ,(Tree $p.Id)
}
function MemoryMB($pids) {
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $pids.Contains([uint32]$_.IDProcess) }
  return [math]::Round((($perf | Measure-Object WorkingSetPrivate -Sum).Sum) / 1MB, 1)
}
function CloseAll {
  foreach ($n in @("Discord", $hop.Proc)) { Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 4
}

function Launch($app) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  if ($app.Args.Count) { Start-Process -FilePath $app.Exe -ArgumentList $app.Args | Out-Null } else { Start-Process -FilePath $app.Exe | Out-Null }
  $prev = $null; $stableSince = $null
  while ($sw.Elapsed.TotalSeconds -lt 60) {
    Start-Sleep -Milliseconds 40
    $pids = Pids $app
    if ($pids.Count -eq 0) { continue }
    $r = New-Object 'Win+RECT'
    $h = [Win]::Biggest($pids, [ref]$r)
    if ($h -eq [IntPtr]::Zero -or ($r.R - $r.L) -lt 700 -or ($r.B - $r.T) -lt 450) { $prev = $null; $stableSince = $null; continue }
    [void][Win]::SetForegroundWindow($h)
    $px = [Win]::Thumb($r)
    $t = $sw.Elapsed.TotalSeconds
    # Rendered (not a blank window) and unchanged for 0.5 s.
    if ([Win]::Spread($px) -gt 12 -and $null -ne $prev -and [Win]::Diff($px, $prev) -lt 1.5) {
      if ($null -eq $stableSince) { $stableSince = $t }
      if ($t - $stableSince -ge 0.5) { return [math]::Round($stableSince, 2) }
    } else { $stableSince = $null }
    $prev = $px
  }
  throw "$($app.Name) didn't finish launching within 60 s"
}

$hopDir = Join-Path $env:LOCALAPPDATA "HopOn"
$hopExe = Get-ChildItem $hopDir -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
if (-not $hopExe) { throw "HopOn isn't installed in $hopDir" }
$disc = Join-Path $env:LOCALAPPDATA "Discord\Update.exe"
if (-not (Test-Path $disc)) { throw "Discord isn't installed (no $disc)" }
$hop = @{ Name = "HopOn"; Exe = $hopExe.FullName; Args = @(); Proc = $hopExe.BaseName }
$dis = @{ Name = "Discord"; Exe = $disc; Args = @("--processStart", "Discord.exe"); Proc = "Discord" }

Write-Host "This closes HopOn and Discord between runs ($Runs runs each). Leave any voice call first." -ForegroundColor Yellow
if ((Read-Host "Continue? (y/n)") -ne "y") { exit }

$results = @{ HopOn = @{ launch = @(); memory = @() }; Discord = @{ launch = @(); memory = @() } }
CloseAll
for ($i = 1; $i -le $Runs; $i++) {
  foreach ($app in @($hop, $dis)) {
    Write-Host ("Run {0}/{1}: {2}..." -f $i, $Runs, $app.Name) -NoNewline
    $l = Launch $app
    Start-Sleep -Seconds $SettleSeconds
    $m = MemoryMB (Pids $app)
    Write-Host (" launch {0} s, memory {1} MB" -f $l, $m)
    $results[$app.Name].launch += $l; $results[$app.Name].memory += $m
    CloseAll
  }
}
function Median($a) { $s = $a | Sort-Object; return $s[[int][math]::Floor(($s.Count - 1) / 2)] }
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name.Trim()
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$out = [ordered]@{
  hopon   = [ordered]@{ launch_s = (Median $results.HopOn.launch); memory_mb = (Median $results.HopOn.memory); runs = $results.HopOn }
  discord = [ordered]@{ launch_s = (Median $results.Discord.launch); memory_mb = (Median $results.Discord.memory); runs = $results.Discord }
  machine = "$cpu, $ram GB RAM, $([Environment]::OSVersion.VersionString)"
  date    = (Get-Date -Format s)
  method  = "launch: start until the main window shows rendered content stable for 0.5 s (pixel check); memory: private working set of the full process tree after $SettleSeconds s; median of $Runs runs"
}
$path = Join-Path ([Environment]::GetFolderPath("Desktop")) "hopon-vs-discord.json"
$out | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $path
Write-Host ""
Write-Host ("HopOn   launch {0} s, memory {1} MB" -f $out.hopon.launch_s, $out.hopon.memory_mb) -ForegroundColor Green
Write-Host ("Discord launch {0} s, memory {1} MB" -f $out.discord.launch_s, $out.discord.memory_mb)
Write-Host "Saved: $path  (send this file back)"
