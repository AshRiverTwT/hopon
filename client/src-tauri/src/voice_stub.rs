//! Voice disabled at build time (`--no-default-features`): same API, no-ops.

use crate::core::{Core, Res};
use hopon_shared::Id;
use serde::Serialize;
use std::sync::Arc;

pub struct Voice;

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
        Self
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
    pub async fn set_muted(&self, _core: &Arc<Core>, _muted: bool) {}
    pub async fn set_deafened(&self, _core: &Arc<Core>, _deafened: bool) {}
    pub async fn set_ptt(&self, _core: &Arc<Core>, _enabled: bool, _vk: u32) {}
    pub fn on_reconnect(&self, _core: Arc<Core>) {}
}
