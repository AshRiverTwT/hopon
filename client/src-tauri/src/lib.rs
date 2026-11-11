#![cfg_attr(not(feature = "voice"), allow(dead_code))]
mod cache;
mod commands;
mod core;
mod perf;
mod secure;
mod sys;
mod ui;
#[cfg(feature = "voice")]
mod voice;
#[cfg(not(feature = "voice"))]
#[path = "voice_stub.rs"]
mod voice;

use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,livekit=warn,libwebrtc=warn".into()))
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let cache = cache::Cache::open(&dir.join("cache.db"))?;
            let default_url = std::env::var("HOPON_URL").unwrap_or_else(|_| "ws://127.0.0.1:8080/ws".into());
            let core = core::Core::new(cache, default_url);
            app.manage(core.clone());
            let start = core.clone();
            // Pre-connect: the socket is up (and usually authenticated) before
            // the user can click anything.
            tauri::async_runtime::spawn(async move {
                if let Some(u) = start.cache.kv_get("url").await.and_then(|b| String::from_utf8(b).ok()) {
                    if std::env::var("HOPON_URL").is_err() {
                        *start.url.lock() = u;
                    }
                }
                load_voice_prefs(&start).await;
                start.run().await;
            });
            // Benchmark automation only: dump instrumentation every 2 s.
            if let Ok(path) = std::env::var("HOPON_PERF_DUMP") {
                let c = core.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        let v = serde_json::json!({ "rows": c.perf.rows(), "startup": *c.perf.startup.lock() });
                        let _ = std::fs::write(&path, v.to_string());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ui_subscribe,
            commands::ui_ready,
            commands::get_config,
            commands::set_server_url,
            commands::signup,
            commands::login,
            commands::logout,
            commands::open_channel,
            commands::load_older,
            commands::send_message,
            commands::edit_message,
            commands::delete_message,
            commands::create_server,
            commands::create_channel,
            commands::create_invite,
            commands::join_invite,
            commands::avatar,
            commands::set_avatar,
            commands::voice_prepare,
            commands::voice_join,
            commands::voice_leave,
            commands::voice_mute,
            commands::voice_deafen,
            commands::voice_ptt,
            commands::audio_processing,
            commands::audio_devices,
            commands::audio_set_device,
            commands::perf_painted,
            commands::perf_stats,
            commands::perf_reset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HopOn");
}

async fn load_voice_prefs(core: &Arc<core::Core>) {
    let s = |b: Option<Vec<u8>>| b.and_then(|b| String::from_utf8(b).ok());
    if let Some(i) = s(core.cache.kv_get("dev_in").await) {
        let _ = core.voice.set_device(true, Some(i));
    }
    if let Some(o) = s(core.cache.kv_get("dev_out").await) {
        let _ = core.voice.set_device(false, Some(o));
    }
    if let Some(a) = s(core.cache.kv_get("apm").await) {
        let b: Vec<bool> = a.chars().map(|c| c == '1').collect();
        if b.len() == 3 {
            core.voice.set_processing(b[0], b[1], b[2]);
        }
    }
    if let Some(p) = s(core.cache.kv_get("ptt").await) {
        if let Some((en, vk)) = p.split_once(':') {
            core.voice.set_ptt(core, en == "1", vk.parse().unwrap_or(0)).await;
        }
    }
}
