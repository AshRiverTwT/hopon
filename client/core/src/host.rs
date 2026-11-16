//! What the core needs from whatever UI hosts it. The Tauri shell implements
//! these over webview channels and windows; a native shell implements them
//! over FFI callbacks.

use crate::ui::UiEvent;

/// One subscribed window's event stream.
pub trait UiSink: Send + Sync {
    /// Deliver one event. `false` means the receiver is gone (drop the sink).
    fn send(&self, ev: UiEvent) -> bool;
}

impl<F: Fn(UiEvent) -> bool + Send + Sync> UiSink for F {
    fn send(&self, ev: UiEvent) -> bool {
        self(ev)
    }
}

/// Window-level services of the host.
pub trait Host: Send + Sync {
    /// The main window is minimized or hidden (to tray): the core then sends
    /// it only state-changing events, and the overlay stays live.
    fn main_hidden(&self) -> bool;
    /// Flash the taskbar button if the main window isn't focused.
    fn request_attention(&self);
    /// Close the app (after an update has been handed to the installer).
    fn exit(&self, code: i32);
}
