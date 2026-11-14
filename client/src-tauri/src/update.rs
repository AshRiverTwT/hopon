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
    /// The Linux AppImage (optional: older manifests have none).
    #[serde(default)]
    linux_url: String,
    #[serde(default)]
    linux_sha256: String,
}

impl Manifest {
    /// This platform's download: (url, sha256).
    fn download(&self) -> Option<(&str, &str)> {
        if cfg!(target_os = "linux") {
            (!self.linux_url.is_empty() && self.linux_sha256.len() == 64).then_some((self.linux_url.as_str(), self.linux_sha256.as_str()))
        } else {
            Some((self.url.as_str(), self.sha256.as_str()))
        }
    }
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
    let available = newer(&m.version, CURRENT) && m.download().is_some() && platform::can_update();
    Ok(UpdateInfo { current: CURRENT.into(), available, latest: m.version, notes: m.notes })
}

/// Download, verify, then hand over to the installer and quit.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, core: tauri::State<'_, Arc<Core>>) -> Res<()> {
    let m = fetch(&core).await?;
    if !newer(&m.version, CURRENT) {
        return Err("you're already on the latest version".into());
    }
    let (url, sha256) = m.download().ok_or("no download for this platform yet")?;
    let bytes = core
        .http()
        .get(url)
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
    if !got.eq_ignore_ascii_case(sha256) {
        return Err("the download was corrupted (checksum mismatch); try again".into());
    }
    platform::install(&m.version, &bytes)?;
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

    pub fn can_update() -> bool {
        true
    }

    pub fn install(version: &str, bytes: &[u8]) -> Res<()> {
        let installer = std::env::temp_dir().join(format!("HopOn-{version}-setup.exe"));
        std::fs::write(&installer, bytes).map_err(|e| format!("couldn't save the installer: {e}"))?;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        // Tauri's NSIS installer: /P passive (progress bar only), /UPDATE keeps
        // shortcuts and settings, /R reopens HopOn when done. It closes this
        // process itself if it's still running.
        std::process::Command::new(&installer)
            .args(["/P", "/UPDATE", "/R"])
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("couldn't start the installer: {e}"))?;
        Ok(())
    }
}

/// Linux AppImage: replace the AppImage file in place, then start the new one.
#[cfg(target_os = "linux")]
mod platform {
    use crate::core::Res;
    use std::os::unix::fs::PermissionsExt;

    /// Only the AppImage updates itself (a distro package updates through its package manager).
    fn appimage() -> Option<std::path::PathBuf> {
        std::env::var_os("APPIMAGE").map(std::path::PathBuf::from).filter(|p| p.is_file())
    }

    pub fn can_update() -> bool {
        appimage().is_some()
    }

    pub fn install(_version: &str, bytes: &[u8]) -> Res<()> {
        let target = appimage().ok_or("updates here come from your package manager")?;
        let tmp = target.with_extension("new");
        std::fs::write(&tmp, bytes).map_err(|e| format!("couldn't save the update: {e}"))?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &target).map_err(|e| format!("couldn't replace the AppImage: {e}"))?;
        // Started a moment later, once this copy has closed (one HopOn runs at a time).
        std::process::Command::new("sh")
            .args(["-c", "sleep 1.5; exec \"$0\"", &target.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("couldn't start the new version: {e}"))?;
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use crate::core::Res;
    pub fn can_update() -> bool {
        false
    }
    pub fn install(_version: &str, _bytes: &[u8]) -> Res<()> {
        Err("in-app updates aren't available on this system".into())
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
