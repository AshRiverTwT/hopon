//! Process stats for the perf overlay.

/// Private working set of this process in MB (Windows).
pub fn working_set_mb() -> Option<f64> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut c: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) != 0 {
            return Some(c.WorkingSetSize as f64 / 1_048_576.0);
        }
        None
    }
    #[cfg(not(windows))]
    None
}

/// Seconds since the last keyboard or mouse input on the whole system (so
/// playing a game counts as active). Windows only; None elsewhere.
pub fn idle_seconds() -> Option<u64> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::SystemInformation::GetTickCount;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info) != 0 {
            return Some(GetTickCount().wrapping_sub(info.dwTime) as u64 / 1000);
        }
        None
    }
    #[cfg(not(windows))]
    None
}
