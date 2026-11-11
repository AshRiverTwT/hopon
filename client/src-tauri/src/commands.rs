//! Webview → core commands. Thin: parse IDs, call the core, map errors.

use crate::core::{Core, Res};
use crate::perf::Startup;
use crate::ui::*;
use hopon_shared::time::now_us;
use hopon_shared::{ChannelKind, C2S, S2C};
use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

type C<'a> = State<'a, Arc<Core>>;

fn ms_to_us(ms: f64) -> i64 {
    (ms * 1000.0) as i64
}

#[tauri::command]
pub fn ui_subscribe(core: C<'_>, events: Channel<UiEvent>) {
    core.attach_ui(events);
}

/// First frame painted: record cold-start timings. The window is visible from
/// creation (a hidden webview does not run requestAnimationFrame, which would
/// stall this signal); `backgroundColor` avoids a white flash.
#[tauri::command]
pub fn ui_ready(app: tauri::AppHandle, core: C<'_>, t_paint_ms: f64) {
    let t_paint = ms_to_us(t_paint_ms);
    let s = Startup {
        process_to_paint_ms: crate::perf::process_start_us().map(|p| (t_paint - p) as f64 / 1000.0),
        main_to_paint_ms: (t_paint - core.perf.t_main) as f64 / 1000.0,
        main_to_connected_ms: match core.perf.t_connected.load(std::sync::atomic::Ordering::Relaxed) {
            0 => None,
            t => Some((t - core.perf.t_main) as f64 / 1000.0),
        },
    };
    *core.perf.startup.lock() = Some(s);
    tracing::info!("startup: {s:?}");
    if std::env::args().any(|a| a == "--perf-exit") {
        let p = std::env::temp_dir().join("hopon-startup.json");
        let _ = std::fs::write(p, serde_json::to_vec(&s).unwrap_or_default());
        app.exit(0);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    url: String,
    /// Tests only (HOPON_TEST_OPEN_GAMES): open the games panel on start.
    test_open_games: bool,
}

#[tauri::command]
pub fn get_config(core: C<'_>) -> Config {
    Config { url: core.url.lock().clone(), test_open_games: std::env::var("HOPON_TEST_OPEN_GAMES").is_ok() }
}

#[tauri::command]
pub fn set_server_url(core: C<'_>, url: String) -> Res<()> {
    let url = url.trim().to_owned();
    if !(url.starts_with("ws://") || url.starts_with("wss://")) {
        return Err("server URL must start with ws:// or wss://".into());
    }
    if *core.url.lock() != url {
        core.cache.kv_set("url", Some(url.clone().into_bytes()));
        *core.url.lock() = url;
        core.force_reconnect();
    }
    Ok(())
}

#[tauri::command]
pub async fn signup(core: C<'_>, username: String, password: String) -> Res<()> {
    core.request(C2S::Signup { username, password }).await.map(|_| ())
}

#[tauri::command]
pub async fn login(core: C<'_>, username: String, password: String) -> Res<()> {
    core.request(C2S::Login { username, password }).await.map(|_| ())
}

#[tauri::command]
pub async fn logout(core: C<'_>) -> Res<()> {
    let core = core.inner().clone();
    core.voice.leave(&core, true).await;
    let refresh_token = core.store.lock().refresh_token.clone().unwrap_or_default();
    // Logged out locally even if the server is unreachable.
    let _ = core.request(C2S::Logout { refresh_token }).await;
    *core.store.lock() = Default::default();
    core.cache.kv_set("refresh", None);
    let ev = core.session_snapshot();
    core.emit(ev);
    Ok(())
}

#[tauri::command]
pub async fn open_channel(core: C<'_>, channel_id: String) -> Res<Vec<UiMsg>> {
    let ch = pid(&channel_id)?;
    Ok(core.inner().open_channel(ch).await)
}

#[derive(Serialize)]
pub struct Page {
    msgs: Vec<UiMsg>,
    more: bool,
}

#[tauri::command]
pub async fn load_older(core: C<'_>, channel_id: String, before: String) -> Res<Page> {
    let (msgs, more) = core.load_older(pid(&channel_id)?, pid(&before)?).await;
    Ok(Page { msgs, more })
}

/// The webview already painted its optimistic copy; this only transmits.
#[tauri::command]
pub fn send_message(core: C<'_>, channel_id: String, content: String, nonce: String, t_input_ms: f64) -> Res<()> {
    let nonce: u64 = nonce.parse().map_err(|_| "bad nonce")?;
    core.send_message(pid(&channel_id)?, content, nonce, ms_to_us(t_input_ms))
}

#[tauri::command]
pub async fn edit_message(core: C<'_>, channel_id: String, id: String, content: String) -> Res<()> {
    core.request(C2S::Edit { channel_id: pid(&channel_id)?, message_id: pid(&id)?, content }).await.map(|_| ())
}

#[tauri::command]
pub async fn delete_message(core: C<'_>, channel_id: String, id: String) -> Res<()> {
    core.request(C2S::Delete { channel_id: pid(&channel_id)?, message_id: pid(&id)? }).await.map(|_| ())
}

#[tauri::command]
pub async fn create_server(core: C<'_>, name: String) -> Res<String> {
    match core.request(C2S::CreateServer { name }).await? {
        S2C::ServerJoined(s) => Ok(sid(s.id)),
        _ => Err("unexpected reply".into()),
    }
}

#[tauri::command]
pub async fn create_channel(core: C<'_>, server_id: String, name: String, voice: bool) -> Res<()> {
    let kind = if voice { ChannelKind::Voice } else { ChannelKind::Text };
    core.request(C2S::CreateChannel { server_id: pid(&server_id)?, name, kind }).await.map(|_| ())
}

#[tauri::command]
pub async fn create_invite(core: C<'_>, server_id: String) -> Res<String> {
    match core.request(C2S::CreateInvite { server_id: pid(&server_id)? }).await? {
        S2C::Invite { code, .. } => Ok(format!("hopon://invite/{code}")),
        _ => Err("unexpected reply".into()),
    }
}

#[tauri::command]
pub async fn join_invite(core: C<'_>, code: String) -> Res<String> {
    match core.request(C2S::JoinInvite { code }).await? {
        S2C::ServerJoined(s) => Ok(sid(s.id)),
        _ => Err("unexpected reply".into()),
    }
}

// ---------- profile ----------

#[tauri::command]
pub async fn avatar(core: C<'_>, user_id: String, v: u32) -> Res<Option<String>> {
    Ok(core.avatar(pid(&user_id)?, v).await)
}

/// The webview resizes to 128 px WebP before calling this.
#[tauri::command]
pub async fn set_avatar(core: C<'_>, data: Vec<u8>) -> Res<()> {
    core.request(C2S::SetAvatar { data }).await.map(|_| ())
}

// ---------- voice ----------

#[tauri::command]
pub async fn voice_prepare(core: C<'_>, channel_id: String) -> Res<()> {
    let core = core.inner().clone();
    core.voice.prepare(&core, pid(&channel_id)?).await;
    Ok(())
}

#[tauri::command]
pub async fn voice_join(core: C<'_>, channel_id: String) -> Res<()> {
    let core = core.inner().clone();
    core.voice.join(core.clone(), pid(&channel_id)?).await
}

#[tauri::command]
pub async fn voice_leave(core: C<'_>) -> Res<()> {
    let core = core.inner().clone();
    core.voice.leave(&core, true).await;
    Ok(())
}

#[tauri::command]
pub async fn voice_mute(core: C<'_>, muted: bool) -> Res<()> {
    let core = core.inner().clone();
    core.voice.set_muted(&core, muted).await;
    Ok(())
}

#[tauri::command]
pub async fn voice_deafen(core: C<'_>, deafened: bool) -> Res<()> {
    let core = core.inner().clone();
    core.voice.set_deafened(&core, deafened).await;
    Ok(())
}

#[tauri::command]
pub async fn voice_ptt(core: C<'_>, enabled: bool, key_code: u32) -> Res<()> {
    let core = core.inner().clone();
    core.voice.set_ptt(&core, enabled, key_code).await;
    core.cache.kv_set("ptt", Some(format!("{}:{key_code}", enabled as u8).into_bytes()));
    Ok(())
}

#[tauri::command]
pub fn audio_processing(core: C<'_>, aec: bool, ns: bool, agc: bool) {
    core.voice.set_processing(aec, ns, agc);
    core.cache.kv_set("apm", Some(format!("{}{}{}", aec as u8, ns as u8, agc as u8).into_bytes()));
}

#[tauri::command]
pub async fn audio_devices(core: C<'_>) -> Res<crate::voice::Devices> {
    let core = core.inner().clone();
    tokio::task::spawn_blocking(move || core.voice.devices()).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn audio_set_device(core: C<'_>, input: bool, id: Option<String>) -> Res<()> {
    core.voice.set_device(input, id.clone())?;
    core.cache.kv_set(if input { "dev_in" } else { "dev_out" }, id.map(String::into_bytes));
    Ok(())
}

// ---------- instrumentation ----------

/// Paint stamps for message keys (`id` or `p<nonce>`), batched per frame.
#[tauri::command]
pub fn perf_painted(core: C<'_>, marks: Vec<(String, f64)>) {
    let marks: Vec<(String, i64)> = marks.into_iter().map(|(k, t)| (k, ms_to_us(t))).collect();
    core.perf.painted(&marks);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfReport {
    rows: Vec<crate::perf::Row>,
    startup: Option<Startup>,
    clock_offset_ms: f64,
    best_rtt_ms: Option<f64>,
    rss_mb: Option<f64>,
    now_ms: f64,
}

#[tauri::command]
pub fn perf_stats(core: C<'_>) -> PerfReport {
    let clock = *core.clock.lock();
    PerfReport {
        rows: core.perf.rows(),
        startup: *core.perf.startup.lock(),
        clock_offset_ms: clock.offset_us as f64 / 1000.0,
        best_rtt_ms: clock.best_rtt_us().map(|r| r as f64 / 1000.0),
        rss_mb: crate::sys::working_set_mb(),
        now_ms: now_us() as f64 / 1000.0,
    }
}

#[tauri::command]
pub fn perf_reset(core: C<'_>) {
    core.perf.reset();
}
