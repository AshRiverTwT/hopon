//! End-to-end text benchmark driver for a real client window.
//!
//!   e2e_feed --creds creds.txt [--n 500] [--rate 20] [--wait-file dump.json]
//!
//! Creates an author and a viewer account in a fresh server, writes
//! `viewer:password` to --creds (start the app with HOPON_PERF_LOGIN set to
//! that), waits until the app's HOPON_PERF_DUMP file appears, then sends paced
//! messages. The app measures remote-input → paint itself.

use anyhow::{bail, Result};
use hopon_bench::{arg, Client};
use hopon_shared::time::now_us;
use hopon_shared::*;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<()> {
    let url: String = arg("--url", "ws://127.0.0.1:8080/ws".to_string());
    let creds: String = arg("--creds", "creds.txt".to_string());
    let wait_file: String = arg("--wait-file", String::new());
    let n: usize = arg("--n", 500);
    let rate: f64 = arg("--rate", 20.0);

    let mut author = Client::connect(&url).await?;
    author.signup("e2ea").await?;
    let (server_id, channel_id) = match author.call(C2S::CreateServer { name: "e2e".into() }).await? {
        S2C::ServerJoined(s) => (s.id, s.channels.iter().find(|c| c.kind == ChannelKind::Text).unwrap().id),
        o => bail!("unexpected {o:?}"),
    };
    let S2C::Invite { code, .. } = author.call(C2S::CreateInvite { server_id }).await? else { bail!("invite") };
    let mut viewer = Client::connect(&url).await?;
    let name = format!("viewer{:06x}", rand::random::<u32>() & 0xffffff);
    viewer.call(C2S::Signup { username: name.clone(), password: "viewer-password".into() }).await?;
    viewer.call(C2S::JoinInvite { code }).await?;
    drop(viewer);
    std::fs::write(&creds, format!("{name}:viewer-password"))?;
    println!("viewer {name} ready; waiting for app");

    if !wait_file.is_empty() {
        while !std::path::Path::new(&wait_file).exists() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        tokio::time::sleep(Duration::from_secs(3)).await; // app opens the channel
    }
    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / rate));
    for i in 0..n {
        tick.tick().await;
        let t = now_us();
        author.send(C2S::Send { channel_id, content: format!("e2e message {i} — the quick brown fox jumps over the lazy dog"), nonce: i as u64 + 1, retry: false, t_input: t, t_client_send: t, reply_to: None, files: vec![], gifs: vec![] }).await?;
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    println!("sent {n}");
    Ok(())
}
