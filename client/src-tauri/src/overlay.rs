//! In-game overlay: a global hotkey shows a small always-on-top window in the
//! bottom-right of the monitor the game is on (mini chat + who's in voice).
//! Pressing it again closes it and gives focus back to the game.
//!
//! - The hotkey uses RegisterHotKey on its own thread (Windows tells us about
//!   that one combination; no keystrokes are observed), which also gives us
//!   the right to take and return foreground focus.
//! - The window is created on show and destroyed on hide: no memory while
//!   it isn't visible.
//! - Works over windowed and borderless-fullscreen games. Exclusive-fullscreen
//!   games (and games running as administrator) can't be drawn over this way.

use crate::core::{Core, Res};
use crate::ui::UiMsg;
use std::sync::Arc;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "overlay";
/// Logical size of the overlay window.
const W: f64 = 760.0;
const H: f64 = 380.0;
const MARGIN: f64 = 28.0;

/// The window that had focus before the overlay opened (HWND as isize).
static PREV_FOREGROUND: parking_lot::Mutex<isize> = parking_lot::Mutex::new(0);

pub fn toggle(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if app.get_webview_window(LABEL).is_some() {
            hide(&app, true);
        } else if let Err(e) = show(&app) {
            tracing::warn!("overlay: {e}");
        }
    });
}

