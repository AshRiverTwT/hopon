//! Global push-to-talk. Windows: a low-level keyboard hook (WH_KEYBOARD_LL)
//! on its own thread with a message loop. The hook only flips an atomic and
//! wakes a task; it never blocks, so key-to-transmit is one wake-up (<1 ms)
//! plus the track unmute.

use crate::core::Core;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::Notify;

struct Shared {
    enabled: AtomicBool,
    vk: AtomicU32,
    down: AtomicBool,
    changed: Notify,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

fn shared() -> &'static Shared {
    SHARED.get_or_init(|| Shared {
        enabled: AtomicBool::new(false),
        vk: AtomicU32::new(0),
        down: AtomicBool::new(false),
        changed: Notify::new(),
    })
}

pub struct Ptt {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    hook_started: AtomicBool,
}

impl Ptt {
    pub fn new() -> Self {
        Self { task: Mutex::new(None), hook_started: AtomicBool::new(false) }
    }

    pub fn is_down(&self) -> bool {
        shared().down.load(Ordering::Relaxed)
    }

    pub fn configure(&self, enabled: bool, vk: u32) {
        let s = shared();
        s.vk.store(vk, Ordering::Relaxed);
        s.enabled.store(enabled && vk != 0, Ordering::Relaxed);
        if enabled && !self.hook_started.swap(true, Ordering::Relaxed) {
            hook::start();
        }
    }

    /// While in a voice channel, react to key transitions.
    pub fn attach(&self, core: Arc<Core>) {
        let t = tauri::async_runtime::spawn(async move {
            loop {
                shared().changed.notified().await;
                if !shared().down.load(Ordering::Relaxed) {
                    // Short tail so the last syllable is not clipped.
                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                    if shared().down.load(Ordering::Relaxed) {
                        continue;
                    }
                }
                core.voice.apply_transmit(&core, false).await;
            }
        });
        if let Some(old) = self.task.lock().replace(t) {
            old.abort();
        }
    }

    pub fn detach(&self) {
        if let Some(t) = self.task.lock().take() {
            t.abort();
        }
    }
}

#[cfg(windows)]
mod hook {
    use super::shared;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let s = shared();
            if s.enabled.load(Ordering::Relaxed) {
                let k = &*(l as *const KBDLLHOOKSTRUCT);
                if k.vkCode == s.vk.load(Ordering::Relaxed) {
                    let down = matches!(w as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
                    // Auto-repeat sends repeated downs: only wake on transitions.
                    if s.down.swap(down, Ordering::Relaxed) != down {
                        s.changed.notify_one();
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, w, l)
    }

    pub fn start() {
        std::thread::Builder::new()
            .name("hopon-ptt".into())
            .spawn(|| unsafe {
                let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(proc), std::ptr::null_mut(), 0);
                if h.is_null() {
                    tracing::warn!("push-to-talk hook failed");
                    return;
                }
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
                UnhookWindowsHookEx(h);
            })
            .ok();
    }
}

#[cfg(not(windows))]
mod hook {
    pub fn start() {
        tracing::warn!("global push-to-talk is only implemented on Windows");
    }
}
