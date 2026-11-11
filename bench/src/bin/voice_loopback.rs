//! Voice-path latency benchmark through a real LiveKit SFU.
//!
//! Measures everything between the microphone buffer and the speaker buffer:
//! Opus encode → RTP/SRTP over UDP → SFU → NetEq jitter buffer + PLC → decode.
//! Add the device buffers (WASAPI capture 10 ms + render 10–20 ms) to get
//! mouth-to-ear; see README "Voice measurement".
//!
//! A 2 kHz click is injected every 500 ms; the receiver finds its onset at
//! sample precision.
//!
//!   loopback (one machine, two participants):
//!     voice_loopback --url ws://SFU:7880 --key devkey --secret secret [--secs 60]
//!   two PCs (B echoes, A measures round trip; one-way ≈ rtt/2):
//!     PC B: voice_loopback --mode echo    --room bench --url ws://SFU:7880 ...
//!     PC A: voice_loopback --mode measure --room bench --url ws://SFU:7880 ...

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use hopon_bench::{arg, save};
use hopon_shared::stats::Latency;
use hopon_shared::time::now_us;
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const SR: u32 = 48_000;
const FRAME: usize = 480; // 10 ms
const PERIOD_FRAMES: u64 = 50; // click every 500 ms
const CLICK_AT: usize = 240; // sample offset of the click inside its frame
const THRESH: i32 = 6_000;

fn token(key: &str, secret: &str, room: &str, identity: &str) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let now = now_us() / 1_000_000;
    let claims = serde_json::json!({
        "iss": key, "sub": identity, "name": identity, "nbf": now - 5, "exp": now + 3600,
        "video": { "room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true }
    });
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes())).unwrap()
}

fn opts() -> RoomOptions {
    let mut o = RoomOptions::default();
    o.auto_subscribe = true;
    o.single_peer_connection = true;
    o
}

fn publish_opts() -> TrackPublishOptions {
    let red = arg::<String>("--red", "on".into()) == "on";
    TrackPublishOptions { source: TrackSource::Microphone, dtx: false, red, ..Default::default() }
}

async fn first_audio(events: &mut tokio::sync::mpsc::UnboundedReceiver<RoomEvent>, from: Option<&str>) -> Result<RemoteAudioTrack> {
    while let Some(ev) = events.recv().await {
        if let RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(t), participant, .. } = ev {
            if from.map_or(true, |f| participant.identity().as_str() == f) {
                return Ok(t);
            }
        }
    }
    Err(anyhow!("room closed before a track arrived"))
}

/// Pace 10 ms frames in real time; returns the shared table of click stamps.
fn spawn_clicker(source: NativeAudioSource, sent: Arc<Vec<AtomicI64>>, n_clicks: usize) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
        let silence = vec![0i16; FRAME];
        let mut click = vec![0i16; FRAME];
        for i in 0..96 {
            // 2 ms burst of 2 kHz with a fast attack.
            let s = (i as f32 * 2.0 * std::f32::consts::PI * 2000.0 / SR as f32).sin();
            click[CLICK_AT + i] = (s * 20_000.0) as i16;
        }
        let total_frames = n_clicks as u64 * PERIOD_FRAMES;
        for f in 0..total_frames {
            tick.tick().await;
            let is_click = f % PERIOD_FRAMES == PERIOD_FRAMES - 1;
            let data = if is_click { &click } else { &silence };
            let frame = AudioFrame { data: data.as_slice().into(), sample_rate: SR, num_channels: 1, samples_per_channel: FRAME as u32 };
            let t_push = now_us();
            let _ = source.capture_frame(&frame).await;
            if is_click {
                // The pushed frame covers [t_push-10ms, t_push]; the click sits CLICK_AT into it.
                let t_click = t_push - 10_000 + (CLICK_AT as i64 * 1_000_000 / SR as i64);
                sent[(f / PERIOD_FRAMES) as usize].store(t_click, Ordering::Relaxed);
            }
        }
    })
}

/// Detect click onsets; returns (latencies, detected count).
async fn detect(track: RemoteAudioTrack, sent: Arc<Vec<AtomicI64>>, secs: u64, divide: i64) -> (Latency, u64) {
    let mut lat = Latency::new(if divide == 2 { "voice one-way (rtt/2), codec+net+SFU+jitter" } else { "voice codec+net+SFU+jitter+decode" });
    let mut stream = NativeAudioStream::new(track.rtc_track(), SR as i32, 1);
    let detected = AtomicU64::new(0);
    let mut armed_after = 0i64;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs + 3);
    while let Ok(Some(frame)) = tokio::time::timeout_at(deadline, stream.next()).await {
        let t_arrive = now_us();
        if t_arrive < armed_after {
            continue;
        }
        if let Some(idx) = frame.data.iter().position(|s| (*s as i32).abs() > THRESH) {
            // This frame starts playing now; the onset plays idx samples later.
            let t_play = t_arrive + idx as i64 * 1_000_000 / frame.sample_rate as i64;
            // Match to the newest click sent before it.
            let best = sent.iter().map(|a| a.load(Ordering::Relaxed)).filter(|&t| t > 0 && t < t_play).max();
            if let Some(t_sent) = best {
                lat.record_us((t_play - t_sent) / divide);
                detected.fetch_add(1, Ordering::Relaxed);
            }
            armed_after = t_arrive + 200_000; // ignore the click tail / RED duplicates
        }
    }
    (lat, detected.load(Ordering::Relaxed))
}

