//! All latency instrumentation uses Unix-epoch microseconds so stamps taken
//! in different processes on the same machine are directly comparable. Across
//! machines, the client estimates its offset to the server with `Ping`/`Pong`
//! (see [`ClockSync`]).
//!
//! On Windows `SystemTime::now` is `GetSystemTimePreciseAsFileTime` (<1 µs).

use std::time::{SystemTime, UNIX_EPOCH};

/// Microseconds since the Unix epoch.
#[inline]
pub fn now_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

/// NTP-style offset estimation. Keeps the sample with the smallest RTT,
/// which has the tightest error bound (±rtt/2).
#[derive(Debug, Clone, Copy, Default)]
pub struct ClockSync {
    best_rtt: Option<i64>,
    /// server_clock - client_clock, in µs.
    pub offset_us: i64,
}

impl ClockSync {
    /// `t0` client send, `ts` server stamp, `t1` client receive.
    pub fn sample(&mut self, t0: i64, ts: i64, t1: i64) -> i64 {
        let rtt = (t1 - t0).max(0);
        if self.best_rtt.map_or(true, |b| rtt <= b) {
            self.best_rtt = Some(rtt);
            self.offset_us = ts - (t0 + rtt / 2);
        }
        rtt
    }

    /// Convert a server-clock timestamp to the local clock.
    #[inline]
    pub fn to_local(&self, server_us: i64) -> i64 {
        server_us - self.offset_us
    }

    pub fn best_rtt_us(&self) -> Option<i64> {
        self.best_rtt
    }
}
