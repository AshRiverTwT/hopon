# Vendored crates (patched)

`webrtc-sys` 0.3.53 and `libwebrtc` 0.4.0 from crates.io (LiveKit, Apache-2.0),
used through `[patch.crates-io]` in the workspace `Cargo.toml`.

The only change: `set_volume` on remote audio tracks (per-person voice
volume), exposing WebRTC's own `AudioSourceInterface::SetVolume`. Every edit
is marked `HopOn patch`:

- `webrtc-sys/include/livekit/audio_track.h`, `webrtc-sys/src/audio_track.cpp`,
  `webrtc-sys/src/audio_track.rs`
- `libwebrtc/src/native/audio_track.rs`, `libwebrtc/src/audio_track.rs`

To move to a newer LiveKit SDK, re-copy both crates from the registry and
re-apply those few lines (`grep -rn "HopOn patch" vendor/`).
