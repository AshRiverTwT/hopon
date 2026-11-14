//! Windows notifications ("toasts") for new messages while HopOn is in the
//! background or in the tray. The webview decides *whether* to notify (per
//! channel settings, focus); this only shows the toast. Clicking it brings
//! the window back and opens the channel.

use crate::core::Core;
use std::sync::Arc;

#[tauri::command]
pub fn notify(app: tauri::AppHandle, core: tauri::State<'_, Arc<Core>>, title: String, body: String, sound: bool, channel_id: Option<String>) {
    let title: String = title.chars().take(120).collect();
    let body: String = body.chars().take(300).collect();
    show(&app, core.inner().clone(), &title, &body, sound, channel_id);
    core.attention();
}

#[cfg(windows)]
fn show(app: &tauri::AppHandle, core: Arc<Core>, title: &str, body: &str, sound: bool, channel_id: Option<String>) {
    use tauri::Manager;
    use tauri_winrt_notification::{Sound, Toast};
    // Installed builds are registered under the bundle identifier (the NSIS
    // shortcut carries it); dev builds borrow PowerShell's so toasts show.
    let id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_owned() } else { app.config().identifier.clone() };
    let app = app.clone();
    let res = Toast::new(&id)
        .title(title)
        .text1(body)
        .sound(if sound { Some(Sound::Default) } else { None })
        .on_activated(move |_| {
            crate::tray::show_main(&app);
            if let Some(c) = channel_id.clone() {
                core.emit(crate::ui::UiEvent::OpenChannel { channel_id: c });
            }
            Ok(())
        })
        .show();
    if let Err(e) = res {
        tracing::debug!("toast failed: {e}");
    }
}

/// Linux: a desktop notification (D-Bus); clicking it opens the channel.
#[cfg(target_os = "linux")]
fn show(app: &tauri::AppHandle, core: Arc<Core>, title: &str, body: &str, sound: bool, channel_id: Option<String>) {
    let (app, title, body) = (app.clone(), title.to_owned(), body.to_owned());
    std::thread::spawn(move || {
        let mut n = notify_rust::Notification::new();
        n.summary(&title).body(&body).appname("HopOn").icon("hopon").action("default", "Open");
        if sound {
            n.sound_name("message-new-instant");
        }
        match n.show() {
            Ok(handle) => handle.wait_for_action(|action| {
                if action == "default" {
                    crate::tray::show_main(&app);
                    if let Some(c) = channel_id.clone() {
                        core.emit(crate::ui::UiEvent::OpenChannel { channel_id: c });
                    }
                }
            }),
            Err(e) => tracing::debug!("notification failed: {e}"),
        }
    });
}

#[cfg(not(any(windows, target_os = "linux")))]
fn show(_app: &tauri::AppHandle, _core: Arc<Core>, title: &str, body: &str, _sound: bool, _channel_id: Option<String>) {
    tracing::info!("notification: {title}: {body}");
}

/// Full-screen viewing of a screen share: the window itself goes fullscreen
/// (a webview element alone can only fill the window).
#[tauri::command]
pub async fn set_fullscreen(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

/// Whether the window is fullscreen now (the OS can take it out, e.g. when snapping).
#[tauri::command]
pub fn is_fullscreen(window: tauri::WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}
