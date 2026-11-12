# HopOn

Low-latency Windows chat app: real-time text channels and voice channels.
Rust everywhere: Tauri 2 client (Rust core, thin SolidJS UI), Axum/Tokio
server, PostgreSQL, LiveKit SFU for voice. Latency is the primary design
constraint, and every stage is instrumented.

**Download:** [HopOn-setup.exe](https://github.com/AshRiverTwT/hopon/raw/downloads/HopOn-setup.exe)
(latest version, ~10 MB, Windows 10/11). It connects to the public server
(`wss://hopon-chat.duckdns.org/ws`) out of the box. What's new:
[RELEASE_NOTES.md](RELEASE_NOTES.md).

```
client/      Tauri 2 app: src-tauri/ (Rust core: net, cache, voice, PTT) + ui/ (SolidJS; `pnpm dev` → /preview.html for a mocked design preview)
server/      Axum + Tokio + SQLx chat server
shared/      wire protocol (MessagePack), snowflake IDs, clock sync, HDR histograms
bench/       msg_rtt, voice_loopback, e2e_feed, smoke, voice_grant_check
infra/       docker compose: Postgres, server, LiveKit, coturn
scripts/     Windows cross-build, size report, Windows measurement (PowerShell)
results/     raw benchmark output (JSON lines)
```

## Features

**Chat**
- Servers with text channels (with topics) and voice rooms; invite links.
- Messages: send, edit and delete your own; replies with jump-to-message;
  emoji reactions; @mentions with autocomplete; typing indicator.
- Emoji picker at the end of the message bar; reactions use the same picker.
- Files, images and videos: attach with **+**, paste, or drop anywhere on the
  window (up to 10 per message, 25 MB each by default). Images and GIFs show
  inline, videos play inline, other files download.
- GIFs: the **GIF** button searches KLIPY (trending first); GIFs play as
  silent loops only while on screen.
- New members get a random welcome message in general.
- Formatting: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, code
  blocks, and clickable http(s) links.
- Unread markers that survive restarts, a "new messages" divider, day
  separators and "jump to latest".
- Online/offline presence. The app remembers your last server and channel.
- Mentions flash the taskbar when the window is in the background.

**Voice**
- Join and leave, mute and deafen, device selection, push-to-talk.
- Echo cancellation, noise suppression and gain control, each toggleable.
- Join/leave chimes and speaking indicators.

**Your account**
- Profile pictures.
- Preferences are stored on the server and follow you to any PC: sounds,
  push-to-talk, voice processing, recent emoji, last server and channel.
  Audio devices stay per-PC.

**Server settings (owner)**
- Rename the server and channels; set channel topics.
- Delete channels or the whole server, with a type-the-name confirmation.
- Remove members, revoke all invites, and delete anyone's message.
- Members leave a server from the People panel.

**Extras**
- A games panel (Wordle, Minute Cryptic, Krillion) that posts your result to
  general, as often as you like. It closes itself if the window gets too
  narrow for games and chat side by side.
- **In-game overlay** (default **Alt+`**): a small chat for the channel you
  have open, plus who's in your voice room (glowing while they talk), over
  your game. Press it again or Esc to go back to the game. Works over
  windowed and borderless games; exclusive-fullscreen games and games run as
  administrator can't be drawn over.
- **Hotkeys** (Settings → Hotkeys, all rebindable): next/previous channel
  (Alt+↓/↑), next/previous unread (Alt+Shift+↓/↑), next/previous server
  (Ctrl+Alt+↓/↑), mute (Ctrl+Shift+M), deafen (Ctrl+Shift+D), games
  (Ctrl+G), message box (Ctrl+T), zoom (Ctrl + / − / 0), overlay.
- **Scale** (Settings → Display): 80–150 %.

**Not in this version:** per-user voice volume, message search.

**Protocol versions:** client and server must match. A mismatched app shows
"Update needed" (the server answers HTTP 426), so update both from the same
kit.

## Results

Three kinds of numbers below. Only the first kind is a real measurement of
this code; please run the Windows steps in
[Measuring on Windows](#measuring-on-windows) for the rest.

### Measured on Windows (user's PC, local kit)

| item | result | target |
|---|---|---|
| process start → first paint (5 runs) | **657 ms** median, 677 ms worst | < 1 s |
| idle CPU, app + 6 WebView2 processes, 60 s | **0.13 %** of all cores | < 1 % |
| idle RAM, app + WebView2, private | **190 MB** (working set 366 MB, counts shared pages per process) | < 200 MB (revised from 150) |
| functional smoke test against the Windows server (earlier build) | 20 / 20 pass | — |
| server-issued voice grants accepted by LiveKit (Windows build) | ok | — |

### Measured (Linux cloud container, 4 vCPU, server + clients on one host)

**Text, protocol level** (`msg_rtt`, loopback network, 100 msg/s):

| stage | p50 | p95 | p99 |
|---|---|---|---|
| WebSocket ping RTT | 0.07 ms | 0.09 ms | 0.13 ms |
| author send → receiver decoded | 0.30 ms | 0.43 ms | 0.50 ms |
| author send → durable ack (Postgres commit) | 1.29 ms | 1.70 ms | 2.25 ms |
| server recv → fan-out | 0.008 ms | 0.011 ms | 0.024 ms |
| send → receiver, **200 receivers**, 200 msg/s (600k deliveries) | 0.96 ms | 1.44 ms | 1.75 ms |

**Text, real client paint** (`e2e_feed` driving the actual app, Rust core +
WebKitGTK under Xvfb with *software* rendering, 600 messages at 20/s):

| stage | p50 | p95 | p99 |
|---|---|---|---|
| remote sender input → painted in app (clock-synced) | 21.3 ms | 28.7 ms | 33.1 ms |
| core event emitted → painted | 21.0 ms | 28.2 ms | 32.7 ms |

Target: < 100 ms LAN p95. Almost all of the 28 ms is waiting for the next
frame plus CPU rasterization; WebView2 with a GPU should be lower.

**Voice, network path** (`voice_loopback`, two participants through a local
LiveKit v1.13.11, 20 ms Opus, RED on, no packet loss):

| run | p50 | p95 | p99 | clicks missed |
|---|---|---|---|---|
| 1 hour continuous | 85.5 ms | 85.7 ms | 90.5 ms | **0 / 7200** |
| 7 separate runs, 30–60 s each | 67.5–85.2 ms | 67.6–87.7 ms | 77–88 ms | 0 |

This covers encode → RTP/UDP → SFU → jitter buffer → decode.
- Within a session the latency is flat (p50 ≈ p95). Between sessions it
  settles 68–86 ms, depending on how libwebrtc's 10 ms timers and the
  jitter-buffer target align when the call starts.
- It excludes the audio devices but includes the SDK's synthetic 10 ms
  capture and playout timers, which the app replaces with the real WASAPI
  callbacks.

**Mouth-to-ear estimate: 98–118 ms** (68–88 ms plus ~30 ms for the WASAPI
capture and render buffers). The +30 ms is an estimate, not a measurement.
Target: 150 ms.

**Other measured items**

| item | result | target |
|---|---|---|
| Windows installer (NSIS, LZMA) | **9.93 MB** | < 30 MB |
| `hopon.exe` uncompressed (mostly libwebrtc) | 29.2 MB | — |
| UI bundle | 93 KB JS + 22 KB CSS (33 + 6 KB gzipped), plus 132 KB of fonts | — |
| client start → chat socket connected | 2.3–6.4 ms | pre-connect |
| client start → first paint (WebKitGTK, software GL) | 666–696 ms | < 1 s |
| voice join (connect + publish + subscribe), loopback | 166 ms | < 1 s |
| functional smoke test (`smoke`) | 34 / 34 checks pass | — |
| 1-hour voice loopback | 0 / 7200 clicks missed | no dropouts |

### Not representative (measured here, but the wrong platform)

Linux idle numbers are dominated by WebKitGTK's software renderer (llvmpipe)
and say little about WebView2: idle CPU 0.97% (core process) + 2.5%
(WebKit, repainting the caret on the CPU); RSS 160 MB + 290 MB. The Rust core
itself does no work while idle: one 10 s keepalive ping, and no timers or
polling otherwise.

### Not yet measured (need Windows hardware)

- Voice mouth-to-ear with real devices (WASAPI path, MMCSS, echo cancellation).
- Two-PC voice test and between-region voice.
- 1-hour two-user call on real devices (the network path passed 1 hour with 0 missed clicks).
- Text round trip over a real LAN and over the internet.

The exact commands are in [Measuring on Windows](#measuring-on-windows).

## Latency budget

| voice stage | budget (LAN) | where |
|---|---|---|
| WASAPI capture buffer | 10 ms | libwebrtc platform ADM |
| AEC3 / NS / AGC | ~1 ms | libwebrtc APM |
| Opus framing (20 ms) + look-ahead | 26 ms | libwebrtc |
| network client → SFU → client | 2 ms (LAN) / 40 ms (internet) | UDP/SRTP |
| SFU forwarding | 1 ms | LiveKit |
| jitter buffer (NetEq, adaptive) | 20–40 ms | libwebrtc |
| decode + PLC, render buffer | ~15 ms | libwebrtc + WASAPI |
| **total** | **~86 ms LAN, ~134 ms internet** | target 150 / 200 |

| text stage | budget | measured |
|---|---|---|
| UI → core IPC, encode, send | 1 ms | — |
| network + server + network | 2 ms LAN / 80 ms internet | 0.43 ms p95 loopback |
| decode, state, IPC to webview | 1 ms | included below |
| batched render (next frame) | ≤ 16 ms | 28 ms p95 with software rendering |
| **total** | ~20 ms LAN / ~100 ms internet | target 100 / 200 |

## Design (what makes it fast)

**Transport**
- One WebSocket per client, binary MessagePack frames. Structs are encoded as
  arrays, so a chat message with its full trace is under 100 bytes.
- `TCP_NODELAY` on every socket.
- Writes are coalesced: everything that is ready gets fed to the socket, then
  flushed once.
- The client connects, syncs clocks and authenticates at startup, before the
  user can click anything.
- Voice uses LiveKit over UDP/SRTP. coturn is the TURN fallback and ICE-TCP the
  step before it.

**Server**
- Messages are fanned out from memory before the database write. A
  per-channel lock covers ID assignment and broadcast, so fan-out order equals
  ID order.
- A single persister batches inserts (one `UNNEST` insert per transaction) and
  acks the author after commit.
- Edits and deletes go through the same ordered queue, so they can never
  overtake the insert they refer to.
- Resends are idempotent: `(author, nonce)` is remembered for 5 minutes, so a
  message resent after a reconnect keeps its ID and is never duplicated.
- One `broadcast` per server (guild), not per channel. A user in 10 servers
  costs 10 receivers, and each event is encoded once and shared as `Bytes`.
- A receiver that lags behind is disconnected; the client reconnects and
  resyncs rather than silently missing messages.
- Graceful shutdown drains the persistence queue.
- Argon2id runs on the blocking pool. Access tokens are 15-minute JWTs;
  refresh tokens are opaque, rotated on every use and stored as SHA-256.
  Refresh tokens are kept with Windows DPAPI on the client.
- The history index is the primary key `(channel_id, id)`. IDs are snowflakes,
  so "before X" paging needs no extra column.

**Client**
- All networking, state, cache and voice live in Rust. The webview only
  renders.
- Events are queued and applied once per animation frame in a single Solid
  `batch`. Updates are fine-grained; the list is never re-rendered wholesale.
- Your own message is painted optimistically in the same frame as Enter, then
  reconciled by nonce when the server copy arrives.
- The message list is virtualized: only rows near the viewport exist, and
  measured row heights are cached. Merging into a 5,000-message channel takes
  0.14 ms.
- SQLite cache (WAL, one writer thread, coalesced transactions) gives instant
  channel switches and offline scroll-back. When online, older pages come from
  the server, so the cache can never show gaps.
- Hovering a voice channel pre-fetches its join grant. Audio devices open in
  parallel with SFU signaling and are closed when you leave, so idle voice
  costs nothing.
- Push-to-talk uses a `WH_KEYBOARD_LL` hook on its own thread. The hook only
  flips an atomic and wakes a task.
- Release builds use fat LTO, `panic = abort` and stripping, with no devtools
  and no Tauri plugins. The CRT is linked statically, so no VC++
  redistributable is needed.

### Deviations from the original spec, and why

1. **Voice audio uses libwebrtc's platform ADM, not `cpal` + `rtrb` +
   `audiopus` + `webrtc-audio-processing`.** The LiveKit SDK already contains
   Opus, NetEq (jitter buffer and packet loss concealment) and the APM
   (AEC3/NS/AGC). On Windows its platform ADM is event-driven WASAPI with
   10 ms buffers on MMCSS "Pro Audio" threads; the prebuilt `webrtc.lib`
   imports `AvSetMmThreadCharacteristicsA` with "Pro Audio". NetEq feeds the
   render callback directly, so there is no extra ring buffer, and AEC3 gets
   the true playout signal. A cpal path would add a buffer stage, a second
   copy of libwebrtc and a clock-drift problem.
2. **20 ms Opus frames.** That is libwebrtc's default packet time, and it
   meets the budget with room to spare. 10 ms would save about 10 ms but
   double the packet rate; the Rust SDK does not expose it directly.
3. **Speaking indicators come from the SFU's active-speaker events, every
   100 ms** (configured in `livekit.yaml`; the default is 500 ms). The platform
   ADM does not expose local PCM.
4. **Voice processing is user-adjustable.** Echo cancellation, noise
   suppression and auto gain are on by default, with live toggles in
   Settings. On a headset, echo cancellation has nothing to remove and its
   double-talk suppression can clip speech; that was the one issue found in
   real-device testing. Opus DTX is off, so no first-syllable clipping after
   pauses.
5. **Broadcast per server rather than per channel.** See Server above.
6. **IPC between the Rust core and the webview is JSON.** MessagePack is used
   on the wire; for IPC, JSON parsing in the webview is faster than a JS
   MessagePack decoder.
7. **Not in v1:** Redis pub/sub for multiple server instances (single
   instance only), `hopon://` deep-link registration (paste the invite link or
   code instead), code signing of the installer (Windows SmartScreen warns
   on first run: More info → Run anyway).

## Games panel

The **Games** pill opens Wordle, Minute Cryptic or Krillion in a side panel.

- **How it runs.** Each game is the real website in a native child webview
  (not an iframe). It is created on open and destroyed on close, so it uses
  no memory while closed.
- **Score posting.** When you press the game's own **Share** button, the
  result is posted to the server's `general` channel (or its first text
  channel) and shown as a score card.  
