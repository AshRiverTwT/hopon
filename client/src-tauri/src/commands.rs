//! Webview → core commands: each forwards to `hopon_core::api`, which holds
//! the logic (shared with the native shell). Only window-level commands live
//! here in full.

use crate::core::{Core, Res};
use crate::ui::*;
use hopon_core::api;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

type C<'a> = State<'a, Arc<Core>>;

#[tauri::command]
pub fn ui_subscribe(window: tauri::Window, core: C<'_>, events: Channel<UiEvent>) {
    core.attach_ui(window.label(), Box::new(crate::host::ChannelSink(events)));
}

/// Upload a file. The body is the raw bytes (no JSON encoding); the name
/// (percent-encoded) and pixel size come in headers.
#[tauri::command]
pub async fn upload_file(core: C<'_>, request: tauri::ipc::Request<'_>) -> Res<hopon_shared::Attachment> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("bad upload".into());
    };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let name = hopon_core::games::urlencoding_decode(&h("x-name"));
    api::upload_file(core.inner(), &name, data.clone(), h("x-w").parse().unwrap_or(0), h("x-h").parse().unwrap_or(0)).await
}

/// UI scale (Ctrl +/-); 1.0 = 100 %.
#[tauri::command]
pub async fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Res<()> {
    window.set_zoom(scale.clamp(0.5, 2.0)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn idle_seconds() -> Res<Option<u64>> {
    api::idle_seconds()
}

#[tauri::command]
pub fn ui_set_visibility(core: C<'_>, visible: bool) -> Res<()> {
    api::ui_set_visibility(core.inner(), visible)
}

#[tauri::command]
pub fn ui_set_context(core: C<'_>, server_id: Option<String>, joined_voice: Option<String>, viewed_voice: Option<String>) -> Res<()> {
    api::ui_set_context(core.inner(), server_id, joined_voice, viewed_voice)
}

#[tauri::command]
pub fn ui_set_visible_members(core: C<'_>, user_ids: Vec<String>) -> Res<()> {
    api::ui_set_visible_members(core.inner(), user_ids)
}

#[tauri::command]
pub fn ui_ready(core: C<'_>, t_paint_ms: f64) -> Res<()> {
    api::ui_ready(core.inner(), t_paint_ms)
}

#[tauri::command]
pub fn get_config(core: C<'_>) -> Res<api::Config> {
    api::get_config(core.inner())
}

#[tauri::command]
pub fn set_server_url(core: C<'_>, url: String) -> Res<()> {
    api::set_server_url(core.inner(), url)
}

#[tauri::command]
pub async fn signup(core: C<'_>, username: String, password: String) -> Res<()> {
    api::signup(core.inner(), username, password).await
}

#[tauri::command]
pub async fn login(core: C<'_>, username: String, password: String) -> Res<()> {
    api::login(core.inner(), username, password).await
}

#[tauri::command]
pub async fn logout(core: C<'_>) -> Res<()> {
    api::logout(core.inner()).await
}

#[tauri::command]
pub async fn open_channel(core: C<'_>, channel_id: String) -> Res<Vec<UiMsg>> {
    api::open_channel(core.inner(), channel_id).await
}

#[tauri::command]
pub async fn load_older(core: C<'_>, channel_id: String, before: String) -> Res<api::Page> {
    api::load_older(core.inner(), channel_id, before).await
}

#[tauri::command]
pub async fn load_members(core: C<'_>, server_id: String, offset: u32) -> Res<()> {
    api::load_members(core.inner(), server_id, offset).await
}

#[tauri::command]
pub async fn member_search(core: C<'_>, server_id: String, query: String) -> Res<Vec<UiUser>> {
    api::member_search(core.inner(), server_id, query).await
}

#[tauri::command]
pub async fn send_message(core: C<'_>, channel_id: String, content: String, nonce: String, t_input_ms: f64, reply_to: Option<String>, files: Option<Vec<String>>, gifs: Option<Vec<String>>) -> Res<()> {
    api::send_message(core.inner(), channel_id, content, nonce, t_input_ms, reply_to, files, gifs).await
}

#[tauri::command]
pub async fn gif_search(core: C<'_>, query: String) -> Res<api::GifResults> {
    api::gif_search(core.inner(), query).await
}

#[tauri::command]
pub fn typing(core: C<'_>, channel_id: String) -> Res<()> {
    api::typing(core.inner(), channel_id)
}

#[tauri::command]
pub async fn save_prefs(core: C<'_>, json: String) -> Res<()> {
    api::save_prefs(core.inner(), json).await
}

#[tauri::command]
pub async fn react(core: C<'_>, channel_id: String, message_id: String, emoji: String, add: bool) -> Res<()> {
    api::react(core.inner(), channel_id, message_id, emoji, add).await
}

#[tauri::command]
pub fn mark_read(core: C<'_>, channel_id: String, message_id: String) -> Res<()> {
    api::mark_read(core.inner(), channel_id, message_id)
}

#[tauri::command]
pub async fn edit_message(core: C<'_>, channel_id: String, id: String, content: String) -> Res<()> {
    api::edit_message(core.inner(), channel_id, id, content).await
}

#[tauri::command]
pub async fn delete_message(core: C<'_>, channel_id: String, id: String) -> Res<()> {
    api::delete_message(core.inner(), channel_id, id).await
}

#[tauri::command]
pub async fn create_server(core: C<'_>, name: String) -> Res<String> {
    api::create_server(core.inner(), name).await
}

#[tauri::command]
pub async fn create_channel(core: C<'_>, server_id: String, name: String, voice: bool) -> Res<()> {
    api::create_channel(core.inner(), server_id, name, voice).await
}

#[tauri::command]
pub async fn create_invite(core: C<'_>, server_id: String) -> Res<String> {
    api::create_invite(core.inner(), server_id).await
}

#[tauri::command]
pub async fn join_invite(core: C<'_>, code: String) -> Res<String> {
    api::join_invite(core.inner(), code).await
}

#[tauri::command]
pub async fn rename_server(core: C<'_>, server_id: String, name: String) -> Res<()> {
    api::rename_server(core.inner(), server_id, name).await
}

#[tauri::command]
pub async fn delete_server(core: C<'_>, server_id: String) -> Res<()> {
    api::delete_server(core.inner(), server_id).await
}

#[tauri::command]
pub async fn update_channel(core: C<'_>, channel_id: String, name: Option<String>, topic: Option<String>) -> Res<()> {
    api::update_channel(core.inner(), channel_id, name, topic).await
}

#[tauri::command]
pub async fn delete_channel(core: C<'_>, channel_id: String) -> Res<()> {
    api::delete_channel(core.inner(), channel_id).await
}

#[tauri::command]
pub async fn kick_member(core: C<'_>, server_id: String, user_id: String) -> Res<()> {
    api::kick_member(core.inner(), server_id, user_id).await
}

#[tauri::command]
pub async fn leave_server(core: C<'_>, server_id: String) -> Res<()> {
    api::leave_server(core.inner(), server_id).await
}

#[tauri::command]
pub async fn revoke_invites(core: C<'_>, server_id: String) -> Res<()> {
    api::revoke_invites(core.inner(), server_id).await
}

#[tauri::command]
pub async fn avatar(core: C<'_>, user_id: String, v: u32) -> Res<Option<String>> {
    api::avatar(core.inner(), user_id, v).await
}

#[tauri::command]
pub async fn set_avatar(core: C<'_>, data: Vec<u8>) -> Res<()> {
    api::set_avatar(core.inner(), data).await
}

#[tauri::command]
pub async fn banner(core: C<'_>, user_id: String, v: u32) -> Res<Option<String>> {
    api::banner(core.inner(), user_id, v).await
}

#[tauri::command]
pub async fn set_banner(core: C<'_>, data: Vec<u8>) -> Res<()> {
    api::set_banner(core.inner(), data).await
}

#[tauri::command]
pub async fn set_profile(core: C<'_>, bio: String, accent: u8) -> Res<()> {
    api::set_profile(core.inner(), bio, accent).await
}

#[tauri::command]
pub async fn get_profile(core: C<'_>, user_id: String, server_id: Option<String>) -> Res<UiProfile> {
    api::get_profile(core.inner(), user_id, server_id).await
}

#[tauri::command]
pub async fn set_status(core: C<'_>, mode: String, emoji: String, text: String, until: i64) -> Res<()> {
    api::set_status(core.inner(), mode, emoji, text, until).await
}

#[tauri::command]
pub async fn set_idle(core: C<'_>, idle: bool) -> Res<()> {
    api::set_idle(core.inner(), idle).await
}

#[tauri::command]
pub async fn voice_prepare(core: C<'_>, channel_id: String) -> Res<()> {
    api::voice_prepare(core.inner(), channel_id).await
}

#[tauri::command]
pub async fn voice_join(core: C<'_>, channel_id: String) -> Res<()> {
    api::voice_join(core.inner(), channel_id).await
}

#[tauri::command]
pub async fn voice_leave(core: C<'_>) -> Res<()> {
    api::voice_leave(core.inner()).await
}

#[tauri::command]
pub async fn voice_mute(core: C<'_>, muted: bool) -> Res<()> {
    api::voice_mute(core.inner(), muted).await
}

#[tauri::command]
pub async fn voice_deafen(core: C<'_>, deafened: bool) -> Res<()> {
    api::voice_deafen(core.inner(), deafened).await
}

#[tauri::command]
pub async fn voice_ptt(core: C<'_>, enabled: bool, key_code: u32) -> Res<()> {
    api::voice_ptt(core.inner(), enabled, key_code).await
}

#[tauri::command]
pub async fn screen_grant(core: C<'_>, channel_id: String) -> Res<(String, String)> {
    api::screen_grant(core.inner(), channel_id).await
}

#[tauri::command]
pub async fn media_presence(core: C<'_>, channel_id: String, source: String, active: bool) -> Res<()> {
    api::media_presence(core.inner(), channel_id, source, active).await
}

#[tauri::command]
pub async fn set_display_name(core: C<'_>, name: String) -> Res<()> {
    api::set_display_name(core.inner(), name).await
}

#[tauri::command]
pub async fn friend_request(core: C<'_>, username: String) -> Res<()> {
    api::friend_request(core.inner(), username).await
}

#[tauri::command]
pub async fn friend_respond(core: C<'_>, user_id: String, accept: bool) -> Res<()> {
    api::friend_respond(core.inner(), user_id, accept).await
}

#[tauri::command]
pub async fn friend_remove(core: C<'_>, user_id: String) -> Res<()> {
    api::friend_remove(core.inner(), user_id).await
}

#[tauri::command]
pub fn activity_sharing(core: C<'_>, enabled: bool) -> Res<()> {
    api::activity_sharing(core.inner(), enabled)
}

#[tauri::command]
pub async fn voice_volume(core: C<'_>, user_id: String, volume: f64) -> Res<()> {
    api::voice_volume(core.inner(), user_id, volume).await
}

#[tauri::command]
pub fn audio_processing(core: C<'_>, aec: bool, ns: bool, agc: bool) -> Res<()> {
    api::audio_processing(core.inner(), aec, ns, agc)
}

#[tauri::command]
pub async fn audio_devices(core: C<'_>) -> Res<crate::voice::Devices> {
    api::audio_devices(core.inner()).await
}

#[tauri::command]
pub fn audio_set_device(core: C<'_>, input: bool, id: Option<String>) -> Res<()> {
    api::audio_set_device(core.inner(), input, id)
}

#[tauri::command]
pub fn perf_painted(core: C<'_>, marks: Vec<(String, f64)>) -> Res<()> {
    api::perf_painted(core.inner(), marks)
}

#[tauri::command]
pub fn perf_stats(core: C<'_>) -> Res<api::PerfReport> {
    api::perf_stats(core.inner())
}

#[tauri::command]
pub fn perf_reset(core: C<'_>) -> Res<()> {
    api::perf_reset(core.inner())
}
