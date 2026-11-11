//! Snowflake IDs: `[41 bits ms since EPOCH][10 bits node][12 bits seq]`.
//! Time-ordered, so `(channel_id, id)` is the natural history index and
//! "before X" paging needs no extra column.

use std::sync::atomic::{AtomicU64, Ordering};

/// 2025-01-01T00:00:00Z in Unix ms.
pub const EPOCH_MS: u64 = 1_735_689_600_000;
const NODE_BITS: u32 = 10;
const SEQ_BITS: u32 = 12;
const SEQ_MASK: u64 = (1 << SEQ_BITS) - 1;

pub struct IdGen {
    node: u64,
    /// Last issued `(ms << SEQ_BITS) | seq`.
    state: AtomicU64,
}

impl IdGen {
    pub fn new(node: u16) -> Self {
        Self { node: (node as u64) & ((1 << NODE_BITS) - 1), state: AtomicU64::new(0) }
    }

    /// Lock-free, strictly increasing within this generator.
    pub fn next(&self) -> i64 {
        let now = (crate::time::now_us() as u64 / 1000).saturating_sub(EPOCH_MS);
        let mut cur = self.state.load(Ordering::Relaxed);
        loop {
            let cur_ms = cur >> SEQ_BITS;
            // If the clock went backwards or we exhausted the sequence for this ms,
            // borrow from the future: stay monotonic rather than block.
            let next = if now > cur_ms { now << SEQ_BITS } else { cur + 1 };
            match self.state.compare_exchange_weak(cur, next, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => {
                    let ms = next >> SEQ_BITS;
                    let seq = next & SEQ_MASK;
                    return ((ms << (NODE_BITS + SEQ_BITS)) | (self.node << SEQ_BITS) | seq) as i64;
                }
                Err(actual) => cur = actual,
            }
        }
    }
}

/// Unix ms encoded in an ID.
pub fn id_unix_ms(id: i64) -> u64 {
    ((id as u64) >> (NODE_BITS + SEQ_BITS)) + EPOCH_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn monotonic() {
        let g = IdGen::new(1);
        let mut last = 0;
        for _ in 0..100_000 {
            let id = g.next();
            assert!(id > last);
            last = id;
        }
        let ms = id_unix_ms(last);
        let now = crate::time::now_us() as u64 / 1000;
        assert!(ms.abs_diff(now) < 5_000);
    }
}
