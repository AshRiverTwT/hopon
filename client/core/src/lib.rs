//! HopOn client core, independent of any UI toolkit: the WebSocket, all
//! state, the local cache, voice, perf instrumentation and the platform bits
//! that don't need a window. A UI shell (Tauri today) talks to it through the
//! methods on [`core::Core`] and receives [`ui::UiEvent`]s through a
//! [`host::UiSink`].
#![cfg_attr(not(feature = "voice"), allow(dead_code))]

pub mod activity;
pub mod api;
pub mod cache;
pub mod core;
pub mod games;
pub mod guard;
pub mod host;
pub mod perf;
pub mod rt;
pub mod secure;
pub mod sys;
pub mod ui;
pub mod update;
#[cfg(feature = "voice")]
pub mod voice;
#[cfg(not(feature = "voice"))]
#[path = "voice_stub.rs"]
pub mod voice;

use std::path::Path;
use std::sync::Arc;

/// Boot the core: open the cache in `data_dir`, pick the server URL and start
/// connecting right away (the socket is up, usually authenticated, before the
/// user can click anything). Call once, before any window exists; then set
/// [`core::Core::host`] and attach UI sinks with [`core::Core::attach_ui`].
pub fn start(data_dir: &Path) -> anyhow::Result<Arc<core::Core>> {
    // wss:// needs a process-wide rustls crypto provider (see Cargo.toml).
    let _ = rustls::crypto::ring::default_provider().install_default();
    std::fs::create_dir_all(data_dir)?;
    private_dir(data_dir);
    // The cache is disposable: never let it stop the app from starting.
    let cache = match cache::Cache::open(&data_dir.join("cache.db")) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("cache unavailable ({e:#}); using a temporary in-memory cache");
            cache::Cache::open_in_memory()?
        }
    };
    // Public server by default; HOPON_DEFAULT_URL at build time overrides it,
    // HOPON_URL at run time overrides both. A URL picked at sign-in is kept.
    let default_url = std::env::var("HOPON_URL")
        .unwrap_or_else(|_| option_env!("HOPON_DEFAULT_URL").unwrap_or("wss://hopon-chat.duckdns.org/ws").into());
    let core = core::Core::new(cache, default_url);
    let start = core.clone();
    rt::spawn(async move {
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
        rt::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let v = serde_json::json!({ "rows": c.perf.rows(), "startup": *c.perf.startup.lock() });
                let _ = std::fs::write(&path, v.to_string());
            }
        });
    }
    Ok(core)
}

/// The data folder holds your sign-in: only you can read it.
fn private_dir(_dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_dir, std::fs::Permissions::from_mode(0o700));
    }
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
