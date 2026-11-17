# CI: download LiveKit (same version as scripts/windows-kit) and start it in
# dev mode on 127.0.0.1:7880 (keys devkey / secret). Log: $env:RUNNER_TEMP\logs\livekit.log
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:RUNNER_TEMP "livekit"
$lk = Join-Path $dir "livekit-server.exe"
if (-not (Test-Path $lk)) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  $zip = Join-Path $env:RUNNER_TEMP "livekit.zip"
  Invoke-WebRequest "https://github.com/livekit/livekit/releases/download/v1.13.11/livekit_1.13.11_windows_amd64.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $dir -Force
  $found = Get-ChildItem $dir -Recurse -Filter livekit-server.exe | Select-Object -First 1
  if ($found.FullName -ne $lk) { Copy-Item $found.FullName $lk }
}
New-Item -ItemType Directory -Force "$env:RUNNER_TEMP\logs" | Out-Null
Start-Process $lk -ArgumentList "--dev", "--bind", "127.0.0.1" -NoNewWindow `
  -RedirectStandardError "$env:RUNNER_TEMP\logs\livekit.log" -RedirectStandardOutput "$env:RUNNER_TEMP\logs\livekit.out.log"
for ($i = 0; $i -lt 50; $i++) {
  try { $c = [Net.Sockets.TcpClient]::new("127.0.0.1", 7880); $c.Close(); Write-Host "livekit up"; return } catch { Start-Sleep -Milliseconds 300 }
}
Get-Content "$env:RUNNER_TEMP\logs\livekit.log" -ErrorAction SilentlyContinue
throw "livekit did not start"