- **Security.**
  - Game pages get no access to the app's commands.
  - An injected script reports shared text through the page title, and the
    core validates it per game: Wordle's exact `Wordle N X/6` format; for
    Minute Cryptic and Krillion, the game's name must appear.
  - You can share a result as often as you like; duplicate events from a
    single click are collapsed.
  - Ad popups are blocked.
- **Limits.**
  - Posting is triggered by Share rather than by detecting the end of a game,
    because that would need each site's internals.
  - Minute Cryptic and Krillion matching is name-based until their share
    formats are confirmed.

## Setup

### Server (development)

```bash
# Postgres 16 and LiveKit running locally; see infra/ for compose.
export DATABASE_URL=postgres://postgres@127.0.0.1/hopon
export HOPON_JWT_SECRET=change-me
export LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret-secret-secret-secret-secret
cargo run --release -p hopon-server   # migrations run automatically
```

Environment variables:

| variable | default |
|---|---|
| `HOPON_BIND` | `0.0.0.0:8080` |
| `HOPON_DB_POOL` | CPU count |
| `HOPON_SEND_RATE` | 10 messages/s per connection, burst 3× |
| `HOPON_NODE_ID` | 1 |
| `HOPON_FILES_DIR` | `./files` (compose: a named volume at `/data/files`) |
| `HOPON_MAX_UPLOAD_MB` | 25 (per file) |
| `HOPON_USER_QUOTA_MB` | 1024 (per user, all their files) |
| `HOPON_MIN_FREE_MB` | 2048: uploads are refused rather than eat into this much free disk |
| `KLIPY_API_KEY` | none: GIF search off (free key at klipy.com/developers) |

