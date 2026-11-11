//! Voice channels: LiveKit (WebRTC over UDP, SFU) with libwebrtc's platform
//! audio device module. On Windows that is WASAPI, event-driven, 10 ms
//! buffers, with its threads at MMCSS "Pro Audio" priority (the prebuilt
//! webrtc.lib imports AvSetMmThreadCharacteristicsA with "Pro Audio"). NetEq (adaptive
//! jitter buffer + packet loss concealment) feeds the render callback
//! directly, so there is no extra playout buffer, and AEC3 gets the true
//! playout signal as its reference.
//!
//! Audio is only opened while in a channel: idle CPU stays at zero.

mod ptt;

use crate::core::{Core, Res};
use crate::perf::H;
use crate::ui::{sid, UiEvent};
use hopon_shared::time::now_us;
use hopon_shared::{Id, S2C, C2S};
use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::*;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

pub use ptt::Ptt;

struct Active {
    room: Arc<Room>,
    channel_id: Id,
    track: LocalAudioTrack,
    events: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Clone, Default)]
struct Prefs {
    input: Option<String>,
    output: Option<String>,
    muted: bool,
    deafened: bool,
    ptt: bool,
    /// Echo cancellation / noise suppression / auto gain. All on by default;
    /// echo cancellation is unnecessary (and can clip speech) on a headset.
    aec: bool,
    ns: bool,
    agc: bool,
}

impl Prefs {
    fn new() -> Self {
        Self { aec: true, ns: true, agc: true, ..Default::default() }
    }
}

pub struct Voice {
    active: tokio::sync::Mutex<Option<Active>>,
    audio: Mutex<Option<PlatformAudio>>,
    prefs: Mutex<Prefs>,
    /// Pre-fetched grants: channel → (url, token, fetched_at_s).
    grants: Mutex<HashMap<Id, (String, String, i64)>>,
    pub ptt: Ptt,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct Processing {
    pub aec: bool,
    pub ns: bool,
    pub agc: bool,
}

/// Software AEC3/NS/AGC: consistent across hardware and tuned for low delay.
/// Hardware ("communications") effects vary wildly by driver.
fn apply_processing(audio: &PlatformAudio, p: &Prefs) {
    let _ = audio.set_echo_cancellation(p.aec, false);
    let _ = audio.set_noise_suppression(p.ns, false);
    let _ = audio.set_auto_gain_control(p.agc, false);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub processing: Processing,
    pub inputs: Vec<Device>,
    pub outputs: Vec<Device>,
    pub input: Option<String>,
    pub output: Option<String>,
    pub aec: String,
    pub ns: String,
    pub agc: String,
}

impl Voice {
    pub fn new() -> Self {
        Self {
            active: tokio::sync::Mutex::new(None),
            audio: Mutex::new(None),
            prefs: Mutex::new(Prefs::new()),
            grants: Mutex::new(HashMap::new()),
            ptt: Ptt::new(),
        }
    }

    fn audio(&self) -> Res<PlatformAudio> {
        let mut a = self.audio.lock();
        if let Some(a) = a.as_ref() {
            return Ok(a.clone());
        }
        let audio = PlatformAudio::new().map_err(|e| format!("audio device: {e}"))?;
        let p = self.prefs.lock().clone();
        apply_processing(&audio, &p);
        if let Some(id) = p.input {
            let _ = audio.set_recording_device(&livekit::RecordingDeviceId::from_unchecked_guid(&id));
        }
        if let Some(id) = p.output {
            let _ = audio.set_playout_device(&livekit::PlayoutDeviceId::from_unchecked_guid(&id));
        }
        *a = Some(audio.clone());
        Ok(audio)
    }

    /// Change echo cancellation / noise suppression / gain control; applied
    /// live if a call is active.
    pub fn set_processing(&self, aec: bool, ns: bool, agc: bool) {
        let p = {
            let mut p = self.prefs.lock();
            p.aec = aec;
            p.ns = ns;
            p.agc = agc;
            p.clone()
        };
        if let Some(audio) = self.audio.lock().clone() {
            apply_processing(&audio, &p);
        }
    }

    pub fn devices(&self) -> Res<Devices> {
        let audio = self.audio()?;
        let p = self.prefs.lock().clone();
        let d = Devices {
            processing: Processing { aec: p.aec, ns: p.ns, agc: p.agc },
            inputs: audio.recording_devices().map(|d| Device { id: d.id.as_str().to_owned(), name: d.name }).collect(),
            outputs: audio.playout_devices().map(|d| Device { id: d.id.as_str().to_owned(), name: d.name }).collect(),
            input: p.input,
            output: p.output,
            aec: format!("{:?}", audio.active_aec_type()),
            ns: format!("{:?}", audio.active_ns_type()),
            agc: format!("{:?}", audio.active_agc_type()),
        };
        // Release the device again if we only opened it to enumerate.
        if self.active.try_lock().map(|a| a.is_none()).unwrap_or(false) {
            *self.audio.lock() = None;
        }
        Ok(d)
    }

