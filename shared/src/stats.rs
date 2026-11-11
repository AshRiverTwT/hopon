//! Latency histograms (µs resolution, 1 µs .. 1 h range, 3 significant digits).

use hdrhistogram::Histogram;

#[derive(Clone)]
pub struct Latency {
    pub name: &'static str,
    h: Histogram<u64>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, Default)]
pub struct Summary {
    pub count: u64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub mean_ms: f64,
}

impl Latency {
    pub fn new(name: &'static str) -> Self {
        Self { name, h: Histogram::new_with_bounds(1, 3_600_000_000, 3).expect("hist bounds") }
    }

    #[inline]
    pub fn record_us(&mut self, us: i64) {
        let _ = self.h.record(us.max(1) as u64);
    }

    pub fn merge(&mut self, other: &Latency) {
        let _ = self.h.add(&other.h);
    }

    pub fn reset(&mut self) {
        self.h.reset();
    }

    pub fn summary(&self) -> Summary {
        let ms = |v: u64| v as f64 / 1000.0;
        Summary {
            count: self.h.len(),
            p50_ms: ms(self.h.value_at_quantile(0.50)),
            p95_ms: ms(self.h.value_at_quantile(0.95)),
            p99_ms: ms(self.h.value_at_quantile(0.99)),
            max_ms: ms(self.h.max()),
            mean_ms: self.h.mean() / 1000.0,
        }
    }

    /// One aligned line: `name  n=…  p50 … p95 … p99 … max …` (ms).
    pub fn line(&self) -> String {
        let s = self.summary();
        format!(
            "{:<34} n={:<7} p50 {:>8.3}  p95 {:>8.3}  p99 {:>8.3}  max {:>8.3}  (ms)",
            self.name, s.count, s.p50_ms, s.p95_ms, s.p99_ms, s.max_ms
        )
    }
}
