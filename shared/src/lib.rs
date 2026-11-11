//! Types and utilities shared by the server, client and benchmarks.
//!
//! * [`proto`]  – the wire protocol (MessagePack over one WebSocket).
//! * [`ids`]    – time-ordered 63-bit IDs (snowflakes).
//! * [`time`]   – the single clock every latency stamp uses.
//! * [`stats`]  – HDR histograms that print p50/p95/p99.

pub mod ids;
pub mod proto;
pub mod stats;
pub mod time;

pub use proto::*;
