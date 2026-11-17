//! Screen-share path through a real LiveKit SFU, headless: participant "a"
//! captures the desktop with libwebrtc's DesktopCapturer (WGC / DXGI on
//! Windows), publishes it as a screen share; participant "b" subscribes and
//! counts decoded frames. Answers: does capture work, which codecs encode and
//! decode on this build (and with which implementation), what fps/resolution
//! arrive, and the capture → decoded latency.
//!
//!   screen_loopback --url ws://127.0.0.1:7880 --key devkey --secret secret \
//!       [--codec vp8|h264] [--secs 10] [--fps 30] [--width 1920] [--height 1080] [--bitrate 6000000]
//!
//! Prints one JSON line prefixed "RESULT " and exits 0 if frames arrived.

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use hopon_bench::arg;
use hopon_shared::time::now_us;
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::desktop_capturer::{DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::{I420Buffer, VideoFormatType, VideoFrame, VideoRotation};
use livekit::webrtc::stats::RtcStats;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::webrtc::video_stream::native::NativeVideoStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn token(key: &str, secret: &str, room: &str, identity: &str) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let now = now_us() / 1_000_000;
    let claims = serde_json::json!({
        "iss": key, "sub": identity, "name": identity, "nbf": now - 5, "exp": now + 3600,
        "video": { "room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true }
    });
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes())).unwrap()
}

/// Fit (w, h) inside (max_w, max_h), even dimensions, never upscaled.
fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let s = (max_w as f64 / w as f64).min(max_h as f64 / h as f64).min(1.0);
    (((w as f64 * s) as u32) & !1, ((h as f64 * s) as u32) & !1)
}

struct CaptureStats {
    frames: AtomicU64,
    errors: AtomicU64,
    convert_us: AtomicU64,
    width: AtomicU64,
    height: AtomicU64,
}

/// Capture thread: owns the capturer, paces capture_frame at `fps`.
fn spawn_capture(source: NativeVideoSource, fps: u32, max: (u32, u32), stop: Arc<AtomicBool>, stats: Arc<CaptureStats>) -> Result<std::thread::JoinHandle<()>> {
    let list = {
        let probe = DesktopCapturer::new(DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen))
            .ok_or_else(|| anyhow!("no screen capturer on this system"))?;
        probe.get_source_list()
    };
    for s in &list {
        println!("screen source: {s}");
    }
    if let Some(w) = DesktopCapturer::new(DesktopCapturerOptions::new(DesktopCaptureSourceType::Window)) {
        let windows = w.get_source_list();
        println!("window sources: {}", windows.len());
        for s in windows.iter().take(5) {
            println!("  window: {s}");
        }
    }
    let first = list.into_iter().next();
    Ok(std::thread::spawn(move || {
        let mut opts = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
        opts.set_include_cursor(true);
        let Some(mut capturer) = DesktopCapturer::new(opts) else {
            eprintln!("capturer creation failed");
            return;
        };
        let st = stats.clone();
        capturer.start_capture(first, move |r| match r {
            Ok(frame) => {
                let t0 = now_us();
                let (w, h) = (frame.width() as u32, frame.height() as u32);
                if w < 2 || h < 2 {
                    return;
                }
                let mut buf = I420Buffer::new(w, h);
                let (sy, su, sv) = buf.strides();
                let (y, u, v) = buf.data_mut();
                yuv_helper::argb_to_i420(frame.data(), frame.stride(), y, sy, u, su, v, sv, w as i32, h as i32);
                let (tw, th) = fit(w, h, max.0, max.1);
                let buf = if (tw, th) != (w, h) { buf.scale(tw as i32, th as i32) } else { buf };
                let mut vf = VideoFrame::new(VideoRotation::VideoRotation0, buf);
                vf.timestamp_us = now_us();
                source.capture_frame(&vf);
                st.convert_us.fetch_add((now_us() - t0) as u64, Ordering::Relaxed);
                st.frames.fetch_add(1, Ordering::Relaxed);
                st.width.store(tw as u64, Ordering::Relaxed);
                st.height.store(th as u64, Ordering::Relaxed);
            }
            Err(e) => {
                st.errors.fetch_add(1, Ordering::Relaxed);
                if st.errors.load(Ordering::Relaxed) < 5 {
                    eprintln!("capture error: {e:?}");
                }
            }
        });
        let period = Duration::from_secs_f64(1.0 / fps as f64);
        let mut next = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            capturer.capture_frame();
            next += period;
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            } else {
                next = now;
            }
        }
    }))
}

