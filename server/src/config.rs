use anyhow::{Context, Result};

#[derive(Clone)]
pub struct Config {
    pub bind: String,
    pub database_url: String,
    pub jwt_secret: Vec<u8>,
    pub node_id: u16,
    pub db_pool: u32,
    pub livekit_url: String,
    pub livekit_key: String,
    pub livekit_secret: String,
    /// Per-connection message send rate (per second); burst is 3x.
    pub send_rate: f64,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as u32;
        Ok(Self {
            bind: env("HOPON_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            database_url: env("DATABASE_URL").context("DATABASE_URL is required")?,
            jwt_secret: env("HOPON_JWT_SECRET").context("HOPON_JWT_SECRET is required")?.into_bytes(),
            node_id: env("HOPON_NODE_ID").and_then(|v| v.parse().ok()).unwrap_or(1),
            db_pool: env("HOPON_DB_POOL").and_then(|v| v.parse().ok()).unwrap_or(cpus.max(2)),
            livekit_url: env("LIVEKIT_URL").unwrap_or_else(|| "ws://127.0.0.1:7880".into()),
            livekit_key: env("LIVEKIT_API_KEY").unwrap_or_else(|| "devkey".into()),
            livekit_secret: env("LIVEKIT_API_SECRET").unwrap_or_else(|| "secret".into()),
            send_rate: env("HOPON_SEND_RATE").and_then(|v| v.parse().ok()).unwrap_or(10.0),
        })
    }
}
