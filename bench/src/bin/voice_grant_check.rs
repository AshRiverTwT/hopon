//! Deployment smoke test: log in to the chat server, get a voice grant, and
//! ask LiveKit to validate it (GET /rtc/validate).
//!
//!   voice_grant_check [--url ws://127.0.0.1:8080/ws]

use anyhow::{bail, Result};
use hopon_bench::{arg, url_lite, Client};
use hopon_shared::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> Result<()> {
    let url: String = arg("--url", "ws://127.0.0.1:8080/ws".to_string());
    let mut c = Client::connect(&url).await?;
    c.signup("grant").await?;
    let S2C::ServerJoined(s) = c.call(C2S::CreateServer { name: "grant".into() }).await? else { bail!("create") };
    let ch = s.channels.iter().find(|c| c.kind == ChannelKind::Voice).unwrap().id;
    let S2C::VoiceGrant { url: lk, token, .. } = c.call(C2S::VoiceGrant { channel_id: ch }).await? else { bail!("grant") };
    println!("grant for {lk}");
    if lk.starts_with("wss://") {
        println!("(TLS endpoint: validate with a browser or the voice bench)");
        return Ok(());
    }
    let u = url_lite::parse(&lk)?;
    let mut tcp = tokio::net::TcpStream::connect((u.host.as_str(), u.port)).await?;
    let req = format!("GET /rtc/validate?access_token={token} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", u.host);
    tcp.write_all(req.as_bytes()).await?;
    let mut resp = String::new();
    tcp.read_to_string(&mut resp).await?;
    let status = resp.lines().next().unwrap_or("");
    println!("LiveKit says: {status}");
    if !status.contains(" 200") {
        bail!("grant rejected: {}", resp.lines().last().unwrap_or(""));
    }
    println!("ok: SFU accepts server-issued grants");
    Ok(())
}
