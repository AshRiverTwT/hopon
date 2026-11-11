HopOn - local Windows test kit
==============================

1. PostgreSQL 16 (once):  winget install PostgreSQL.PostgreSQL.16 --interactive
   Remember the "postgres" password and the port.

2. Servers + benchmarks (leave this window open):
     powershell -ExecutionPolicy Bypass -File start-local.ps1 -PgPassword PASS -PgPort PORT
   Prints: 20 functional checks, text round trip p50/p95/p99, voice network
   path p50/p95/p99. Chat server: ws://127.0.0.1:18080/ws

3. App: run HopOn_0.1.0_x64-setup.exe. On the login screen open "Server",
   set ws://127.0.0.1:18080/ws, sign up. Ctrl+Shift+P = latency overlay.

4. Cold start / idle RAM / idle CPU (app closed first):
     powershell -ExecutionPolicy Bypass -File measure-windows.ps1 -Exe "PATH\TO\hopon.exe"

5. Real-device voice (one PC), in a second window:
     powershell -ExecutionPolicy Bypass -File voice-echo-test.ps1 -PgPassword PASS -PgPort PORT
   Join the listed voice channel in HopOn and talk: you hear yourself.
   Mouth-to-ear: with speakers on, record a few sharp claps with a phone.
   Each clap appears twice (live, then echoed). One-way ~= gap / 2.
   1-hour test: leave it running for an hour with you talking or music
   playing near the mic; note any dropouts or robotic sound.

6. Two PCs on a LAN: on PC B install the app and set Server to
   ws://PC_A_IP:18080/ws. In start-local.ps1 on PC A set LIVEKIT_URL to
   ws://PC_A_IP:7880 and allow the firewall prompts. Then on PC B:
     msg_rtt.exe --url ws://PC_A_IP:18080/ws --n 2000 --rate 50 --label lan

Paste the console output back into the chat.
