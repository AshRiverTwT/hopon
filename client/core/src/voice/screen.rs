//! Screen sharing and watching for the native shell (the Tauri shell does
//! this in the webview: client/ui/src/screen.ts; same room, same rules, so the
//! two interoperate).
//!
//! - A second LiveKit connection ("<user>:screen", from `screen_grant`) to the
//!   voice room you're in. It is opened only when you share or watch, and
//!   closed when idle, on voice leave, or when you switch rooms.
//! - Share: libwebrtc's DesktopCapturer (WGC / DXGI on Windows) on its own
//!   thread, paced at the chosen fps, BGRA → I420 (scaled to fit the quality),
//!   published as `Screenshare`.
//! - Watch: opt-in per person. Subscribes to their `Screenshare` (and
//!   `ScreenshareAudio`, which plays through the voice audio device). Decoded
//!   frames go into a one-slot "latest" box; the UI pulls them at its own
//!   refresh (`frame`) converted to BGRA at the size it shows.
//! - Viewers announce what they watch in the `watching` participant attribute
//!   (comma-separated user ids), like the web client.

use crate::core::{Core, Res};
use crate::ui::{sid, ScreenState, UiEvent};
use futures_util::StreamExt;
use hopon_shared::{Id, MediaSource, C2S, S2C};
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::desktop_capturer::{DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::{BoxVideoFrame, I420Buffer, VideoBuffer, VideoFormatType, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::webrtc::video_stream::native::NativeVideoStream;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Same table as the web client (QUALITIES in screen.ts).
pub fn quality(name: &str) -> (u32, u32, u32, u64) {
    match name {
        "720p30" => (1280, 720, 30, 2_000_000),
        "720p60" => (1280, 720, 60, 4_500_000),
        "1440p60" => (2560, 1440, 60, 14_000_000),
        _ => (1920, 1080, 60, 8_000_000),
    }
}

/// The codec native publishers use. The prebuilt libwebrtc has no H.264
/// decoder on Windows, so native viewers need VP8 (web viewers decode both).
const CODEC: VideoCodec = VideoCodec::VP8;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// "screen:<id>" or "window:<id>"
    pub id: String,
    pub title: String,
    pub kind: &'static str,
}

/// Screens and windows that can be shared.
pub fn sources() -> Vec<Source> {
    let mut out = Vec::new();
    for (ty, kind) in [(DesktopCaptureSourceType::Screen, "screen"), (DesktopCaptureSourceType::Window, "window")] {
        let Some(c) = DesktopCapturer::new(DesktopCapturerOptions::new(ty)) else { continue };
        for (i, s) in c.get_source_list().into_iter().enumerate() {
            let title = s.title();
            let title = if title.is_empty() { if kind == "screen" { format!("Screen {}", i + 1) } else { "Window".into() } } else { title };
            out.push(Source { id: format!("{kind}:{}", s.id()), title, kind });
        }
    }
    out
}

/// Fit (w, h) inside (max_w, max_h), even dimensions, never upscaled.
fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let s = (max_w as f64 / w as f64).min(max_h as f64 / h as f64).min(1.0);
    ((((w as f64 * s) as u32) & !1).max(2), (((h as f64 * s) as u32) & !1).max(2))
}

/// One watched stream's newest decoded frame.
struct Latest {
    seq: AtomicU64,
    frame: Mutex<Option<BoxVideoFrame>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Drop for Latest {
    fn drop(&mut self) {
        if let Some(t) = self.task.lock().take() {
            t.abort();
        }
    }
}

struct Sharing {
    track: LocalVideoTrack,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Sharing {
    fn stop(mut self) -> LocalVideoTrack {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.track
    }
}

#[derive(Default)]
struct St {
    room: Option<Arc<Room>>,
    channel: Option<Id>,
    events: Option<tokio::task::JoinHandle<()>>,
    share: Option<Sharing>,
    /// user ids you watch
    watching: Vec<String>,
}

pub struct Screen {
    st: tokio::sync::Mutex<St>,
    latest: Mutex<HashMap<String, Arc<Latest>>>,
    /// Stream sound volume per person (0.0 – 2.0).
    volumes: Mutex<HashMap<String, f64>>,
}

fn user_of(identity: &str) -> String {
    identity.split(':').next().unwrap_or("").to_owned()
}

impl Screen {
    pub fn new() -> Self {
        Self { st: tokio::sync::Mutex::new(St::default()), latest: Mutex::new(HashMap::new()), volumes: Mutex::new(HashMap::new()) }
    }

