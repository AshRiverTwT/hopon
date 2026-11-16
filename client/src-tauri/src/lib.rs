//! The Tauri shell: windows, webviews, tray, notifications and the command
//! bridge. Everything else lives in `hopon-core`.
#![cfg_attr(not(feature = "voice"), allow(dead_code))]
mod commands;
mod games;
mod host;
mod notify;
mod overlay;
mod tray;
mod update;

// The core's modules, under the paths the shell has always used.
use hopon_core::{core, guard, ui, voice};

use tauri::Manager;

pub fn run() {
    guard::install_crash_reporter();
    // --perf-exit runs are scripted measurements; allow them alongside.
    if !std::env::args().any(|a| a == "--perf-exit") && !guard::single_instance() {
        return;
    }
    linux::before_start();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,livekit=warn,libwebrtc=warn".into()),
        )
        .init();
    // One runtime for the core and Tauri's own async commands.
    tauri::async_runtime::set(hopon_core::rt::handle());

    tauri::Builder::default()
        .on_window_event(tray::on_window_event)
        .setup(|app| {
            tray::install(app)?;
            let dir = app.path().app_local_data_dir()?;
            let core = hopon_core::start(&dir)?;
            let _ = core.host.set(Box::new(host::TauriHost(app.handle().clone())));
            app.manage(core);
            linux::webview_media(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ui_subscribe,
            commands::ui_set_visibility,
            commands::ui_set_context,
            commands::ui_set_visible_members,
            commands::ui_ready,
            commands::get_config,
            commands::set_server_url,
            commands::signup,
            commands::login,
            commands::logout,
            commands::open_channel,
            commands::load_older,
            commands::load_members,
            commands::member_search,
            commands::send_message,
            commands::upload_file,
            commands::gif_search,
            commands::set_zoom,
            commands::mark_read,
            commands::react,
            commands::typing,
            commands::save_prefs,
            commands::edit_message,
            commands::delete_message,
            commands::create_server,
            commands::create_channel,
            commands::create_invite,
            commands::join_invite,
            commands::rename_server,
            commands::delete_server,
            commands::update_channel,
            commands::delete_channel,
            commands::kick_member,
            commands::leave_server,
            commands::revoke_invites,
            commands::avatar,
            commands::set_avatar,
            commands::banner,
            commands::set_banner,
            commands::set_profile,
            commands::get_profile,
            commands::set_status,
            commands::set_idle,
            commands::idle_seconds,
            commands::voice_prepare,
            commands::voice_join,
            commands::voice_leave,
            commands::voice_mute,
            commands::voice_deafen,
            commands::voice_ptt,
            commands::voice_volume,
            commands::activity_sharing,
            commands::screen_grant,
            commands::media_presence,
            commands::set_display_name,
            commands::friend_request,
            commands::friend_respond,
            commands::friend_remove,
            tray::close_to_tray,
            notify::notify,
            notify::set_fullscreen,
            notify::is_fullscreen,
            update::update_check,
            update::update_install,
            commands::audio_processing,
            commands::audio_devices,
            commands::audio_set_device,
            games::games_open,
            games::games_server,
            games::games_bounds,
            games::games_visible,
            games::games_close,
            games::games_open_external,
            games::open_url,
            overlay::overlay_hotkey,
            overlay::overlay_hide,
            overlay::overlay_typing,
            overlay::overlay_context,
            commands::perf_painted,
            commands::perf_stats,
            commands::perf_reset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HopOn");
}

/// Linux specifics (AppImage on Arch and friends); nothing on other systems.
mod linux {
    /// Before the webview starts: WebKitGTK's DMA-BUF renderer shows a blank
    /// window on some GPU drivers (common on Arch with NVIDIA); turn it off
    /// unless the user chose otherwise.
    pub fn before_start() {
        #[cfg(target_os = "linux")]
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    /// Camera, screen share and stream playback need WebRTC and media capture,
    /// which WebKitGTK leaves off by default; also answer its permission prompts.
    pub fn webview_media(_app: &tauri::App) {
        #[cfg(target_os = "linux")]
        {
            use tauri::Manager;
            use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
            if let Some(w) = _app.get_webview_window("main") {
                let _ = w.with_webview(|wv| {
                    let view = wv.inner();
                    if let Some(settings) = view.settings() {
                        settings.set_enable_webrtc(true);
                        settings.set_enable_media_stream(true);
                        settings.set_enable_mediasource(true);
                        settings.set_media_playback_requires_user_gesture(false);
                    }
                    view.connect_permission_request(|_, req| {
                        req.allow();
                        true
                    });
                });
            }
        }
    }
}