    pub fn set_device(&self, input: bool, id: Option<String>) -> Res<()> {
        {
            let mut p = self.prefs.lock();
            if input { p.input = id.clone() } else { p.output = id.clone() }
        }
        if let (Some(audio), Some(id)) = (self.audio.lock().clone(), id) {
            let r = if input {
                audio.switch_recording_device(&livekit::RecordingDeviceId::from_unchecked_guid(&id))
            } else {
                audio.switch_playout_device(&livekit::PlayoutDeviceId::from_unchecked_guid(&id))
            };
            r.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Called on hover: fetch the join grant ahead of the click.
    pub async fn prepare(&self, core: &Arc<Core>, channel_id: Id) {
        let fresh = self.grants.lock().get(&channel_id).map(|g| now_us() / 1_000_000 - g.2 < 300).unwrap_or(false);
        if fresh {
            return;
        }
        if let Ok(S2C::VoiceGrant { url, token, .. }) = core.request(C2S::VoiceGrant { channel_id }).await {
            self.grants.lock().insert(channel_id, (url, token, now_us() / 1_000_000));
        }
    }

    pub async fn join(&self, core: Arc<Core>, channel_id: Id) -> Res<()> {
        let t_click = now_us();
        self.leave(&core, false).await;
        let p = self.prefs.lock().clone();
        core.emit(UiEvent::Voice { channel_id: Some(sid(channel_id)), state: "connecting", muted: p.muted, deafened: p.deafened, detail: None });

        let cached = self.grants.lock().remove(&channel_id).filter(|g| now_us() / 1_000_000 - g.2 < 300);
        let (url, token) = match cached {
            Some((u, t, _)) => (u, t),
            None => match core.request(C2S::VoiceGrant { channel_id }).await? {
                S2C::VoiceGrant { url, token, .. } => (url, token),
                _ => return Err("unexpected reply".into()),
            },
        };
        let r = self.connect(core.clone(), channel_id, &url, &token, t_click, &p).await;
        if let Err(e) = &r {
            *self.audio.lock() = None;
            core.emit(UiEvent::Voice { channel_id: None, state: "idle", muted: p.muted, deafened: p.deafened, detail: Some(e.clone()) });
        }
        r
    }

    async fn connect(&self, core: Arc<Core>, channel_id: Id, url: &str, token: &str, t_click: i64, p: &Prefs) -> Res<()> {
        // Open the audio device concurrently with signaling + ICE.
        let audio_task = tokio::task::spawn_blocking({
            let core = core.clone();
            move || core.voice.audio()
        });
        let mut opts = RoomOptions::default();
        opts.auto_subscribe = true;
        opts.adaptive_stream = false;
        opts.dynacast = false;
        opts.single_peer_connection = true;
        let (room, mut events) = Room::connect(url, token, opts).await.map_err(|e| format!("voice connect: {e}"))?;
        let room = Arc::new(room);
        let audio = audio_task.await.map_err(|e| e.to_string())??;

        let track = LocalAudioTrack::create_audio_track("mic", audio.rtc_source());
        let publish = TrackPublishOptions {
            source: TrackSource::Microphone,
            // No DTX: it can clip the first syllable after a pause, and a muted
            // track sends nothing anyway. RED: each packet also carries the
            // previous frame, so single losses cost no latency.
            dtx: false,
            red: true,
            audio_encoding: Some(AudioEncoding { max_bitrate: 40_000 }),
            ..Default::default()
        };
        room.local_participant()
            .publish_track(LocalTrack::Audio(track.clone()), publish)
            .await
            .map_err(|e| format!("publish: {e}"))?;
        if p.muted || p.deafened || p.ptt {
            track.mute();
        }
        core.perf.rec(H::VoiceJoin, now_us() - t_click);

        let events = {
            let core = core.clone();
            tauri::async_runtime::spawn(async move {
                let mut first_track = true;
                while let Some(ev) = events.recv().await {
                    match ev {
                        RoomEvent::TrackSubscribed { publication, .. } => {
                            if first_track {
                                first_track = false;
                                core.perf.rec(H::VoiceRemoteSubscribed, now_us() - t_click);
                            }
                            if core.voice.prefs.lock().deafened {
                                publication.set_enabled(false);
                            }
                        }
                        RoomEvent::ActiveSpeakersChanged { speakers } => {
                            let ids = speakers.iter().map(|s| s.identity().as_str().to_owned()).collect();
                            core.emit(UiEvent::Speaking { user_ids: ids });
                        }
                        RoomEvent::Reconnecting => core.voice.emit_state(&core, "reconnecting"),
                        RoomEvent::Reconnected => core.voice.emit_state(&core, "connected"),
                        RoomEvent::Disconnected { reason } => {
                            tracing::info!("voice disconnected: {reason:?}");
                            let c = core.clone();
                            tauri::async_runtime::spawn(async move { c.voice.leave(&c, true).await });
                            break;
                        }
                        _ => {}
                    }
                }
            })
        };
        *self.active.lock().await = Some(Active { room, channel_id, track, events });
        self.ptt.attach(core.clone());
        let _ = core.request(C2S::VoiceState { channel_id: Some(channel_id), muted: p.muted || p.ptt, deafened: p.deafened }).await;
        self.emit_state(&core, "connected");
        Ok(())
    }

    pub async fn leave(&self, core: &Arc<Core>, notify_server: bool) {
        let a = self.active.lock().await.take();
        let was = a.is_some();
        if let Some(a) = a {
            a.events.abort();
            let _ = a.room.close().await;
            drop(a.track);
        }
        // Drop the ADM: devices closed, audio threads gone, 0% idle CPU.
        *self.audio.lock() = None;
        self.ptt.detach();
        if was || notify_server {
            let _ = core.request(C2S::VoiceState { channel_id: None, muted: false, deafened: false }).await;
        }
        let p = self.prefs.lock().clone();
        core.emit(UiEvent::Voice { channel_id: None, state: "idle", muted: p.muted, deafened: p.deafened, detail: None });
    }

    fn emit_state(&self, core: &Arc<Core>, state: &'static str) {
        let ch = self.active.try_lock().ok().and_then(|a| a.as_ref().map(|a| a.channel_id));
        let p = self.prefs.lock().clone();
        core.emit(UiEvent::Voice { channel_id: ch.map(sid), state, muted: p.muted, deafened: p.deafened, detail: None });
    }

    /// Transmit on/off from mute or push-to-talk. Unmuting an already
    /// published track is instant: no renegotiation.
    pub(crate) async fn apply_transmit(&self, core: &Arc<Core>, report: bool) {
        let p = self.prefs.lock().clone();
        let talking = self.ptt.is_down();
        let open = !p.muted && !p.deafened && (!p.ptt || talking);
        let ch = {
            let a = self.active.lock().await;
            if let Some(a) = a.as_ref() {
                if open { a.track.unmute() } else { a.track.mute() }
                Some(a.channel_id)
            } else {
                None
            }
        };
        if report {
            if let Some(ch) = ch {
                let _ = core.request(C2S::VoiceState { channel_id: Some(ch), muted: p.muted || p.ptt, deafened: p.deafened }).await;
            }
            self.emit_state(core, if ch.is_some() { "connected" } else { "idle" });
        }
    }

    pub async fn set_muted(&self, core: &Arc<Core>, muted: bool) {
        self.prefs.lock().muted = muted;
        self.apply_transmit(core, true).await;
    }

    pub async fn set_deafened(&self, core: &Arc<Core>, deafened: bool) {
        self.prefs.lock().deafened = deafened;
        if let Some(a) = self.active.lock().await.as_ref() {
            // Unsubscribed tracks are not decoded at all.
            for (_, part) in a.room.remote_participants() {
                for (_, publication) in part.track_publications() {
                    publication.set_enabled(!deafened);
                }
            }
        }
        self.apply_transmit(core, true).await;
    }

    pub async fn set_ptt(&self, core: &Arc<Core>, enabled: bool, vk: u32) {
        self.prefs.lock().ptt = enabled;
        self.ptt.configure(enabled, vk);
        self.apply_transmit(core, true).await;
    }

    pub fn on_reconnect(&self, core: Arc<Core>) {
        // The server forgets presence when the chat socket drops; restate it.
        tauri::async_runtime::spawn(async move {
            let ch = core.voice.active.lock().await.as_ref().map(|a| a.channel_id);
            if let Some(ch) = ch {
                let p = core.voice.prefs.lock().clone();
                let _ = core.request(C2S::VoiceState { channel_id: Some(ch), muted: p.muted || p.ptt, deafened: p.deafened }).await;
            }
        });
    }
}
