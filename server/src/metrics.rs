//! Server-side stage timings, exposed at `GET /metrics` (plain text).

use hopon_shared::stats::Latency;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct Metrics {
    /// Frame decoded → fan-out frame handed to the broadcast.
    pub fanout: Mutex<Latency>,
    /// Message enqueued for persistence → transaction committed.
    pub persist: Mutex<Latency>,
    /// Rows per persister transaction.
    pub batch_rows: Mutex<Latency>,
    pub connections: AtomicU64,
    pub messages: AtomicU64,
    pub lagged_disconnects: AtomicU64,
    pub persist_failures: AtomicU64,
    pub history_rejected: AtomicU64,
    pub upload_rejected: AtomicU64,
    pub replay_snapshot_fallbacks: AtomicU64,
    pub auth_rejected: AtomicU64,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            fanout: Mutex::new(Latency::new("server recv->fanout")),
            persist: Mutex::new(Latency::new("server enqueue->commit")),
            batch_rows: Mutex::new(Latency::new("persist rows/txn (x1000)")),
            connections: AtomicU64::new(0),
            messages: AtomicU64::new(0),
            lagged_disconnects: AtomicU64::new(0),
            persist_failures: AtomicU64::new(0),
            history_rejected: AtomicU64::new(0),
            upload_rejected: AtomicU64::new(0),
            replay_snapshot_fallbacks: AtomicU64::new(0),
            auth_rejected: AtomicU64::new(0),
        }
    }

    pub fn render(&self) -> String {
        let g = |a: &AtomicU64| a.load(Ordering::Relaxed);
        format!(
            "{}\n{}\n{}\nconnections {}\nmessages_total {}\nlagged_disconnects {}\npersist_failures {}\nhistory_rejected {}\nupload_rejected {}\nauth_rejected {}\nreplay_snapshot_fallbacks {}\n",
            self.fanout.lock().line(),
            self.persist.lock().line(),
            self.batch_rows.lock().line(),
            g(&self.connections),
            g(&self.messages),
            g(&self.lagged_disconnects),
            g(&self.persist_failures),
            g(&self.history_rejected),
            g(&self.upload_rejected),
            g(&self.auth_rejected),
            g(&self.replay_snapshot_fallbacks),
        )
    }

    pub fn reset(&self) {
        self.fanout.lock().reset();
        self.persist.lock().reset();
        self.batch_rows.lock().reset();
    }
}
