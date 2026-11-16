//! Startup guards: a crash reporter (release builds abort on panic with no
//! console, so without this a crash is completely silent) and a
//! single-instance check (a second copy would fight over the cache file).

use std::path::PathBuf;

/// Same directory Tauri uses for `app_local_data_dir` on each platform.
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.unwrap_or_else(std::env::temp_dir).join("app.hopon.desktop")
}

/// Write panics to `crash.log` and tell the user, before the process aborts.
pub fn install_crash_reporter() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!(
            "HopOn {} crashed: {}\nat {}\n",
            env!("CARGO_PKG_VERSION"),
            info.payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into()),
            info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default(),
        );
        let dir = data_dir();
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("crash.log");
        let _ = std::fs::write(&path, &msg);
        message_box("HopOn crashed", &format!("{msg}\nDetails were saved to:\n{}", path.display()));
        default(info);
    }));
}

pub fn message_box(title: &str, text: &str) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        MessageBoxW(std::ptr::null_mut(), w(text).as_ptr(), w(title).as_ptr(), MB_OK | MB_ICONERROR);
    }
    #[cfg(not(windows))]
    eprintln!("{title}: {text}");
}

/// Returns false if another HopOn is already running (and brings it forward).
pub fn single_instance() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE};
        let name: Vec<u16> = "Local\\HopOnSingleInstance".encode_utf16().chain(std::iter::once(0)).collect();
        // Leaked on purpose: held for the life of the process.
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if !h.is_null() && GetLastError() == ERROR_ALREADY_EXISTS {
            let title: Vec<u16> = "HopOn".encode_utf16().chain(std::iter::once(0)).collect();
            let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
            if !hwnd.is_null() {
                ShowWindow(hwnd, SW_RESTORE);
                SetForegroundWindow(hwnd);
            }
            return false;
        }
    }
    true
}