    fn state(&self, st: &St, me: &str, detail: Option<String>) -> ScreenState {
        let mut viewers: HashMap<String, Vec<String>> = HashMap::new();
        if let Some(room) = &st.room {
            for (_, p) in room.remote_participants() {
                let who = user_of(p.identity().as_str());
                for u in p.attributes().get("watching").map(|s| s.as_str()).unwrap_or("").split(',').filter(|s| !s.is_empty()) {
                    let v = viewers.entry(u.to_owned()).or_default();
                    if !v.contains(&who) {
                        v.push(who.clone());
                    }
                }
            }
        }
        for u in &st.watching {
            let v = viewers.entry(u.clone()).or_default();
            if !v.iter().any(|x| x == me) {
                v.push(me.to_owned());
            }
        }
        let live = self.latest.lock().iter().filter(|(_, l)| l.seq.load(Ordering::Relaxed) > 0).map(|(u, _)| u.clone()).collect();
        ScreenState { channel_id: st.channel.map(sid), sharing: st.share.is_some(), watching: st.watching.clone(), live, viewers, detail }
    }

    async fn emit(&self, core: &Arc<Core>, detail: Option<String>) {
        let me = my_id(core);
        let s = {
            let st = self.st.lock().await;
            self.state(&st, &me, detail)
        };
        core.emit(UiEvent::Screen { state: s });
    }

    /// The screen connection for the voice room you're in (opened if needed).
    async fn room(&self, core: &Arc<Core>, st: &mut St) -> Res<Arc<Room>> {
        let channel = core.voice.channel().await.ok_or("Join voice first")?;
        if st.channel == Some(channel) {
            if let Some(r) = &st.room {
                return Ok(r.clone());
            }
        }
        Self::close_room(self, st).await;
        let (url, token) = match core.request(C2S::ScreenGrant { channel_id: channel }).await? {
            S2C::VoiceGrant { url, token, .. } => (url, token),
            _ => return Err("unexpected reply".into()),
        };
        let mut opts = RoomOptions::default();
        opts.auto_subscribe = false;
        opts.adaptive_stream = false;
        opts.dynacast = true;
        opts.single_peer_connection = true;
        let (room, mut events) = Room::connect(&url, &token, opts).await.map_err(|e| format!("screen connect: {e}"))?;
        let room = Arc::new(room);
        let c = core.clone();
        st.events = Some(crate::rt::spawn(async move {
            while let Some(ev) = events.recv().await {
                let screen = &c.voice.screen;
                match ev {
                    RoomEvent::TrackSubscribed { track, participant, .. } => screen.on_subscribed(&c, track, participant).await,
                    RoomEvent::TrackUnpublished { publication, participant } => {
                        if publication.source() == TrackSource::Screenshare {
                            screen.ended(&c, &user_of(participant.identity().as_str())).await;
                        }
                    }
                    RoomEvent::ParticipantDisconnected(p) => screen.ended(&c, &user_of(p.identity().as_str())).await,
                    RoomEvent::ParticipantAttributesChanged { .. } => screen.emit(&c, None).await,
                    RoomEvent::Disconnected { reason } => {
                        tracing::info!("screen connection closed: {reason:?}");
                        let cc = c.clone();
                        crate::rt::spawn(async move { cc.voice.screen.close(&cc).await });
                        break;
                    }
                    _ => {}
                }
            }
        }));
        st.room = Some(room.clone());
        st.channel = Some(channel);
        Ok(room)
    }

