//! The core's host services over Tauri windows and IPC channels.

use crate::ui::UiEvent;
use hopon_core::host::{Host, UiSink};
use tauri::ipc::Channel;
use tauri::Manager;

pub struct TauriHost(pub tauri::AppHandle);

impl Host for TauriHost {
    fn main_hidden(&self) -> bool {
        self.0
            .get_webview_window("main")
            .map(|w| w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true))
            .unwrap_or(false)
    }

    fn request_attention(&self) {
        if let Some(w) = self.0.get_webview_window("main") {
            if !w.is_focused().unwrap_or(true) {
                let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
        }
    }

    fn exit(&self, code: i32) {
        self.0.exit(code);
    }
}

/// A webview's event channel.
pub struct ChannelSink(pub Channel<UiEvent>);

impl UiSink for ChannelSink {
    fn send(&self, ev: UiEvent) -> bool {
        self.0.send(ev).is_ok()
    }
}
