//! "Playing <game>": every 15 s, read the names of running programs (a
//! process-list snapshot; no game process is ever opened, hooked or injected,
//! which matters for anti-cheat like Vanguard) and match them against a fixed
//! list of known games. Only the game's display name is ever sent, never the
//! process list. Can be turned off in Settings.

use crate::core::Core;
use hopon_shared::C2S;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// (exe name, lowercase) → display name. First match wins.
const GAMES: &[(&str, &str)] = &[
    ("valorant-win64-shipping.exe", "VALORANT"),
    ("league of legends.exe", "League of Legends"),
    ("cs2.exe", "Counter-Strike 2"),
    ("fortniteclient-win64-shipping.exe", "Fortnite"),
    ("r5apex.exe", "Apex Legends"),
    ("r5apex_dx12.exe", "Apex Legends"),
    ("overwatch.exe", "Overwatch 2"),
    ("marvel-win64-shipping.exe", "Marvel Rivals"),
    ("rocketleague.exe", "Rocket League"),
    ("dota2.exe", "Dota 2"),
    ("gta5.exe", "Grand Theft Auto V"),
    ("gta5_enhanced.exe", "Grand Theft Auto V"),
    ("rdr2.exe", "Red Dead Redemption 2"),
    ("rainbowsix.exe", "Rainbow Six Siege"),
    ("rainbowsix_vulkan.exe", "Rainbow Six Siege"),
    ("cod.exe", "Call of Duty"),
    ("robloxplayerbeta.exe", "Roblox"),
    ("minecraft.windows.exe", "Minecraft"),
    ("tslgame.exe", "PUBG: Battlegrounds"),
    ("eldenring.exe", "Elden Ring"),
    ("deadbydaylight-win64-shipping.exe", "Dead by Daylight"),
    ("among us.exe", "Among Us"),
    ("rustclient.exe", "Rust"),
    ("terraria.exe", "Terraria"),
    ("destiny2.exe", "Destiny 2"),
    ("bg3.exe", "Baldur's Gate 3"),
    ("bg3_dx11.exe", "Baldur's Gate 3"),
    ("cyberpunk2077.exe", "Cyberpunk 2077"),
    ("palworld-win64-shipping.exe", "Palworld"),
    ("lethal company.exe", "Lethal Company"),
    ("osu!.exe", "osu!"),
    ("warframe.x64.exe", "Warframe"),
    ("discovery.exe", "THE FINALS"),
    ("pioneergame.exe", "ARC Raiders"),
    ("pioneergame-d.exe", "ARC Raiders"),
    ("arcraiders.exe", "ARC Raiders"),
    ("arc raiders.exe", "ARC Raiders"),
    ("helldivers2.exe", "Helldivers 2"),
    ("valheim.exe", "Valheim"),
    ("phasmophobia.exe", "Phasmophobia"),
    ("witcher3.exe", "The Witcher 3"),
    ("streetfighter6.exe", "Street Fighter 6"),
    ("genshinimpact.exe", "Genshin Impact"),
    ("zenlesszonezero.exe", "Zenless Zone Zero"),
    ("starrail.exe", "Honkai: Star Rail"),
    ("stardew valley.exe", "Stardew Valley"),
    ("fc25.exe", "EA SPORTS FC 25"),
    ("fc26.exe", "EA SPORTS FC 26"),
];

pub struct Activity {
    pub enabled: AtomicBool,
    started: AtomicBool,
    /// What we last told the server ("" = nothing).
    pub current: parking_lot::Mutex<String>,
}

impl Activity {
    pub fn new() -> Self {
        Self { enabled: AtomicBool::new(true), started: AtomicBool::new(false), current: parking_lot::Mutex::new(String::new()) }
    }

    /// Start polling once (after login). Cheap: one snapshot every 15 s.
    pub fn start(core: Arc<Core>) {
        if core.activity.started.swap(true, Ordering::Relaxed) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            loop {
                let game = if core.activity.enabled.load(Ordering::Relaxed) && core.store.lock().me.is_some() {
                    tokio::task::spawn_blocking(detect).await.ok().flatten().unwrap_or_default()
                } else {
                    String::new()
                };
                core.activity.report(&core, game).await;
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
    }

    async fn report(&self, core: &Arc<Core>, game: String) {
        if *self.current.lock() == game {
            return;
        }
        if core.request(C2S::SetActivity { game: game.clone() }).await.is_ok() {
            *self.current.lock() = game;
        }
    }

    /// After reconnecting the server has forgotten; say it again.
    pub fn resend(core: Arc<Core>) {
        let game = core.activity.current.lock().clone();
        if !game.is_empty() {
            tauri::async_runtime::spawn(async move {
                let _ = core.request(C2S::SetActivity { game }).await;
            });
        }
    }

    /// Settings toggle; turning it off clears what others see right away.
    pub fn set_enabled(core: Arc<Core>, on: bool) {
        core.activity.enabled.store(on, Ordering::Relaxed);
        if !on {
            tauri::async_runtime::spawn(async move { core.activity.report(&core, String::new()).await });
        }
    }
}

pub fn game_for(exe: &str) -> Option<&'static str> {
    let e = exe.to_ascii_lowercase();
    GAMES.iter().find(|(x, _)| *x == e).map(|(_, n)| *n)
}

#[cfg(windows)]
fn detect() -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        let mut ok = Process32FirstW(snap, &mut e) != 0;
        while ok {
            let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            let name = String::from_utf16_lossy(&e.szExeFile[..len]);
            if let Some(g) = game_for(&name) {
                found = Some(g.to_owned());
                break;
            }
            ok = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
        found
    }
}

#[cfg(not(windows))]
fn detect() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_known_games_only() {
        assert_eq!(super::game_for("VALORANT-Win64-Shipping.exe"), Some("VALORANT"));
        assert_eq!(super::game_for("cs2.exe"), Some("Counter-Strike 2"));
        assert_eq!(super::game_for("VALORANT.exe"), None); // launcher stub, not in a match
        assert_eq!(super::game_for("chrome.exe"), None);
    }
}
