//! Voice disabled at build time (`--no-default-features`): same API, no-ops.

use crate::core::{Core, Res};
use hopon_shared::Id;
use serde::Serialize;
use std::sync::Arc;

pub struct Voice {
    pub screen: Screen,
}

/// Screen sharing needs libwebrtc: same API, all errors.
pub struct Screen;

#[derive(Serialize)]
pub struct Source {
    pub id: String,
    pub title: String,
    pub kind: &'static str,
}

pub mod screen {
    pub fn sources() -> Vec<super::Source> {
        Vec::new()
    }
}

impl Screen {
    pub async fn share(&self, _core: &Arc<Core>, _source: &str, _quality: &str) -> Res<()> {
        Err(OFF.into())
    }
    pub async fn stop_share(&self, _core: &Arc<Core>) -> Res<()> {
        Ok(())
    }
    pub async fn watch(&self, _core: &Arc<Core>, _user_id: String) -> Res<()> {
        Err(OFF.into())
    }
    pub async fn unwatch(&self, _core: &Arc<Core>, _user_id: &str) {}
    pub async fn set_volume(&self, _user_id: String, _volume: f64) {}
    pub fn frame(&self, _user_id: &str, _last_seq: u64, _dst: &mut [u8], _max_w: u32, _max_h: u32) -> Option<(u32, u32, u64)> {
        None
    }
    pub fn frame_size(&self, _user_id: &str) -> (u32, u32) {
        (0, 0)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Processing {
    pub aec: bool,
    pub ns: bool,
    pub agc: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub processing: Processing,
    pub inputs: Vec<Device>,
    pub outputs: Vec<Device>,
    pub input: Option<String>,
    pub output: Option<String>,
    pub aec: String,
    pub ns: String,
    pub agc: String,
}

const OFF: &str = "voice is not included in this build";

impl Voice {
    pub fn new() -> Self {
        Self { screen: Screen }
    }
    pub fn devices(&self) -> Res<Devices> {
        Err(OFF.into())
    }
    pub fn set_processing(&self, _aec: bool, _ns: bool, _agc: bool) {}
    pub fn set_device(&self, _input: bool, _id: Option<String>) -> Res<()> {
        Ok(())
    }
    pub async fn prepare(&self, _core: &Arc<Core>, _channel_id: Id) {}
    pub async fn join(&self, _core: Arc<Core>, _channel_id: Id) -> Res<()> {
        Err(OFF.into())
    }
    pub async fn leave(&self, _core: &Arc<Core>, _notify_server: bool) {}
    pub fn leave_if_in(&self, _core: Arc<Core>, _channels: &[Id]) {}
    pub async fn set_muted(&self, _core: &Arc<Core>, _muted: bool) {}
    pub async fn set_deafened(&self, _core: &Arc<Core>, _deafened: bool) {}
    pub async fn toggle_muted(&self, _core: &Arc<Core>) {}
    pub async fn toggle_deafened(&self, _core: &Arc<Core>) {}
    pub async fn set_ptt(&self, _core: &Arc<Core>, _enabled: bool, _vk: u32) {}
    pub async fn set_volume(&self, _user: String, _v: f64) {}
    pub fn on_reconnect(&self, _core: Arc<Core>) {}
}
