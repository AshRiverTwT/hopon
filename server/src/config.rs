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
    /// Wait this long after a user's last connection closes before
    /// announcing them offline (reconnects shouldn't flicker).
    pub presence_grace_ms: u64,
    /// Where uploaded files live (a persistent volume in production).
    pub files_dir: std::path::PathBuf,
    pub max_upload_bytes: u64,
    pub user_quota_bytes: u64,
    /// Uploads are refused when free disk space would drop below this.
    pub min_free_bytes: u64,
    /// KLIPY API key for GIF search; none = GIFs off.
    pub klipy_key: Option<String>,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn mb(k: &str, default: u64) -> u64 {
    env(k).and_then(|v| v.parse::<u64>().ok()).unwrap_or(default) * 1_048_576
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
            presence_grace_ms: env("HOPON_PRESENCE_GRACE_MS").and_then(|v| v.parse().ok()).unwrap_or(8000),
            files_dir: env("HOPON_FILES_DIR").unwrap_or_else(|| "./files".into()).into(),
            max_upload_bytes: mb("HOPON_MAX_UPLOAD_MB", 25),
            user_quota_bytes: mb("HOPON_USER_QUOTA_MB", 1024),
            min_free_bytes: mb("HOPON_MIN_FREE_MB", 2048),
            klipy_key: env("KLIPY_API_KEY"),
        })
    }
}