fn outbound(stats: &[RtcStats]) -> serde_json::Value {
    for s in stats {
        if let RtcStats::OutboundRtp(o) = s {
            if o.stream.kind == "video" {
                return serde_json::json!({
                    "encoder": o.outbound.encoder_implementation,
                    "width": o.outbound.frame_width, "height": o.outbound.frame_height,
                    "fps": o.outbound.frames_per_second, "framesEncoded": o.outbound.frames_encoded,
                    "encodeMsPerFrame": if o.outbound.frames_encoded > 0 { o.outbound.total_encode_time * 1000.0 / o.outbound.frames_encoded as f64 } else { 0.0 },
                    "limitedBy": format!("{:?}", o.outbound.quality_limitation_reason),
                    "bytesSent": o.sent.bytes_sent, "powerEfficient": o.outbound.power_efficient_encoder,
                });
            }
        }
    }
    serde_json::Value::Null
}

fn inbound(stats: &[RtcStats]) -> serde_json::Value {
    let codecs: Vec<String> = stats.iter().filter_map(|s| if let RtcStats::Codec(c) = s { Some(c.codec.mime_type.clone()) } else { None }).collect();
    for s in stats {
        if let RtcStats::InboundRtp(i) = s {
            if i.stream.kind == "video" {
                return serde_json::json!({
                    "decoder": i.inbound.decoder_implementation,
                    "width": i.inbound.frame_width, "height": i.inbound.frame_height,
                    "framesDecoded": i.inbound.frames_decoded, "framesDropped": i.inbound.frames_dropped,
                    "codecs": codecs,
                });
            }
        }
    }
    serde_json::json!({ "codecs": codecs })
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url: String = arg("--url", "ws://127.0.0.1:7880".to_string());
    let key: String = arg("--key", "devkey".to_string());
    let secret: String = arg("--secret", "secret".to_string());
    let codec_name: String = arg("--codec", "vp8".to_string());
    let secs: u64 = arg("--secs", 10);
    let fps: u32 = arg("--fps", 30);
    let max_w: u32 = arg("--width", 1920);
    let max_h: u32 = arg("--height", 1080);
    let bitrate: u64 = arg("--bitrate", 6_000_000);
    let room_name = format!("screen_{:x}", rand::random::<u32>());
    let codec = match codec_name.as_str() {
        "h264" => VideoCodec::H264,
        "vp9" => VideoCodec::VP9,
        "av1" => VideoCodec::AV1,
        _ => VideoCodec::VP8,
    };

    let mut o = RoomOptions::default();
    o.auto_subscribe = false;
    o.single_peer_connection = true;
    let (a, _ea) = Room::connect(&url, &token(&key, &secret, &room_name, "a:screen"), o.clone()).await?;
    let (b, mut eb) = Room::connect(&url, &token(&key, &secret, &room_name, "b:screen"), o).await?;

    let source = NativeVideoSource::new(VideoResolution { width: max_w, height: max_h }, true);
    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
    let stop = Arc::new(AtomicBool::new(false));
    let cstats = Arc::new(CaptureStats { frames: 0.into(), errors: 0.into(), convert_us: 0.into(), width: 0.into(), height: 0.into() });
    let cap = spawn_capture(source, fps, (max_w, max_h), stop.clone(), cstats.clone())?;
    let publish = TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_codec: codec,
        simulcast: false,
        video_encoding: Some(VideoEncoding { max_bitrate: bitrate, max_framerate: fps as f64 }),
        ..Default::default()
    };
    a.local_participant().publish_track(LocalTrack::Video(track.clone()), publish).await?;
    println!("published ({codec_name})");

    // b: subscribe to a's screen share (published before or after b joined).
    let subscribe = |p: &RemoteTrackPublication| {
        if p.source() == TrackSource::Screenshare {
            p.set_subscribed(true);
        }
    };
    for (_, part) in b.remote_participants() {
        for (_, p) in part.track_publications() {
            subscribe(&p);
        }
    }
    let remote = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(ev) = eb.recv().await {
            match ev {
                RoomEvent::TrackPublished { publication, .. } => subscribe(&publication),
                RoomEvent::TrackSubscribed { track: RemoteTrack::Video(t), .. } => return Some(t),
                _ => {}
            }
        }
        None
    })
    .await
    .map_err(|_| anyhow!("no video subscription within 15 s"))?
    .ok_or_else(|| anyhow!("room closed"))?;
    println!("subscribed");

    let mut stream = NativeVideoStream::new(remote.rtc_track());
    let t_start = Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    let (mut received, mut first_ms, mut last_wh, mut lat_sum, mut lat_n, mut sample_luma) = (0u64, -1.0f64, (0, 0), 0i64, 0i64, -1.0f64);
    while let Ok(Some(frame)) = tokio::time::timeout_at(deadline, stream.next()).await {
        if received == 0 {
            first_ms = t_start.elapsed().as_secs_f64() * 1000.0;
        }
        received += 1;
        last_wh = (frame.buffer.width(), frame.buffer.height());
        // Capture timestamps travel as RTP time, not wall clock: only report when plausible.
        let lat = now_us() - frame.timestamp_us;
        if frame.timestamp_us > 0 && (0..5_000_000).contains(&lat) {
            lat_sum += lat;
            lat_n += 1;
        }
        if received == 30 {
            // Decoded picture sanity: the same conversion the app's viewer uses.
            let (w, h) = last_wh;
            let mut argb = vec![0u8; (w * h * 4) as usize];
            frame.buffer.to_argb(VideoFormatType::ARGB, &mut argb, w * 4, w as i32, h as i32);
            sample_luma = argb.chunks(4).map(|p| (p[0] as f64 + p[1] as f64 + p[2] as f64) / 3.0).sum::<f64>() / (w * h) as f64;
        }
    }
    let elapsed = t_start.elapsed().as_secs_f64();
    let out = track.get_stats().await.map(|s| outbound(&s)).unwrap_or_default();
    let inb = remote.get_stats().await.map(|s| inbound(&s)).unwrap_or_default();
    stop.store(true, Ordering::Relaxed);
    let _ = cap.join();
    let captured = cstats.frames.load(Ordering::Relaxed);
    let result = serde_json::json!({
        "codec": codec_name,
        "captured": captured,
        "captureErrors": cstats.errors.load(Ordering::Relaxed),
        "captureSize": [cstats.width.load(Ordering::Relaxed), cstats.height.load(Ordering::Relaxed)],
        "convertMsPerFrame": if captured > 0 { cstats.convert_us.load(Ordering::Relaxed) as f64 / captured as f64 / 1000.0 } else { 0.0 },
        "received": received,
        "receivedFps": received as f64 / elapsed,
        "firstFrameMs": first_ms,
        "receivedSize": [last_wh.0, last_wh.1],
        "latencyMs": if lat_n > 0 { lat_sum as f64 / lat_n as f64 / 1000.0 } else { -1.0 },
        "meanLuma": sample_luma,
        "sender": out,
        "receiver": inb,
    });
    println!("RESULT {result}");
    drop((a, b));
    if received == 0 {
        std::process::exit(2);
    }
    Ok(())
}