Uploads go over plain HTTP (`POST /files`, then the message references them),
never through the chat socket, so a big upload can't delay anyone's messages.
Files are served from `GET /files/{id}` (128-bit random ids). Uploads that
are never sent are deleted after a day; deleting a message, channel or server
deletes its files.

### Production (one region)

```bash
cp infra/.env.example infra/.env      # set secrets, hostnames
infra/render-config.sh                # writes infra/generated/{livekit.yaml,turnserver.conf}
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
```

Open these ports:

| port | service |
|---|---|
| TCP 8080 | chat; put it behind TLS and use `wss://` |
| TCP 7880 | LiveKit signaling; also behind TLS |
| TCP 7881 | ICE-TCP |
| UDP 50000–50200 | media |
| TCP/UDP 3478, UDP 50300–50400 | TURN |

Not verified in this session: the Docker image build itself. Docker Hub
rate-limited the base image pull, so only the build context was checked: the
server compiles from it.

Check that the SFU accepts the server's grants:

```bash
cargo run --release -p hopon-bench --bin voice_grant_check -- --url ws://HOST:8080/ws
```

### Windows client

Build on Linux (cross-compile) with Rust, the `x86_64-pc-windows-msvc`
target, `cargo-xwin`, clang ≥ 19, lld, NSIS (`makensis`), node and pnpm:

```bash
scripts/build-windows.sh
```

It produces:

- `target/x86_64-pc-windows-msvc/release/bundle/nsis/HopOn_<version>_x64-setup.exe`
- `voice_loopback.exe`, `msg_rtt.exe`, `smoke.exe` and `e2e_feed.exe` in the
  same `release/` directory.

You can also build on Windows: `pnpm --dir client/ui install`, then
`cd client/src-tauri && ../ui/node_modules/.bin/tauri build`.

The installer installs per-user, with no admin needed, and pulls the WebView2
runtime only if it is missing. The app connects to `wss://hopon-chat.duckdns.org/ws`
by default. To use another server, pick it on the login screen under
"Server" (it is remembered), build with `HOPON_DEFAULT_URL=wss://.../ws`, or
set `HOPON_URL` when launching. Press Ctrl+Shift+P in the app for the live
latency overlay.

Publish the installer and kit to the `downloads` branch with
`scripts/publish-downloads.sh`.

## Benchmarks

```bash
# text round trip, p50/p95/p99 per stage
cargo run --release -p hopon-bench --bin msg_rtt -- --url ws://HOST:8080/ws --n 2000 --rate 50 [--receivers 200]
# every chat feature, pass/fail
cargo run --release -p hopon-bench --bin smoke -- --url ws://HOST:8080/ws
# voice network path through the SFU (Linux needs clang >= 21 for libwebrtc: CC=clang-21 CXX=clang++-21)
cargo run --release -p hopon-bench --features voice --bin voice_loopback -- --url ws://SFU:7880 --key KEY --secret SECRET --secs 60
```

