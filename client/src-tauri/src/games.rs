//! Games side panel: a child webview (not an iframe, so X-Frame-Options does
//! not apply) showing the game's real website. It exists only while the panel
//! is open, so idle RAM is unaffected.
//!
//! Security: the game webview has NO IPC — its label is in no capability. An
//! initialization script hooks the share paths (navigator.share, clipboard
//! writeText/write, execCommand('copy')) and reports the shared text by
//! briefly setting `document.title` to `HOPON_RESULT:<urlencoded text>`. Rust
//! sees the title change, validates the text against the game's pattern,
//! collapses duplicate events from one click, and posts it to the server's `general` channel. Page scripts (ads
//! included) can fake this channel, so validation is strict and the worst case
//! is a plausible-looking score message in your own name (and the server's
//! per-connection send rate limit still applies).

use crate::core::{Core, Res};
use crate::ui::pid;
use hopon_core::games::{post_result, url_for, urlencoding_decode, GAMES, HOOK};
use std::sync::Arc;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

const LABEL: &str = "games";

// These must be async: a sync command runs on the main thread, and creating
// or resizing a child webview from it deadlocks WebView2 on Windows.
#[tauri::command]
pub async fn games_open(app: tauri::AppHandle, core: tauri::State<'_, Arc<Core>>, game: String, server_id: String, x: f64, y: f64, w: f64, h: f64) -> Res<()> {
    let g = GAMES.iter().find(|g| g.id == game).ok_or("unknown game")?;
    *core.games.server.lock() = Some(pid(&server_id)?);
    let url: tauri::Url = url_for(g).parse().map_err(|e| format!("{e}"))?;
    if let Some(wv) = app.get_webview(LABEL) {
        if *core.games.game.lock() != Some(g.id) {
            wv.navigate(url).map_err(|e| e.to_string())?;
        }
        *core.games.game.lock() = Some(g.id);
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    *core.games.game.lock() = Some(g.id);
    let window = app.get_window("main").ok_or("no main window")?;
    let c = core.inner().clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .initialization_script_for_all_frames(HOOK)
        // Ads must not open windows; the game itself never needs one.
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_document_title_changed(move |_, title| {
            if let Some(enc) = title.strip_prefix("HOPON_RESULT:") {
                let raw = urlencoding_decode(enc);
                let game = c.games.game.lock().unwrap_or("");
                let c2 = c.clone();
                tauri::async_runtime::spawn(post_result(c2, game, raw));
            }
        });
    window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    Ok(())
}

/// The server whose `general` receives results follows the UI selection.
#[tauri::command]
pub fn games_server(core: tauri::State<'_, Arc<Core>>, server_id: String) -> Res<()> {
    *core.games.server.lock() = Some(pid(&server_id)?);
    Ok(())
}

#[tauri::command]
pub async fn games_bounds(app: tauri::AppHandle, x: f64, y: f64, w: f64, h: f64) -> Res<()> {
    if let Some(wv) = app.get_webview(LABEL) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Native webviews draw above the app's UI, so hide the game while a sheet or
/// overlay is open.
#[tauri::command]
pub async fn games_visible(app: tauri::AppHandle, visible: bool) -> Res<()> {
    if let Some(wv) = app.get_webview(LABEL) {
        if visible { wv.show() } else { wv.hide() }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Destroy the webview: its renderer process and memory go with it.
#[tauri::command]
pub async fn games_close(app: tauri::AppHandle, core: tauri::State<'_, Arc<Core>>) -> Res<()> {
    *core.games.game.lock() = None;
    if let Some(wv) = app.get_webview(LABEL) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open the current game's site in the system browser (fixed URLs only).
#[tauri::command]
pub fn games_open_external(game: String) -> Res<()> {
    hopon_core::games::open_external(&game)
}

#[tauri::command]
pub fn open_url(url: String) -> Res<()> {
    hopon_core::games::open_in_browser(&url)
}

