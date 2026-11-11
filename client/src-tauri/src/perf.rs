//! Client-side latency instrumentation. Every stage is stamped in Unix µs:
//! UI input → core send → (server recv → server send) → core recv → core emit
//! → UI render (reported back by the webview after the frame is committed) →
//! audio playback. Remote-sender stamps arrive already converted to the
//! server clock, and we convert ours with `ClockSync`, so cross-machine
//! send-to-display is comparable to within ±(rtt_a + rtt_b)/2.

use hopon_shared::stats::{Latency, Summary};
use hopon_shared::time::now_us;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Clone, Copy)]
#[repr(usize)]
pub enum H {
    /// Enter pressed → optimistic copy painted.
    LocalEcho,
    /// Enter pressed → server fan-out of our own message decoded.
    OwnEcho,
    /// Enter pressed → durable ack.
    OwnAck,
    /// Remote sender's Enter → painted here (clock-synced).
    RemoteDisplay,
    /// Server fan-out → painted here (clock-synced).
    ServerToPaint,
    /// Core emitted the event → painted (IPC + render).
    IpcPaint,
    WsRtt,
    /// Click "join" → SFU connected and mic published.
    VoiceJoin,
    /// Click "join" → first remote audio frame played.
    VoiceFirstAudio,
    /// Capture callback → frame handed to the encoder (DSP stage).
    VoiceCaptureToEncode,
    /// Decoded frame → consumed by the output callback (playout queue).
    VoicePlayoutQueue,
    /// Audio device round trip (output → input) measured by the loopback test.
    AudioDeviceRtt,
}
const NAMES: [&str; 12] = [
    "text: input->local echo paint",
    "text: input->own server echo",
    "text: input->durable ack",
    "text: remote input->paint (synced)",
    "text: server fanout->paint (synced)",
    "text: core emit->paint",
    "net: ws ping rtt",
    "voice: click->joined+publishing",
    "voice: click->first remote audio",
    "voice: capture->encoder",
    "voice: decoded->played",
    "voice: device out->in loopback",
];

#[derive(Clone, Copy)]
enum Pend {
    /// Optimistic copy; t_input local.
    Local { t_input: i64, t_emit: i64 },
    /// Server copy of any message; stamps already in local clock.
    Server { t_input: i64, t_server_send: i64, t_emit: i64, own: bool },
}

pub struct Perf {
    pub t_main: i64,
    hists: Mutex<Vec<Latency>>,
    pend: Mutex<HashMap<String, Pend>>,
    pub startup: Mutex<Option<Startup>>,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    /// Process creation → first painted frame (Windows: from GetProcessTimes).
    pub process_to_paint_ms: Option<f64>,
    pub main_to_paint_ms: f64,
    pub main_to_connected_ms: Option<f64>,
}

#[derive(Serialize)]
pub struct Row {
    pub name: &'static str,
    #[serde(flatten)]
    pub s: Summary,
}

impl Perf {
    pub fn new() -> Self {
        Self {
            t_main: now_us(),
            hists: Mutex::new(NAMES.iter().map(|n| Latency::new(n)).collect()),
            pend: Mutex::new(HashMap::new()),
            startup: Mutex::new(None),
        }
    }

    pub fn rec(&self, h: H, us: i64) {
        self.hists.lock()[h as usize].record_us(us);
    }

    pub fn expect_local(&self, key: String, t_input: i64, t_emit: i64) {
        self.insert(key, Pend::Local { t_input, t_emit });
    }

    pub fn expect_server(&self, key: String, t_input: i64, t_server_send: i64, t_emit: i64, own: bool) {
        self.insert(key, Pend::Server { t_input, t_server_send, t_emit, own });
    }

    fn insert(&self, k: String, p: Pend) {
        let mut m = self.pend.lock();
        if m.len() > 2048 {
            m.clear(); // UI not reporting (e.g. hidden window); don't grow
        }
        m.insert(k, p);
    }

    /// Paint stamps reported by the UI.
    pub fn painted(&self, marks: &[(String, i64)]) {
        let mut pend = self.pend.lock();
        let mut h = self.hists.lock();
        for (k, t) in marks {
            match pend.remove(k) {
                Some(Pend::Local { t_input, t_emit }) => {
                    h[H::LocalEcho as usize].record_us(t - t_input);
                    h[H::IpcPaint as usize].record_us(t - t_emit);
                }
                Some(Pend::Server { t_input, t_server_send, t_emit, own }) => {
                    if !own {
                        h[H::RemoteDisplay as usize].record_us(t - t_input);
                    }
                    h[H::ServerToPaint as usize].record_us(t - t_server_send);
                    h[H::IpcPaint as usize].record_us(t - t_emit);
                }
                None => {}
            }
        }
    }

    pub fn rows(&self) -> Vec<Row> {
        self.hists.lock().iter().filter(|h| h.summary().count > 0).map(|h| Row { name: h.name, s: h.summary() }).collect()
    }

    pub fn reset(&self) {
        for h in self.hists.lock().iter_mut() {
            h.reset();
        }
    }
}

/// Process creation time in Unix µs (Windows only).
pub fn process_start_us() -> Option<i64> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut e, mut k, mut u) = (z, z, z, z);
        if GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) == 0 {
            return None;
        }
        let ft = ((c.dwHighDateTime as i64) << 32) | c.dwLowDateTime as i64; // 100 ns since 1601
        Some(ft / 10 - 11_644_473_600_000_000)
    }
    #[cfg(not(windows))]
    None
}