    async fn close_room(&self, st: &mut St) {
        if let Some(e) = st.events.take() {
            e.abort();
        }
        if let Some(s) = st.share.take() {
            drop(s.stop());
        }
        st.watching.clear();
        self.latest.lock().clear();
        if let Some(r) = st.room.take() {
            let _ = r.close().await;
        }
        st.channel = None;
    }

    /// Voice left / room changed: stop everything.
    pub async fn close(&self, core: &Arc<Core>) {
        let (was_sharing, channel) = {
            let mut st = self.st.lock().await;
            let was = (st.share.is_some(), st.channel);
            if st.room.is_none() && st.share.is_none() {
                return;
            }
            self.close_room(&mut st).await;
            was
        };
        if let (true, Some(ch)) = (was_sharing, channel) {
            let _ = core.request(C2S::MediaState { channel_id: ch, source: MediaSource::Screen, active: false }).await;
        }
        self.emit(core, None).await;
    }

    async fn close_if_idle(&self, core: &Arc<Core>) {
        let idle = {
            let st = self.st.lock().await;
            st.room.is_some() && st.share.is_none() && st.watching.is_empty()
        };
        if idle {
            self.close(core).await;
        }
    }

    pub async fn share(&self, core: &Arc<Core>, source_id: &str, quality_name: &str) -> Res<()> {
        let (kind, id) = source_id.split_once(':').ok_or("bad source")?;
        let id: u64 = id.parse().map_err(|_| "bad source")?;
        let ty = if kind == "window" { DesktopCaptureSourceType::Window } else { DesktopCaptureSourceType::Screen };
        let (max_w, max_h, fps, bitrate) = quality(quality_name);
        let channel;
        {
            let mut st = self.st.lock().await;
            if let Some(s) = st.share.take() {
                // Switching source / quality: replace the running share.
                let track = s.stop();
                if let Some(r) = &st.room {
                    let _ = r.local_participant().unpublish_track(&track.sid()).await;
                }
            }
            let room = self.room(core, &mut st).await?;
            channel = st.channel;
            let source = NativeVideoSource::new(VideoResolution { width: max_w, height: max_h }, true);
            let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
            let stop = Arc::new(AtomicBool::new(false));
            let thread = spawn_capture(core.clone(), ty, id, source, fps, (max_w, max_h), stop.clone())?;
            let publish = TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: CODEC,
                simulcast: false,
                video_encoding: Some(VideoEncoding { max_bitrate: bitrate, max_framerate: fps as f64 }),
                ..Default::default()
            };
            let sharing = Sharing { track: track.clone(), stop, thread: Some(thread) };
            if let Err(e) = room.local_participant().publish_track(LocalTrack::Video(track), publish).await {
                drop(sharing.stop());
                drop(st);
                self.close_if_idle(core).await;
                return Err(format!("publish: {e}"));
            }
            st.share = Some(sharing);
        }
        if let Some(ch) = channel {
            core.request(C2S::MediaState { channel_id: ch, source: MediaSource::Screen, active: true }).await?;
        }
        self.emit(core, None).await;
        Ok(())
    }

    pub async fn stop_share(&self, core: &Arc<Core>) -> Res<()> {
        let channel = {
            let mut st = self.st.lock().await;
            let Some(s) = st.share.take() else { return Ok(()) };
            let track = s.stop();
            if let Some(r) = &st.room {
                let _ = r.local_participant().unpublish_track(&track.sid()).await;
            }
            st.channel
        };
        if let Some(ch) = channel {
            let _ = core.request(C2S::MediaState { channel_id: ch, source: MediaSource::Screen, active: false }).await;
        }
        self.emit(core, None).await;
        self.close_if_idle(core).await;
        Ok(())
    }