fn show(app: &tauri::AppHandle) -> Res<()> {
    let fg = platform::foreground();
    *PREV_FOREGROUND.lock() = fg;
    // Monitor holding the game (center of its window), else the primary.
    let center = platform::window_center(fg);
    let mon = app
        .available_monitors()
        .ok()
        .and_then(|ms| {
            ms.into_iter().find(|m| {
                let (p, s) = (m.position(), m.size());
                center.map_or(false, |(x, y)| x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32)
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("no monitor")?;
    let k = mon.scale_factor();
    let (w, h) = ((W * k) as u32, (H * k) as u32);
    let x = mon.position().x + mon.size().width as i32 - w as i32 - (MARGIN * k) as i32;
    let y = mon.position().y + mon.size().height as i32 - h as i32 - (MARGIN * 1.6 * k) as i32;
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("HopOn overlay")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(w, h)).map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

/// `refocus`: give focus back to the game (not when the user clicked elsewhere).
fn hide(app: &tauri::AppHandle, refocus: bool) {
    if let Some(core) = app.try_state::<Arc<Core>>() {
        core.detach_ui(LABEL);
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
    let prev = std::mem::take(&mut *PREV_FOREGROUND.lock());
    if refocus {
        platform::focus(prev);
    }
}

/// Combo changed in Settings ("" disables the overlay).
#[tauri::command]
pub fn overlay_hotkey(app: tauri::AppHandle, combo: String) -> Res<()> {
    platform::set_hotkey(app, &combo)
}

/// Close from inside the overlay: Esc (`refocus`: back to the game) or the
/// user clicking another window (`refocus = false`).
#[tauri::command]
pub async fn overlay_hide(app: tauri::AppHandle, refocus: bool) -> Res<()> {
    hide(&app, refocus);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayContext {
    /// The text channel open in the main window.
    channel_id: Option<String>,
    msgs: Vec<UiMsg>,
}

/// What to show: the main window's open channel and its latest messages.
#[tauri::command]
pub fn overlay_context(core: tauri::State<'_, Arc<Core>>) -> OverlayContext {
    let s = core.store.lock();
    let Some(ch) = s.open_channel else { return OverlayContext { channel_id: None, msgs: vec![] } };
    let msgs = s.recent.get(&ch).map(|q| q.iter().rev().take(30).rev().map(|m| UiMsg::from_msg(m, 2)).collect()).unwrap_or_default();
    OverlayContext { channel_id: Some(ch.to_string()), msgs }
}

/// "Alt+Backquote" → (MOD_* flags, virtual-key code).
pub fn parse_combo(c: &str) -> Option<(u32, u32)> {
    const MOD_ALT: u32 = 0x1;
    const MOD_CONTROL: u32 = 0x2;
    const MOD_SHIFT: u32 = 0x4;
    let mut mods = 0;
    let mut vk = None;
    for part in c.split('+') {
        match part {
            "Ctrl" => mods |= MOD_CONTROL,
            "Alt" => mods |= MOD_ALT,
            "Shift" => mods |= MOD_SHIFT,
            k => vk = vk_of(k),
        }
    }
    vk.map(|v| (mods, v))
}

fn vk_of(code: &str) -> Option<u32> {
    let one = |p: &str| code.strip_prefix(p).filter(|r| r.len() == 1).and_then(|r| r.chars().next());
    if let Some(ch) = one("Key").filter(char::is_ascii_uppercase) {
        return Some(ch as u32);
    }
    if let Some(ch) = one("Digit").filter(char::is_ascii_digit) {
        return Some(ch as u32);
    }
    if let Some(ch) = one("Numpad").filter(char::is_ascii_digit) {
        return Some(0x60 + (ch as u32 - '0' as u32));
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(0x6f + n);
    }
    Some(match code {
        "Backquote" => 0xc0,
        "Minus" => 0xbd,
        "Equal" => 0xbb,
        "BracketLeft" => 0xdb,
        "BracketRight" => 0xdd,
        "Backslash" => 0xdc,
        "Semicolon" => 0xba,
        "Quote" => 0xde,
        "Comma" => 0xbc,
        "Period" => 0xbe,
        "Slash" => 0xbf,
        "Space" => 0x20,
        "Tab" => 0x09,
        "Enter" => 0x0d,
        "Insert" => 0x2d,
        "Delete" => 0x2e,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        _ => return None,
    })
}

#[cfg(windows)]
mod platform {
    use super::parse_combo;
    use crate::core::Res;
    use parking_lot::Mutex;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetMessageW, GetWindowRect, IsWindow, PostThreadMessageW, SetForegroundWindow, MSG, WM_APP, WM_HOTKEY,
    };

    const HOTKEY_ID: i32 = 0x484f; // "HO"
    const WM_REREGISTER: u32 = WM_APP + 7;

    struct Hot {
        thread: u32,
        combo: Mutex<String>,
        app: Mutex<Option<tauri::AppHandle>>,
    }
    static HOT: OnceLock<Hot> = OnceLock::new();

    pub fn set_hotkey(app: tauri::AppHandle, combo: &str) -> Res<()> {
        if !combo.is_empty() && parse_combo(combo).is_none() {
            return Err("that key can't be used for the overlay".into());
        }
        let hot = HOT.get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::Builder::new()
                .name("hopon-hotkey".into())
                .spawn(move || run(tx))
                .expect("hotkey thread");
            Hot { thread: rx.recv().unwrap_or(0), combo: Mutex::new(String::new()), app: Mutex::new(None) }
        });
        *hot.app.lock() = Some(app);
        *hot.combo.lock() = combo.to_owned();
        unsafe { PostThreadMessageW(hot.thread, WM_REREGISTER, 0, 0) };
        Ok(())
    }

    fn run(tx: std::sync::mpsc::Sender<u32>) {
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            // Creates the thread's message queue before announcing its id.
            windows_sys::Win32::UI::WindowsAndMessaging::PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, 0);
            let _ = tx.send(GetCurrentThreadId());
            let mut registered = false;
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                let Some(hot) = HOT.get() else { continue };
                match msg.message {
                    WM_REREGISTER => {
                        if registered {
                            UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
                            registered = false;
                        }
                        let combo = hot.combo.lock().clone();
                        if let Some((mods, vk)) = parse_combo(&combo) {
                            registered = RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, mods | MOD_NOREPEAT, vk) != 0;
                            if !registered {
                                tracing::warn!("overlay hotkey {combo} is taken by another app");
                            }
                        }
                    }
                    WM_HOTKEY if msg.wParam as i32 == HOTKEY_ID => {
                        if let Some(app) = hot.app.lock().clone() {
                            super::toggle(app);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    pub fn foreground() -> isize {
        unsafe { GetForegroundWindow() as isize }
    }

    pub fn window_center(hwnd: isize) -> Option<(i32, i32)> {
        if hwnd == 0 {
            return None;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe {
            if GetWindowRect(hwnd as HWND, &mut r) == 0 {
                return None;
            }
        }
        Some(((r.left + r.right) / 2, (r.top + r.bottom) / 2))
    }

    pub fn focus(hwnd: isize) {
        if hwnd != 0 {
            unsafe {
                if IsWindow(hwnd as HWND) != 0 {
                    SetForegroundWindow(hwnd as HWND);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use crate::core::Res;
    pub fn set_hotkey(_app: tauri::AppHandle, _combo: &str) -> Res<()> {
        Ok(())
    }
    pub fn foreground() -> isize {
        0
    }
    pub fn window_center(_hwnd: isize) -> Option<(i32, i32)> {
        None
    }
    pub fn focus(_hwnd: isize) {}
}

#[cfg(test)]
mod tests {
    use super::parse_combo;

    #[test]
    fn combos() {
        assert_eq!(parse_combo("Alt+Backquote"), Some((0x1, 0xc0)));
        assert_eq!(parse_combo("Ctrl+Shift+KeyO"), Some((0x2 | 0x4, 'O' as u32)));
        assert_eq!(parse_combo("F9"), Some((0, 0x78)));
        assert_eq!(parse_combo("Ctrl+Digit1"), Some((0x2, '1' as u32)));
        assert_eq!(parse_combo("Ctrl+Numpad5"), Some((0x2, 0x65)));
        assert_eq!(parse_combo("Alt+Weird"), None);
        assert_eq!(parse_combo(""), None);
    }
}
