//! Minimal protocol client used by the benchmarks.

use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use hopon_shared::*;
use std::collections::VecDeque;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub struct Client {
    pub ws: Ws,
    req: u32,
    events: VecDeque<ServerFrame>,
}

impl Client {
    pub async fn connect(url: &str) -> Result<Self> {
        // wss:// needs an explicit rustls crypto provider (idempotent).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let u: url_lite::Url = url_lite::parse(url)?;
        let tcp = TcpStream::connect((u.host.as_str(), u.port)).await?;
        tcp.set_nodelay(true)?;
        let (ws, _) = tokio_tungstenite::client_async_tls(versioned_url(url), tcp).await?;
        Ok(Self { ws, req: 0, events: VecDeque::new() })
    }

    pub async fn send(&mut self, msg: C2S) -> Result<u32> {
        self.req += 1;
        let req = self.req;
        self.ws.send(WsMsg::Binary(encode(&ClientFrame { req, msg }).into())).await?;
        Ok(req)
    }

    pub async fn recv(&mut self) -> Result<ServerFrame> {
        if let Some(event) = self.events.pop_front() {
            return Ok(event);
        }
        self.read_frame().await
    }

    async fn read_frame(&mut self) -> Result<ServerFrame> {
        loop {
            match self.ws.next().await {
                Some(Ok(WsMsg::Binary(b))) => return Ok(decode(&b)?),
                Some(Ok(WsMsg::Close(_))) | None => bail!("closed"),
                Some(Err(e)) => return Err(e.into()),
                _ => {}
            }
        }
    }

    /// Chat events as observed by a UI. User messages appear on the live path,
    /// so their subsequent commit must not count as a second delivery.
    pub async fn recv_chat(&mut self) -> Result<ServerFrame> {
        loop {
            let mut frame = self.recv().await?;
            frame.msg = match frame.msg {
                S2C::LiveMessage(message) => S2C::Message(message),
                S2C::ChannelEvent(event) => match event.payload {
                    DurablePayload::Message(m) if m.author_id == SYSTEM_USER => S2C::Message(m),
                    DurablePayload::Message(_) => continue,
                    DurablePayload::Edited { channel_id, id, content, edited_at } => {
                        S2C::Edited { channel_id, id, content, edited_at }
                    }
                    DurablePayload::Deleted { channel_id, id } => S2C::Deleted { channel_id, id },
                    DurablePayload::Reaction { channel_id, message_id, emoji, user_id, add } => {
                        S2C::Reaction { channel_id, message_id, emoji, user_id, add }
                    }
                },
                msg => msg,
            };
            return Ok(frame);
        }
    }

    /// Send a request and wait for its reply. Keep unsolicited events that
    /// arrive before the reply available to the caller.
    pub async fn call(&mut self, msg: C2S) -> Result<S2C> {
        let req = self.send(msg).await?;
        loop {
            let f = self.read_frame().await?;
            if f.req == req {
                if let S2C::Error { code, message } = f.msg {
                    return Err(anyhow!("{code:?}: {message}"));
                }
                return Ok(f.msg);
            }
            if f.req == 0 {
                self.events.push_back(f);
            }
        }
    }

    pub async fn signup(&mut self, prefix: &str) -> Result<UserInfo> {
        let name = format!("{prefix}{:08x}", rand::random::<u32>());
        match self.call(C2S::Signup { username: name, password: "benchmark-pass".into() }).await? {
            S2C::Authed { user, .. } => Ok(user),
            o => bail!("unexpected {o:?}"),
        }
    }
}

/// Tiny ws:// URL parser (host + port) so the bench has no URL dependency.
pub mod url_lite {
    pub struct Url {
        pub host: String,
        pub port: u16,
    }
    pub fn parse(u: &str) -> anyhow::Result<Url> {
        let (scheme, rest) = u.split_once("://").ok_or_else(|| anyhow::anyhow!("bad url"))?;
        let hostport = rest.split('/').next().unwrap_or("");
        let default = if scheme == "wss" { 443 } else { 80 };
        let (host, port) = match hostport.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse()?),
            None => (hostport.to_string(), default),
        };
        Ok(Url { host, port })
    }
}

pub fn arg<T: std::str::FromStr>(name: &str, default: T) -> T {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Append a JSON result line to `results/<file>` for the README tables.
pub fn save(file: &str, v: serde_json::Value) {
    let _ = std::fs::create_dir_all("results");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!("results/{file}")) {
        let _ = writeln!(f, "{v}");
    }
}