    pub async fn watch(&self, core: &Arc<Core>, user_id: String) -> Res<()> {
        let room = {
            let mut st = self.st.lock().await;
            if st.watching.contains(&user_id) {
                return Ok(());
            }
            let room = self.room(core, &mut st).await?;
            st.watching.push(user_id.clone());
            room
        };
        self.latest.lock().insert(user_id.clone(), Arc::new(Latest { seq: 0.into(), frame: Mutex::new(None), task: Mutex::new(None) }));
        // The sharer may still be connecting: wait up to 5 s for their publication.
        let deadline = Instant::now() + Duration::from_secs(5);
        let found = loop {
            let p = room.remote_participants().into_values().find(|p| {
                user_of(p.identity().as_str()) == user_id && p.track_publications().values().any(|t| t.source() == TrackSource::Screenshare)
            });
            if p.is_some() || Instant::now() > deadline {
                break p;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        let Some(p) = found else {
            self.unwatch(core, &user_id).await;
            return Err("This screen share is no longer available".into());
        };
        for (_, publication) in p.track_publications() {
            if matches!(publication.source(), TrackSource::Screenshare | TrackSource::ScreenshareAudio) {
                publication.set_subscribed(true);
            }
        }
        self.publish_watching(&room).await;
        self.emit(core, None).await;
        Ok(())
    }

    pub async fn unwatch(&self, core: &Arc<Core>, user_id: &str) {
        let room = {
            let mut st = self.st.lock().await;
            st.watching.retain(|u| u != user_id);
            st.room.clone()
        };
        self.latest.lock().remove(user_id);
        if let Some(room) = &room {
            for (_, p) in room.remote_participants() {
                if user_of(p.identity().as_str()) == user_id {
                    for (_, publication) in p.track_publications() {
                        if matches!(publication.source(), TrackSource::Screenshare | TrackSource::ScreenshareAudio) {
                            publication.set_subscribed(false);
                        }
                    }
                }
            }
            self.publish_watching(room).await;
        }
        self.emit(core, None).await;
        self.close_if_idle(core).await;
    }

    async fn publish_watching(&self, room: &Room) {
        let list = self.st.lock().await.watching.join(",");
        let attrs = HashMap::from([("watching".to_owned(), list)]);
        // Older servers may not allow attributes: viewer counts are optional.
        let _ = room.local_participant().set_attributes(attrs).await;
    }

    /// A sharer stopped (or left): stop watching them.
    async fn ended(&self, core: &Arc<Core>, user_id: &str) {
        let watched = self.st.lock().await.watching.iter().any(|u| u == user_id);
        if watched {
            self.unwatch(core, user_id).await;
        } else {
            self.emit(core, None).await;
        }
    }

    async fn on_subscribed(&self, core: &Arc<Core>, track: RemoteTrack, participant: RemoteParticipant) {
        let user = user_of(participant.identity().as_str());
        match track {
            RemoteTrack::Video(v) => {
                let Some(latest) = self.latest.lock().get(&user).cloned() else { return };
                let l = latest.clone();
                let c = core.clone();
                let u = user.clone();
                let task = crate::rt::spawn(async move {
                    let mut stream = NativeVideoStream::new(v.rtc_track());
                    while let Some(frame) = stream.next().await {
                        *l.frame.lock() = Some(frame);
                        if l.seq.fetch_add(1, Ordering::Relaxed) == 0 {
                            // First picture: tell the UI the stream is live.
                            let _ = &u;
                            c.voice.screen.emit(&c, None).await;
                        }
                    }
                });
                if let Some(old) = latest.task.lock().replace(task) {
                    old.abort();
                }
            }
            RemoteTrack::Audio(a) => {
                let v = self.volumes.lock().get(&user).copied().unwrap_or(1.0);
                a.rtc_track().set_volume(v);
            }
        }
    }

    /// Stream sound volume (0.0 – 2.0), remembered per person.
    pub async fn set_volume(&self, user_id: String, volume: f64) {
        let v = volume.clamp(0.0, 2.0);
        self.volumes.lock().insert(user_id.clone(), v);
        let room = self.st.lock().await.room.clone();
        if let Some(room) = room {
            for (_, p) in room.remote_participants() {
                if user_of(p.identity().as_str()) != user_id {
                    continue;
                }
                for (_, publication) in p.track_publications() {
                    if let Some(RemoteTrack::Audio(a)) = publication.track() {
                        a.rtc_track().set_volume(v);
                    }
                }
            }
        }
    }

    /// The newest frame of a watched stream as BGRA (premultiplied, opaque),
    /// fitted inside max_w × max_h, written to `dst` with stride width*4.
    /// Returns (width, height, seq), or None if nothing newer than `last_seq`
    /// (or `dst` is too small: needs width*height*4 bytes).
    pub fn frame(&self, user_id: &str, last_seq: u64, dst: &mut [u8], max_w: u32, max_h: u32) -> Option<(u32, u32, u64)> {
        let latest = self.latest.lock().get(user_id).cloned()?;
        let seq = latest.seq.load(Ordering::Relaxed);
        if seq == 0 || seq == last_seq {
            return None;
        }
        let guard = latest.frame.lock();
        let frame = guard.as_ref()?;
        let (w, h) = (frame.buffer.width(), frame.buffer.height());
        let (tw, th) = fit(w, h, max_w.max(2), max_h.max(2));
        if dst.len() < (tw * th * 4) as usize {
            return None;
        }
        if (tw, th) == (w, h) {
            frame.buffer.to_argb(VideoFormatType::ARGB, dst, tw * 4, tw as i32, th as i32);
        } else {
            let mut i420 = frame.buffer.to_i420();
            drop(guard);
            let scaled = i420.scale(tw as i32, th as i32);
            let (sy, su, sv) = scaled.strides();
            let (y, u, v) = scaled.data();
            yuv_helper::i420_to_argb(y, sy, u, su, v, sv, dst, tw * 4, tw as i32, th as i32);
        }
        Some((tw, th, seq))
    }

    /// Size of the newest frame of a watched stream (0, 0 if none yet).
    pub fn frame_size(&self, user_id: &str) -> (u32, u32) {
        let Some(latest) = self.latest.lock().get(user_id).cloned() else { return (0, 0) };
        let g = latest.frame.lock();
        g.as_ref().map(|f| (f.buffer.width(), f.buffer.height())).unwrap_or((0, 0))
    }
}

fn my_id(core: &Arc<Core>) -> String {
    core.store.lock().me.as_ref().map(|m| sid(m.id)).unwrap_or_default()
}

/// Capture thread: owns the capturer, paces capture_frame at `fps`.
fn spawn_capture(
    core: Arc<Core>,
    ty: DesktopCaptureSourceType,
    id: u64,
    source: NativeVideoSource,
    fps: u32,
    max: (u32, u32),
    stop: Arc<AtomicBool>,
) -> Res<std::thread::JoinHandle<()>> {
    let mut opts = DesktopCapturerOptions::new(ty);
    opts.set_include_cursor(true);
    let probe = DesktopCapturer::new(DesktopCapturerOptions::new(ty)).ok_or("screen capture is not available")?;
    let src = probe.get_source_list().into_iter().find(|s| s.id() == id).ok_or("that screen or window is gone")?;
    drop(probe);
    std::thread::Builder::new()
        .name("screen-capture".into())
        .spawn(move || {
            let Some(mut capturer) = DesktopCapturer::new(opts) else { return };
            let failed = Arc::new(AtomicBool::new(false));
            let f = failed.clone();
            capturer.start_capture(Some(src), move |r| match r {
                Ok(frame) => {
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
                    vf.timestamp_us = hopon_shared::time::now_us();
                    source.capture_frame(&vf);
                }
                Err(livekit::webrtc::desktop_capturer::CaptureError::Permanent) => f.store(true, Ordering::Relaxed),
                Err(_) => {}
            });
            let period = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
            let mut next = Instant::now();
            while !stop.load(Ordering::Relaxed) {
                capturer.capture_frame();
                if failed.load(Ordering::Relaxed) {
                    // The window closed or the screen went away: end the share.
                    let c = core.clone();
                    crate::rt::spawn(async move {
                        let _ = c.voice.screen.stop_share(&c).await;
                        c.voice.screen.emit(&c, Some("The shared screen or window is no longer available".into())).await;
                    });
                    break;
                }
                next += period;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    next = now;
                }
            }
        })
        .map_err(|e| e.to_string())
}
