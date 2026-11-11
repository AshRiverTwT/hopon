HopOn - local Windows test kit
==============================

1. Install PostgreSQL 16 (once). In PowerShell:
     winget install PostgreSQL.PostgreSQL.16
   Note the password you choose for the "postgres" user.

2. Start everything and run the benchmarks:
     powershell -ExecutionPolicy Bypass -File start-local.ps1 -PgPassword YOURPASS
   This downloads LiveKit (Windows build) on first run, starts it and the
   HopOn server, then prints:
     - smoke test (20 functional checks)
     - text round trip p50/p95/p99
     - voice network path p50/p95/p99 (codec + SFU + jitter buffer)
   Allow the firewall prompts (local network only).

3. Install the app: HopOn_0.1.0_x64-setup.exe (per-user, no admin).
   Sign up. Server URL is ws://127.0.0.1:8080/ws (the default).
   Ctrl+Shift+P shows the live latency overlay.

4. With the app installed and logged in once, in a second PowerShell:
     powershell -ExecutionPolicy Bypass -File measure-windows.ps1
   Reports cold start, idle RAM and idle CPU (app + WebView2 processes).

5. Voice with real devices: join the "Voice" channel. For a second person,
   run the app on another PC on the same LAN with server URL
   ws://THIS_PC_IP:8080/ws (and set LIVEKIT_URL in start-local.ps1 to
   ws://THIS_PC_IP:7880 so the other PC can reach the SFU).

Send back the console output and the results\ folder.