#[tokio::main]
async fn main() -> Result<()> {
    let url: String = arg("--url", "ws://127.0.0.1:7880".to_string());
    let key: String = arg("--key", "devkey".to_string());
    let secret: String = arg("--secret", "secret".to_string());
    let mode: String = arg("--mode", "loopback".to_string());
    let room_name: String = arg("--room", format!("bench_{:x}", rand::random::<u32>()));
    let secs: u64 = arg("--secs", 60);
    let label: String = arg("--label", mode.clone());
    let n_clicks = (secs * 2) as usize;
    let sent: Arc<Vec<AtomicI64>> = Arc::new((0..n_clicks).map(|_| AtomicI64::new(0)).collect());

    // Source queue: the app uses the platform ADM instead, so keep this minimal.
    let queue_ms: u32 = arg("--queue-ms", 10);
    let src = || NativeAudioSource::new(AudioSourceOptions::default(), SR, 1, queue_ms);

    let (lat, detected) = match mode.as_str() {
        "loopback" => {
            let t0 = now_us();
            let (a, _ea) = Room::connect(&url, &token(&key, &secret, &room_name, "a"), opts()).await?;
            let (b, mut eb) = Room::connect(&url, &token(&key, &secret, &room_name, "b"), opts()).await?;
            let source = src();
            let track = LocalAudioTrack::create_audio_track("bench", RtcAudioSource::Native(source.clone()));
            a.local_participant().publish_track(LocalTrack::Audio(track), publish_opts()).await?;
            let remote = first_audio(&mut eb, Some("a")).await?;
            println!("joined + subscribed in {:.1} ms", (now_us() - t0) as f64 / 1000.0);
            let det = tokio::spawn(detect(remote, sent.clone(), secs, 1));
            spawn_clicker(source, sent.clone(), n_clicks).await?;
            let r = det.await?;
            drop((a, b));
            r
        }
        "echo" => {
            let (room, mut ev) = Room::connect(&url, &token(&key, &secret, &room_name, "echo"), opts()).await?;
            let source = src();
            let track = LocalAudioTrack::create_audio_track("echo", RtcAudioSource::Native(source.clone()));
            room.local_participant().publish_track(LocalTrack::Audio(track), publish_opts()).await?;
            println!("echo ready in room {room_name}");
            let remote = first_audio(&mut ev, Some("measure")).await?;
            let mut stream = NativeAudioStream::new(remote.rtc_track(), SR as i32, 1);
            while let Some(f) = stream.next().await {
                let _ = source.capture_frame(&f).await;
            }
            return Ok(());
        }
        "measure" => {
            let (room, mut ev) = Room::connect(&url, &token(&key, &secret, &room_name, "measure"), opts()).await?;
            let source = src();
            let track = LocalAudioTrack::create_audio_track("measure", RtcAudioSource::Native(source.clone()));
            room.local_participant().publish_track(LocalTrack::Audio(track), publish_opts()).await?;
            let remote = first_audio(&mut ev, Some("echo")).await?;
            tokio::time::sleep(Duration::from_secs(1)).await;
            let det = tokio::spawn(detect(remote, sent.clone(), secs, 2));
            spawn_clicker(source, sent.clone(), n_clicks).await?;
            let r = det.await?;
            drop(room);
            r
        }
        m => return Err(anyhow!("unknown mode {m}")),
    };

    let missed = n_clicks as u64 - detected.min(n_clicks as u64);
    println!("\nvoice_loopback  mode={mode}  {secs}s  clicks={n_clicks}  missed={missed}");
    println!("{}", lat.line());
    let p95 = lat.summary().p95_ms;
    // Budget: 150 ms mouth-to-ear minus ~30 ms of device buffers.
    println!("network-path p95 = {p95:.1} ms; + ~30 ms device buffers ≈ {:.0} ms mouth-to-ear (target 150)", p95 + 30.0);
    save("voice.jsonl", serde_json::json!({ "label": label, "mode": mode, "secs": secs, "missed": missed, "stats": lat.summary(), "t": now_us() }));
    Ok(())
}
