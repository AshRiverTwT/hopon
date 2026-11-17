# CI (windows-latest): build the native app's installer from the published
# folder, then install it silently, start the installed app (--perf-exit:
# it exits after the first frame), uninstall, and check nothing is left.
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$version = ([xml](Get-Content "$PSScriptRoot\..\..\client\native\HopOn.App\HopOn.App.csproj")).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
$setup = Join-Path $OutDir "HopOn-native-$version-setup.exe"

$makensis = "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
if (-not (Test-Path $makensis)) {
  choco install nsis -y --no-progress | Out-Null
}
if (-not (Test-Path $makensis)) { throw "makensis not found" }
# A clean PC may lack the Visual C++ runtime (the runner has it): report any
# shipped binary that needs a VC++ runtime DLL the folder doesn't carry.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -property installationPath
$dumpbin = Get-ChildItem "$vs\VC\Tools\MSVC" -Recurse -Filter dumpbin.exe | Where-Object { $_.FullName -match "Hostx64\\x64" } | Select-Object -First 1
if ($dumpbin) {
  $shipped = (Get-ChildItem $AppDir -Recurse -File).Name | ForEach-Object { $_.ToLowerInvariant() }
  $missing = @{}
  foreach ($pe in Get-ChildItem $AppDir -Recurse -File -Include *.exe, *.dll) {
    $deps = & $dumpbin.FullName /nologo /dependents $pe.FullName | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ -match "^(vcruntime|msvcp|concrt|vccorlib)\S*\.dll$" }
    foreach ($d in $deps) { if ($shipped -notcontains $d) { $missing[$d] = @($missing[$d]) + $pe.Name } }
  }
  if ($missing.Count -eq 0) { Write-Host "VC++ runtime: no shipped binary needs one that isn't included" }
  else {
    foreach ($k in $missing.Keys) { Write-Host "VC++ runtime NOT shipped: $k needed by $(($missing[$k] | Where-Object { $_ }) -join ', ')" }
    if ($env:GITHUB_STEP_SUMMARY) { "| VC++ runtime | **needed, not shipped**: $($missing.Keys -join ', ') |" | Add-Content $env:GITHUB_STEP_SUMMARY }
  }
} else { Write-Host "dumpbin not found: VC++ runtime check skipped" }

# Symbols never ship.
Get-ChildItem $AppDir -Recurse -Filter *.pdb | Remove-Item
& $makensis -V2 "/DSRCDIR=$AppDir" "/DOUTFILE=$setup" "/DVERSION=$version" "$PSScriptRoot\..\..\client\native\installer\HopOn.nsi"
if ($LASTEXITCODE -ne 0) { throw "makensis failed ($LASTEXITCODE)" }
$size = (Get-Item $setup).Length
Write-Host ("installer: {0} ({1:N1} MB)" -f $setup, ($size / 1MB))

# --- install, run, uninstall ---
$dir = Join-Path $env:RUNNER_TEMP "install-test"
$p = Start-Process $setup -ArgumentList "/S", "/D=$dir" -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "silent install failed ($($p.ExitCode))" }
foreach ($f in "HopOn.exe", "hopon_ffi.dll", "Uninstall.exe") {
  if (-not (Test-Path (Join-Path $dir $f))) { throw "installed folder lacks $f" }
}
$lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "HopOn (native preview).lnk"
if (-not (Test-Path $lnk)) { throw "no Start-menu shortcut" }
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HopOnNative"
$reg = Get-ItemProperty $key
Write-Host "registered: $($reg.DisplayName) $($reg.DisplayVersion), $($reg.EstimatedSize) KB"

$startup = Join-Path $env:TEMP "hopon-startup.json"
Remove-Item $startup -ErrorAction SilentlyContinue
$app = Start-Process (Join-Path $dir "HopOn.exe") -ArgumentList "--perf-exit" -PassThru
if (-not $app.WaitForExit(30000)) { $app.Kill(); throw "installed app did not start and exit" }
if (-not (Test-Path $startup)) { throw "installed app wrote no startup timing" }
$s = Get-Content $startup | ConvertFrom-Json
Write-Host "installed app: first frame $($s.processToPaintMs) ms after process start"

$u = Start-Process (Join-Path $dir "Uninstall.exe") -ArgumentList "/S" -PassThru -Wait
# The uninstaller re-launches itself from %TEMP%; wait for the folder to go.
for ($i = 0; $i -lt 60 -and (Test-Path (Join-Path $dir "HopOn.exe")); $i++) { Start-Sleep -Milliseconds 500 }
if (Test-Path (Join-Path $dir "HopOn.exe")) { throw "uninstall left files behind" }
if (Test-Path $lnk) { throw "uninstall left the shortcut" }
if (Test-Path $key) { throw "uninstall left the registry entry" }
Write-Host "install / start / uninstall: ok"

$line = "| installer (NSIS, LZMA solid) | **$([math]::Round($size / 1MB, 1)) MB**; silent install, start, uninstall checked |"
if ($env:GITHUB_STEP_SUMMARY) { $line | Add-Content $env:GITHUB_STEP_SUMMARY }
