//! In-app updates. `latest.json` (published next to the installer on the
//! downloads branch) says which version is newest, where the installer is and
//! its SHA-256. Installing: download, verify the hash, start the installer in
//! passive mode (progress bar only); it closes HopOn, installs and reopens it.

use crate::core::{Core, Res};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

/// Override at build time with HOPON_UPDATE_URL.
const MANIFEST: &str = match option_env!("HOPON_UPDATE_URL") {
    Some(u) => u,
    None => "https://raw.githubusercontent.com/AshRiverTwT/hopon/downloads/latest.json",
};

pub const CURRENT: &str = env!("CARGO_PKG_VERSION");

#[derive(Deserialize, Clone)]
struct Manifest {
    version: String,
    url: String,
    sha256: String,
    #[serde(default)]
    notes: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    latest: String,
    available: bool,
    notes: String,
}

/// "0.4.10" > "0.4.9": numeric, part by part.
pub fn newer(a: &str, b: &str) -> bool {
    let p = |s: &str| s.split(['.', '-']).map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    p(a) > p(b)
}

async fn fetch(core: &Core) -> Res<Manifest> {
    let res = core
        .http()
        .get(MANIFEST)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "couldn't reach the update server".to_string())?;
    if !res.status().is_success() {
        return Err(format!("update check failed ({})", res.status()));
    }
    let m: Manifest = res.json().await.map_err(|_| "update info is malformed".to_string())?;
    if !m.url.starts_with("https://") || m.sha256.len() != 64 {
        return Err("update info is malformed".into());
    }
    Ok(m)
}

#[tauri::command]
pub async fn update_check(core: tauri::State<'_, Arc<Core>>) -> Res<UpdateInfo> {
    let m = fetch(&core).await?;
    Ok(UpdateInfo { current: CURRENT.into(), available: newer(&m.version, CURRENT), latest: m.version, notes: m.notes })
}

/// Download, verify, then hand over to the installer and quit.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, core: tauri::State<'_, Arc<Core>>) -> Res<()> {
    let m = fetch(&core).await?;
    if !newer(&m.version, CURRENT) {
        return Err("you're already on the latest version".into());
    }
    let bytes = core
        .http()
        .get(&m.url)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| "download failed".to_string())?
        .bytes()
        .await
        .map_err(|_| "download failed".to_string())?;
    use sha2::{Digest, Sha256};
    let got: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if !got.eq_ignore_ascii_case(&m.sha256) {
        return Err("the download was corrupted (checksum mismatch); try again".into());
    }
    let path = std::env::temp_dir().join(format!("HopOn-{}-setup.exe", m.version));
    std::fs::write(&path, &bytes).map_err(|e| format!("couldn't save the installer: {e}"))?;
    platform::run_installer(&path)?;
    // Leave voice cleanly, then exit so the installer can replace the files.
    let c = core.inner().clone();
    c.voice.leave(&c, true).await;
    app.exit(0);
    Ok(())
}

#[cfg(windows)]
mod platform {
    use crate::core::Res;
    use std::os::windows::process::CommandExt;

    pub fn run_installer(installer: &std::path::Path) -> Res<()> {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        // Tauri's NSIS installer: /P passive (progress bar only), /UPDATE keeps
        // shortcuts and settings, /R reopens HopOn when done. It closes this
        // process itself if it's still running.
        std::process::Command::new(installer)
            .args(["/P", "/UPDATE", "/R"])
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("couldn't start the installer: {e}"))?;
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use crate::core::Res;
    pub fn run_installer(_installer: &std::path::Path) -> Res<()> {
        Err("in-app updates are only available on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::newer;
    #[test]
    fn versions() {
        assert!(newer("0.4.2", "0.4.1"));
        assert!(newer("0.4.10", "0.4.9"));
        assert!(newer("1.0.0", "0.9.9"));
        assert!(!newer("0.4.1", "0.4.1"));
        assert!(!newer("0.3.9", "0.4.1"));
    }
}