Results are appended to `results/*.jsonl`.

The server exposes its own stage timings at `GET /metrics`: recv → fan-out,
enqueue → commit, rows per transaction, lagged disconnects and persistence
failures. `GET /metrics/reset` clears them.

### Measuring on Windows

**Quickest: the local kit.** `scripts/windows-kit/` has `start-local.ps1`,
which runs Postgres, LiveKit (Windows build) and the HopOn server on one PC,
then the smoke test and the text and voice benchmarks. Steps are in
`README-WINDOWS.txt`. Package it with the binaries:

```bash
scripts/build-windows.sh
```

Then copy the installer, `hopon-server.exe`, the bench `.exe` files,
`scripts/measure-windows.ps1` and `scripts/windows-kit/*` into one folder.

These cover the numbers still listed as unmeasured.

1. **Cold start, idle RAM and idle CPU.** Install, log in once, then run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\measure-windows.ps1
   ```

   It reports process start → first paint (median of 5), and RAM and CPU
   summed over `hopon.exe` and all of its WebView2 processes. The targets are
   < 1 s, < 200 MB and < 1%.

2. **Text over LAN or internet**, from a second PC:

   ```powershell
   msg_rtt.exe --url ws://SERVER:8080/ws --n 2000 --rate 50 --label lan
   ```

   In the app, Ctrl+Shift+P shows "remote input → paint (synced)" for messages
   arriving from another PC.

3. **Voice network path, two PCs.** Start the echo side on PC B first:

   ```powershell
   voice_loopback.exe --mode echo --room t1 --url ws://SFU:7880 --key KEY --secret SECRET
   ```

   Then measure from PC A:

   ```powershell
   voice_loopback.exe --mode measure --room t1 --url ws://SFU:7880 --key KEY --secret SECRET --secs 120
   ```

   PC A reports one-way latency as RTT/2 with p50/p95/p99, plus missed clicks.

4. **Mouth-to-ear with real devices.** Join the same voice channel in the app
   on two PCs.
   - Clap or tap near PC A's microphone while recording both PC A's mic and
     PC B's speaker with one external recorder (a phone placed between them
     works).
   - The gap between the two waveforms is mouth-to-ear. Measure 20 or more
     claps and take the p95.
   - Ctrl+Shift+P also shows click → joined and click → remote track
     subscribed.

5. **One-hour call.** Keep two PCs in a voice channel for an hour with audio
   playing, then check the app log and the overlay. `voice_loopback --secs
   3600` gives the same check for the network path, reporting missed clicks.
