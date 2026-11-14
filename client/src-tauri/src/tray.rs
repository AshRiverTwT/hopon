//! System tray. Closing the window hides it (voice, overlay and hotkeys keep
//! working); the tray icon brings it back, and its menu quits for real.
//! "Close to tray" can be turned off in Settings.

use crate::core::Core;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(core) = app.try_state::<std::sync::Arc<Core>>() {
        core.set_ui_visible(true);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open HopOn", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit HopOn", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("HopOn")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Main window's close button: hide to the tray (unless turned off).
pub fn on_window_event(w: &tauri::Window, e: &WindowEvent) {
    if w.label() == "main" {
        if let Some(core) = w.app_handle().try_state::<std::sync::Arc<Core>>() {
            match e {
                WindowEvent::Focused(false) => core.set_ui_visible(false),
                WindowEvent::Focused(true) => core.set_ui_visible(true),
                _ => {}
            }
        }
    }
    if let WindowEvent::CloseRequested { api, .. } = e {
        if w.label() == "main" && CLOSE_TO_TRAY.load(Ordering::Relaxed) {
            api.prevent_close();
            if let Some(core) = w.app_handle().try_state::<std::sync::Arc<Core>>() {
                core.set_ui_visible(false);
            }
            let _ = w.hide();
        }
    }
}

#[tauri::command]
pub fn close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}
