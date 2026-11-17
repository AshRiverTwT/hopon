//! Every UI → core command, independent of the UI toolkit.
//!
//! Two ways in:
//! - typed functions (the Tauri shell wraps each one as a `#[tauri::command]`);
//! - [`call`]: by name, with camelCase JSON arguments and a JSON result. This
//!   is what the native shell uses through the C ABI (`hopon-ffi`). Names and
//!   argument names match the webview's `invoke` calls, so `client/ui/src/ipc.ts`
//!   documents both.
//!
//! Window-level commands (zoom, fullscreen, tray, notifications, overlay
//! window, game webview) are not here: each shell implements those itself.

use crate::core::{Core, Res};
use crate::perf::Startup;
use crate::ui::*;
use hopon_shared::time::now_us;
use hopon_shared::{ChannelKind, MediaSource, C2S, S2C};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

fn ms_to_us(ms: f64) -> i64 {
    (ms * 1000.0) as i64
}

// ---------- UI state ----------

pub fn ui_set_visibility(core: &Arc<Core>, visible: bool) -> Res<()> {
    core.set_ui_visible(visible);
    Ok(())
}

pub fn ui_set_context(
    core: &Arc<Core>,
    server_id: Option<String>,
    joined_voice: Option<String>,
    viewed_voice: Option<String>,
) -> Res<()> {
    core.set_ui_context(
        server_id.as_deref().map(pid).transpose()?,
        joined_voice.as_deref().map(pid).transpose()?,
        viewed_voice.as_deref().map(pid).transpose()?,
    );
    Ok(())
}

pub fn ui_set_visible_members(core: &Arc<Core>, user_ids: Vec<String>) -> Res<()> {
    let ids = user_ids.iter().map(|id| pid(id)).collect::<Result<std::collections::HashSet<_>, _>>()?;
    core.set_visible_members(ids);
    Ok(())
}

