//! Update commands; the logic is in `hopon_core::update`.

use crate::core::{Core, Res};
use hopon_core::update::UpdateInfo;
use std::sync::Arc;

#[tauri::command]
pub async fn update_check(core: tauri::State<'_, Arc<Core>>) -> Res<UpdateInfo> {
    hopon_core::update::check(core.inner()).await
}

/// Download, verify, then hand over to the installer and quit.
#[tauri::command]
pub async fn update_install(core: tauri::State<'_, Arc<Core>>) -> Res<()> {
    hopon_core::update::install(core.inner()).await
}