/// First frame painted (`t_paint_ms`: Unix ms): record cold-start timings.
/// With `--perf-exit` (scripted measurement) the app then exits.
pub fn ui_ready(core: &Arc<Core>, t_paint_ms: f64) -> Res<()> {
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
        if let Some(host) = core.host.get() {
            host.exit(0);
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    url: String,
    /// Tests only (HOPON_TEST_OPEN_GAMES): open the games panel on start.
    test_open_games: bool,
}

pub fn get_config(core: &Arc<Core>) -> Res<Config> {
    Ok(Config {
        url: core.url.lock().clone(),
        test_open_games: std::env::var("HOPON_TEST_OPEN_GAMES").is_ok(),
    })
}

// ---------- account ----------

pub fn set_server_url(core: &Arc<Core>, url: String) -> Res<()> {
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

pub async fn signup(core: &Arc<Core>, username: String, password: String) -> Res<()> {
    core.request(C2S::Signup { username, password }).await.map(|_| ())
}

pub async fn login(core: &Arc<Core>, username: String, password: String) -> Res<()> {
    core.request(C2S::Login { username, password }).await.map(|_| ())
}

pub async fn logout(core: &Arc<Core>) -> Res<()> {
    core.voice.leave(core, true).await;
    let refresh_token = core.store.lock().refresh_token.clone().unwrap_or_default();
    // Logged out locally even if the server is unreachable.
    let _ = core.request(C2S::Logout { refresh_token }).await;
    *core.store.lock() = Default::default();
    core.cache.kv_set("refresh", None);
    let ev = core.session_snapshot();
    core.emit(ev);
    Ok(())
}

// ---------- messages ----------

pub async fn open_channel(core: &Arc<Core>, channel_id: String) -> Res<Vec<UiMsg>> {
    let ch = pid(&channel_id)?;
    Ok(core.open_channel(ch).await)
}

#[derive(Serialize)]
pub struct Page {
    msgs: Vec<UiMsg>,
    more: bool,
}

pub async fn load_older(core: &Arc<Core>, channel_id: String, before: String) -> Res<Page> {
    let (msgs, more) = core.load_older(pid(&channel_id)?, pid(&before)?).await;
    Ok(Page { msgs, more })
}

pub async fn load_members(core: &Arc<Core>, server_id: String, offset: u32) -> Res<()> {
    match core.request(C2S::Members { server_id: pid(&server_id)?, offset, limit: 100 }).await? {
        S2C::Members { .. } => Ok(()),
        _ => Err("unexpected reply".into()),
    }
}

pub async fn member_search(core: &Arc<Core>, server_id: String, query: String) -> Res<Vec<UiUser>> {
    core.member_search(pid(&server_id)?, query).await
}

/// The UI already painted its optimistic copy; this only transmits.
#[allow(clippy::too_many_arguments)]
pub async fn send_message(
    core: &Arc<Core>,
    channel_id: String,
    content: String,
    nonce: String,
    t_input_ms: f64,
    reply_to: Option<String>,
    files: Option<Vec<String>>,
    gifs: Option<Vec<String>>,
) -> Res<()> {
    let nonce: u64 = nonce.parse().map_err(|_| "bad nonce")?;
    let reply_to = reply_to.as_deref().map(pid).transpose()?;
    core.send_message(
        pid(&channel_id)?,
        content,
        nonce,
        ms_to_us(t_input_ms),
        reply_to,
        files.unwrap_or_default(),
        gifs.unwrap_or_default(),
    )
    .await
}

/// Upload a file (raw bytes); `w`/`h`: pixel size for images and videos, else 0.
pub async fn upload_file(core: &Arc<Core>, name: &str, data: Vec<u8>, w: u32, h: u32) -> Res<hopon_shared::Attachment> {
    core.upload(if name.is_empty() { "file" } else { name }, data, w, h).await
}

#[derive(Serialize)]
pub struct GifResults {
    enabled: bool,
    results: Vec<hopon_shared::Gif>,
}

pub async fn gif_search(core: &Arc<Core>, query: String) -> Res<GifResults> {
    let (enabled, results) = core.gif_search(query).await?;
    Ok(GifResults { enabled, results })
}

/// Fire-and-forget typing signal (the UI throttles to one per 3 s).
pub fn typing(core: &Arc<Core>, channel_id: String) -> Res<()> {
    core.send_frame(0, C2S::Typing { channel_id: pid(&channel_id)? });
    Ok(())
}

pub async fn save_prefs(core: &Arc<Core>, json: String) -> Res<()> {
    core.request(C2S::SavePrefs { json }).await.map(|_| ())
}

pub async fn react(core: &Arc<Core>, channel_id: String, message_id: String, emoji: String, add: bool) -> Res<()> {
    core.request(C2S::React { channel_id: pid(&channel_id)?, message_id: pid(&message_id)?, emoji, add })
        .await
        .map(|_| ())
}

pub fn mark_read(core: &Arc<Core>, channel_id: String, message_id: String) -> Res<()> {
    core.mark_read(pid(&channel_id)?, pid(&message_id)?);
    Ok(())
}

pub async fn edit_message(core: &Arc<Core>, channel_id: String, id: String, content: String) -> Res<()> {
    core.request(C2S::Edit { channel_id: pid(&channel_id)?, message_id: pid(&id)?, content }).await.map(|_| ())
}

pub async fn delete_message(core: &Arc<Core>, channel_id: String, id: String) -> Res<()> {
    core.request(C2S::Delete { channel_id: pid(&channel_id)?, message_id: pid(&id)? }).await.map(|_| ())
}

// ---------- servers and channels ----------

pub async fn create_server(core: &Arc<Core>, name: String) -> Res<String> {
    match core.request(C2S::CreateServer { name }).await? {
        S2C::ServerJoined(s) => Ok(sid(s.id)),
        _ => Err("unexpected reply".into()),
    }
}

pub async fn create_channel(core: &Arc<Core>, server_id: String, name: String, voice: bool) -> Res<()> {
    let kind = if voice { ChannelKind::Voice } else { ChannelKind::Text };
    core.request(C2S::CreateChannel { server_id: pid(&server_id)?, name, kind }).await.map(|_| ())
}

pub async fn create_invite(core: &Arc<Core>, server_id: String) -> Res<String> {
    match core.request(C2S::CreateInvite { server_id: pid(&server_id)? }).await? {
        S2C::Invite { code, .. } => Ok(format!("hopon://invite/{code}")),
        _ => Err("unexpected reply".into()),
    }
}

pub async fn join_invite(core: &Arc<Core>, code: String) -> Res<String> {
    match core.request(C2S::JoinInvite { code }).await? {
        S2C::ServerJoined(s) => Ok(sid(s.id)),
        _ => Err("unexpected reply".into()),
    }
}

pub async fn rename_server(core: &Arc<Core>, server_id: String, name: String) -> Res<()> {
    core.request(C2S::RenameServer { server_id: pid(&server_id)?, name }).await.map(|_| ())
}

pub async fn delete_server(core: &Arc<Core>, server_id: String) -> Res<()> {
    core.request(C2S::DeleteServer { server_id: pid(&server_id)? }).await.map(|_| ())
}

pub async fn update_channel(core: &Arc<Core>, channel_id: String, name: Option<String>, topic: Option<String>) -> Res<()> {
    core.request(C2S::UpdateChannel { channel_id: pid(&channel_id)?, name, topic }).await.map(|_| ())
}

pub async fn delete_channel(core: &Arc<Core>, channel_id: String) -> Res<()> {
    core.request(C2S::DeleteChannel { channel_id: pid(&channel_id)? }).await.map(|_| ())
}

pub async fn kick_member(core: &Arc<Core>, server_id: String, user_id: String) -> Res<()> {
    core.request(C2S::Kick { server_id: pid(&server_id)?, user_id: pid(&user_id)? }).await.map(|_| ())
}

pub async fn leave_server(core: &Arc<Core>, server_id: String) -> Res<()> {
    core.request(C2S::LeaveServer { server_id: pid(&server_id)? }).await.map(|_| ())
}

pub async fn revoke_invites(core: &Arc<Core>, server_id: String) -> Res<()> {
    core.request(C2S::RevokeInvites { server_id: pid(&server_id)? }).await.map(|_| ())
}

// ---------- profile ----------

pub async fn avatar(core: &Arc<Core>, user_id: String, v: u32) -> Res<Option<String>> {
    Ok(core.avatar(pid(&user_id)?, v).await)
}

/// 128 px WebP, resized by the UI.
pub async fn set_avatar(core: &Arc<Core>, data: Vec<u8>) -> Res<()> {
    core.request(C2S::SetAvatar { data }).await.map(|_| ())
}

pub async fn banner(core: &Arc<Core>, user_id: String, v: u32) -> Res<Option<String>> {
    Ok(core.banner(pid(&user_id)?, v).await)
}

/// 600 × 200 WebP, resized by the UI. Empty removes it.
pub async fn set_banner(core: &Arc<Core>, data: Vec<u8>) -> Res<()> {
    core.request(C2S::SetBanner { data }).await.map(|_| ())
}

pub async fn set_profile(core: &Arc<Core>, bio: String, accent: u8) -> Res<()> {
    core.request(C2S::SetProfile { bio, accent }).await.map(|_| ())
}

/// Someone's profile card (`server_id` adds when they joined it).
pub async fn get_profile(core: &Arc<Core>, user_id: String, server_id: Option<String>) -> Res<UiProfile> {
    let server_id = server_id.as_deref().map(pid).transpose()?;
    match core.request(C2S::GetProfile { user_id: pid(&user_id)?, server_id }).await? {
        S2C::Profile(p) => Ok(UiProfile {
            user: (&p.user).into(),
            username: p.username,
            bio: p.bio,
            banner_v: p.banner_v,
            created_at: p.created_at,
            joined_at: p.joined_at,
        }),
        _ => Err("unexpected reply".into()),
    }
}

/// Presence ("online" | "dnd" | "invisible") and custom status.
pub async fn set_status(core: &Arc<Core>, mode: String, emoji: String, text: String, until: i64) -> Res<()> {
    let status = hopon_shared::UserStatus { mode: mode_of(&mode), emoji, text, until };
    core.request(C2S::SetStatus { status }).await.map(|_| ())
}

/// This device is idle (no input for a while) or back.
pub async fn set_idle(core: &Arc<Core>, idle: bool) -> Res<()> {
    core.request(C2S::SetIdle { idle }).await.map(|_| ())
}

/// Seconds since the last keyboard or mouse input anywhere on the system, where
/// the OS tells us (Windows). None: the UI tracks its own input instead.
pub fn idle_seconds() -> Res<Option<u64>> {
    Ok(crate::sys::idle_seconds())
}

pub async fn set_display_name(core: &Arc<Core>, name: String) -> Res<()> {
    core.request(C2S::SetDisplayName { name }).await.map(|_| ())
}

/// Add a friend by their unique username.
pub async fn friend_request(core: &Arc<Core>, username: String) -> Res<()> {
    core.request(C2S::FriendRequest { username }).await.map(|_| ())
}

pub async fn friend_respond(core: &Arc<Core>, user_id: String, accept: bool) -> Res<()> {
    core.request(C2S::FriendRespond { user_id: pid(&user_id)?, accept }).await.map(|_| ())
}

/// Unfriend, cancel your request or decline theirs.
pub async fn friend_remove(core: &Arc<Core>, user_id: String) -> Res<()> {
    core.request(C2S::FriendRemove { user_id: pid(&user_id)? }).await.map(|_| ())
}

/// Settings → "Show what I'm playing".
pub fn activity_sharing(core: &Arc<Core>, enabled: bool) -> Res<()> {
    crate::activity::Activity::set_enabled(core.clone(), enabled);
    Ok(())
}

// ---------- voice ----------

pub async fn voice_prepare(core: &Arc<Core>, channel_id: String) -> Res<()> {
    core.voice.prepare(core, pid(&channel_id)?).await;
    Ok(())
}

pub async fn voice_join(core: &Arc<Core>, channel_id: String) -> Res<()> {
    core.voice.join(core.clone(), pid(&channel_id)?).await
}

pub async fn voice_leave(core: &Arc<Core>) -> Res<()> {
    core.voice.leave(core, true).await;
    Ok(())
}

pub async fn voice_mute(core: &Arc<Core>, muted: bool) -> Res<()> {
    core.voice.set_muted(core, muted).await;
    Ok(())
}

pub async fn voice_deafen(core: &Arc<Core>, deafened: bool) -> Res<()> {
    core.voice.set_deafened(core, deafened).await;
    Ok(())
}

pub async fn voice_ptt(core: &Arc<Core>, enabled: bool, key_code: u32) -> Res<()> {
    core.voice.set_ptt(core, enabled, key_code).await;
    core.cache.kv_set("ptt", Some(format!("{}:{key_code}", enabled as u8).into_bytes()));
    Ok(())
}

/// One person's voice volume, 0.0 – 2.0 (1.0 = normal).
pub async fn voice_volume(core: &Arc<Core>, user_id: String, volume: f64) -> Res<()> {
    core.voice.set_volume(user_id, volume).await;
    Ok(())
}

/// Token for the UI's screen-share connection to the voice room you're in: (url, token).
pub async fn screen_grant(core: &Arc<Core>, channel_id: String) -> Res<(String, String)> {
    match core.request(C2S::ScreenGrant { channel_id: pid(&channel_id)? }).await? {
        S2C::VoiceGrant { url, token, .. } => Ok((url, token)),
        _ => Err("unexpected reply".into()),
    }
}

/// Screens and windows you can share (native shell).
pub async fn screen_sources(_core: &Arc<Core>) -> Res<Vec<crate::voice::Source>> {
    tokio::task::spawn_blocking(crate::voice::screen::sources).await.map_err(|e| e.to_string())
}

/// Share a screen or window (`source` from screen_sources) in your voice room.
/// `quality`: "720p30" | "720p60" | "1080p60" | "1440p60".
pub async fn screen_share(core: &Arc<Core>, source: String, quality: String) -> Res<()> {
    core.voice.screen.share(core, &source, &quality).await
}

pub async fn screen_stop(core: &Arc<Core>) -> Res<()> {
    core.voice.screen.stop_share(core).await
}

pub async fn screen_watch(core: &Arc<Core>, user_id: String) -> Res<()> {
    core.voice.screen.watch(core, user_id).await
}

pub async fn screen_unwatch(core: &Arc<Core>, user_id: String) -> Res<()> {
    core.voice.screen.unwatch(core, &user_id).await;
    Ok(())
}

/// Stream sound volume for one sharer, 0.0 – 2.0.
pub async fn screen_volume(core: &Arc<Core>, user_id: String, volume: f64) -> Res<()> {
    core.voice.screen.set_volume(user_id, volume).await;
    Ok(())
}

pub async fn media_presence(core: &Arc<Core>, channel_id: String, source: String, active: bool) -> Res<()> {
    let source = match source.as_str() {
        "screen" => MediaSource::Screen,
        "camera" => MediaSource::Camera,
        _ => return Err("unknown video source".into()),
    };
    match core.request(C2S::MediaState { channel_id: pid(&channel_id)?, source, active }).await? {
        S2C::Ok => Ok(()),
        _ => Err("unexpected reply".into()),
    }
}

pub fn audio_processing(core: &Arc<Core>, aec: bool, ns: bool, agc: bool) -> Res<()> {
    core.voice.set_processing(aec, ns, agc);
    core.cache.kv_set("apm", Some(format!("{}{}{}", aec as u8, ns as u8, agc as u8).into_bytes()));
    Ok(())
}

pub async fn audio_devices(core: &Arc<Core>) -> Res<crate::voice::Devices> {
    let core = core.clone();
    tokio::task::spawn_blocking(move || core.voice.devices()).await.map_err(|e| e.to_string())?
}

pub fn audio_set_device(core: &Arc<Core>, input: bool, id: Option<String>) -> Res<()> {
    core.voice.set_device(input, id.clone())?;
    core.cache.kv_set(if input { "dev_in" } else { "dev_out" }, id.map(String::into_bytes));
    Ok(())
}

// ---------- games, links, updates ----------

/// The server whose `general` receives game results follows the UI selection.
pub fn games_server(core: &Arc<Core>, server_id: String) -> Res<()> {
    *core.games.server.lock() = Some(pid(&server_id)?);
    Ok(())
}

/// The game panel opened `game` for `server_id`: returns the URL its webview loads.
pub fn games_select(core: &Arc<Core>, game: String, server_id: String) -> Res<String> {
    let g = crate::games::GAMES.iter().find(|g| g.id == game).ok_or("unknown game")?;
    *core.games.server.lock() = Some(pid(&server_id)?);
    *core.games.game.lock() = Some(g.id);
    Ok(crate::games::url_for(g))
}

/// The game panel closed.
pub fn games_deselect(core: &Arc<Core>) -> Res<()> {
    *core.games.game.lock() = None;
    Ok(())
}

/// The game webview reported shared text (its title became `HOPON_RESULT:<encoded>`):
/// `encoded` is the part after the prefix. Validated, then posted to `general`.
pub fn games_result(core: &Arc<Core>, encoded: String) -> Res<()> {
    let raw = crate::games::urlencoding_decode(&encoded);
    let game = core.games.game.lock().unwrap_or("");
    crate::rt::spawn(crate::games::post_result(core.clone(), game, raw));
    Ok(())
}

/// Open the current game's site in the system browser (fixed URLs only).
pub fn games_open_external(game: String) -> Res<()> {
    crate::games::open_external(&game)
}

/// Open an http(s) link in the system browser; anything else is refused.
pub fn open_url(url: String) -> Res<()> {
    crate::games::open_in_browser(&url)
}

pub async fn update_check(core: &Arc<Core>) -> Res<crate::update::UpdateInfo> {
    crate::update::check(core).await
}

pub async fn update_install(core: &Arc<Core>) -> Res<()> {
    crate::update::install(core).await
}

// ---------- overlay ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayContext {
    /// The text channel open in the main window.
    channel_id: Option<String>,
    msgs: Vec<UiMsg>,
}

/// What the overlay shows when it opens: the open channel's last 30 messages.
pub fn overlay_context(core: &Arc<Core>) -> Res<OverlayContext> {
    let s = core.store.lock();
    let Some(ch) = s.open_channel else { return Ok(OverlayContext { channel_id: None, msgs: vec![] }) };
    let msgs = s.recent.get(&ch).map(|q| q.iter().rev().take(30).rev().map(|m| UiMsg::from_msg(m, 2)).collect()).unwrap_or_default();
    Ok(OverlayContext { channel_id: Some(ch.to_string()), msgs })
}

// ---------- instrumentation ----------

/// Paint stamps (Unix ms) for message keys (`id` or `p<nonce>`), batched per frame.
pub fn perf_painted(core: &Arc<Core>, marks: Vec<(String, f64)>) -> Res<()> {
    let marks: Vec<(String, i64)> = marks.into_iter().map(|(k, t)| (k, ms_to_us(t))).collect();
    core.perf.painted(&marks);
    Ok(())
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

pub fn perf_stats(core: &Arc<Core>) -> Res<PerfReport> {
    let clock = *core.clock.lock();
    Ok(PerfReport {
        rows: core.perf.rows(),
        startup: *core.perf.startup.lock(),
        clock_offset_ms: clock.offset_us as f64 / 1000.0,
        best_rtt_ms: clock.best_rtt_us().map(|r| r as f64 / 1000.0),
        rss_mb: crate::sys::working_set_mb(),
        now_ms: now_us() as f64 / 1000.0,
    })
}

pub fn perf_reset(core: &Arc<Core>) -> Res<()> {
    core.perf.reset();
    Ok(())
}

// ---------- by name ----------

fn out<T: Serialize>(r: Res<T>) -> Res<Value> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Parse a command's arguments: an object with camelCase keys (missing
/// `Option`s are `None`; `null` or an empty input means no arguments).
fn args<T: serde::de::DeserializeOwned>(name: &str, v: Value) -> Res<T> {
    let v = if v.is_null() { Value::Object(Default::default()) } else { v };
    serde_json::from_value(v).map_err(|e| format!("{name}: bad arguments: {e}"))
}

macro_rules! dispatch {
    ($core:ident, $name:ident, $v:ident; $( $kind:ident $cmd:ident ( $($a:ident : $t:ty),* ) ),* $(,)?) => {
        match $name {
            $( stringify!($cmd) => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                #[allow(dead_code)]
                struct A { $( $a: $t ),* }
                #[allow(unused_variables)]
                let a: A = args($name, $v)?;
                out(dispatch!(@call $kind $cmd $core a ( $($a),* )))
            } )*
            _ => Err(format!("unknown command {}", $name)),
        }
    };
    (@call async $cmd:ident $core:ident $a:ident ( $($f:ident),* )) => { $cmd($core $(, $a.$f)*).await };
    (@call sync $cmd:ident $core:ident $a:ident ( $($f:ident),* )) => { $cmd($core $(, $a.$f)*) };
    (@call free $cmd:ident $core:ident $a:ident ( $($f:ident),* )) => { $cmd($($a.$f),*) };
}

/// Run a command by name. `args`: JSON object (camelCase keys). `blob`: raw
/// bytes for the commands that carry a file or image: `upload_file` (with
/// `{name, w, h}`), `set_avatar`, `set_banner`.
pub async fn call(core: &Arc<Core>, name: &str, args_json: Value, blob: Option<Vec<u8>>) -> Res<Value> {
    let v = args_json;
    match name {
        "upload_file" => {
            #[derive(serde::Deserialize)]
            struct A {
                #[serde(default)]
                name: String,
                #[serde(default)]
                w: u32,
                #[serde(default)]
                h: u32,
            }
            let a: A = args(name, v)?;
            let data = blob.ok_or("upload_file: no file data")?;
            return out(upload_file(core, &a.name, data, a.w, a.h).await);
        }
        "set_avatar" => return out(set_avatar(core, blob.unwrap_or_default()).await),
        "set_banner" => return out(set_banner(core, blob.unwrap_or_default()).await),
        _ => {}
    }
    dispatch! { core, name, v;
        sync ui_set_visibility(visible: bool),
        sync ui_set_context(server_id: Option<String>, joined_voice: Option<String>, viewed_voice: Option<String>),
        sync ui_set_visible_members(user_ids: Vec<String>),
        sync ui_ready(t_paint_ms: f64),
        sync get_config(),
        sync set_server_url(url: String),
        async signup(username: String, password: String),
        async login(username: String, password: String),
        async logout(),
        async open_channel(channel_id: String),
        async load_older(channel_id: String, before: String),
        async load_members(server_id: String, offset: u32),
        async member_search(server_id: String, query: String),
        async send_message(channel_id: String, content: String, nonce: String, t_input_ms: f64,
            reply_to: Option<String>, files: Option<Vec<String>>, gifs: Option<Vec<String>>),
        async gif_search(query: String),
        sync typing(channel_id: String),
        async save_prefs(json: String),
        async react(channel_id: String, message_id: String, emoji: String, add: bool),
        sync mark_read(channel_id: String, message_id: String),
        async edit_message(channel_id: String, id: String, content: String),
        async delete_message(channel_id: String, id: String),
        async create_server(name: String),
        async create_channel(server_id: String, name: String, voice: bool),
        async create_invite(server_id: String),
        async join_invite(code: String),
        async rename_server(server_id: String, name: String),
        async delete_server(server_id: String),
        async update_channel(channel_id: String, name: Option<String>, topic: Option<String>),
        async delete_channel(channel_id: String),
        async kick_member(server_id: String, user_id: String),
        async leave_server(server_id: String),
        async revoke_invites(server_id: String),
        async avatar(user_id: String, v: u32),
        async banner(user_id: String, v: u32),
        async set_profile(bio: String, accent: u8),
        async get_profile(user_id: String, server_id: Option<String>),
        async set_status(mode: String, emoji: String, text: String, until: i64),
        async set_idle(idle: bool),
        free idle_seconds(),
        async set_display_name(name: String),
        async friend_request(username: String),
        async friend_respond(user_id: String, accept: bool),
        async friend_remove(user_id: String),
        sync activity_sharing(enabled: bool),
        async voice_prepare(channel_id: String),
        async voice_join(channel_id: String),
        async voice_leave(),
        async voice_mute(muted: bool),
        async voice_deafen(deafened: bool),
        async voice_ptt(enabled: bool, key_code: u32),
        async voice_volume(user_id: String, volume: f64),
        async screen_grant(channel_id: String),
        async media_presence(channel_id: String, source: String, active: bool),
        async screen_sources(),
        async screen_share(source: String, quality: String),
        async screen_stop(),
        async screen_watch(user_id: String),
        async screen_unwatch(user_id: String),
        async screen_volume(user_id: String, volume: f64),
        sync audio_processing(aec: bool, ns: bool, agc: bool),
        async audio_devices(),
        sync audio_set_device(input: bool, id: Option<String>),
        sync games_server(server_id: String),
        sync games_select(game: String, server_id: String),
        sync games_deselect(),
        sync games_result(encoded: String),
        free games_open_external(game: String),
        free open_url(url: String),
        async update_check(),
        async update_install(),
        sync overlay_context(),
        sync perf_painted(marks: Vec<(String, f64)>),
        sync perf_stats(),
        sync perf_reset(),
    }
}

/// Every command [`call`] accepts (tests, and the C# wrapper generator).
pub const COMMANDS: &[&str] = &[
    "ui_set_visibility", "ui_set_context", "ui_set_visible_members", "ui_ready", "get_config",
    "set_server_url", "signup", "login", "logout", "open_channel", "load_older", "load_members",
    "member_search", "send_message", "upload_file", "gif_search", "typing", "save_prefs", "react",
    "mark_read", "edit_message", "delete_message", "create_server", "create_channel", "create_invite",
    "join_invite", "rename_server", "delete_server", "update_channel", "delete_channel", "kick_member",
    "leave_server", "revoke_invites", "avatar", "set_avatar", "banner", "set_banner", "set_profile",
    "get_profile", "set_status", "set_idle", "idle_seconds", "set_display_name", "friend_request",
    "friend_respond", "friend_remove", "activity_sharing", "voice_prepare", "voice_join", "voice_leave",
    "voice_mute", "voice_deafen", "voice_ptt", "voice_volume", "screen_grant", "media_presence",
    "screen_sources", "screen_share", "screen_stop", "screen_watch", "screen_unwatch", "screen_volume",
    "audio_processing", "audio_devices", "audio_set_device", "games_server", "games_select",
    "games_deselect", "games_result", "games_open_external", "open_url", "update_check",
    "update_install", "overlay_context", "perf_painted", "perf_stats", "perf_reset",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> Arc<Core> {
        Core::new(crate::cache::Cache::open_in_memory().unwrap(), "ws://127.0.0.1:1/ws".into())
    }

    /// Every listed command is dispatched (none falls through to "unknown").
    #[test]
    fn every_command_is_routed() {
        let c = core();
        crate::rt::block_on(async {
            for name in COMMANDS {
                // Wrong (empty) arguments: either an argument error or a real
                // result, never "unknown command". Skip ones with side effects
                // outside the process (browser, installer, network waits).
                if matches!(*name, "games_open_external" | "open_url" | "update_check" | "update_install") {
                    continue;
                }
                let r = tokio::time::timeout(std::time::Duration::from_millis(200), call(&c, name, Value::Null, None)).await;
                if let Ok(Err(e)) = r {
                    assert!(!e.starts_with("unknown command"), "{name} is not routed");
                }
            }
            assert!(call(&c, "nope", Value::Null, None).await.unwrap_err().starts_with("unknown command"));
        });
    }

    #[test]
    fn args_are_camel_case() {
        let c = core();
        crate::rt::block_on(async {
            let cfg = call(&c, "get_config", Value::Null, None).await.unwrap();
            assert_eq!(cfg["url"], "ws://127.0.0.1:1/ws");
            assert!(call(&c, "set_server_url", serde_json::json!({"url": "http://x"}), None).await.unwrap_err().contains("ws://"));
            let e = call(&c, "mark_read", serde_json::json!({"channel_id": "1"}), None).await.unwrap_err();
            assert!(e.contains("bad arguments"), "{e}");
            call(&c, "ui_set_context", serde_json::json!({"serverId": "5"}), None).await.unwrap();
        });
    }
}
