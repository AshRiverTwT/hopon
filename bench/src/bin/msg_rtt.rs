//! Text-path latency benchmark.
//!
//!   msg_rtt [--url ws://127.0.0.1:8080/ws] [--n 2000] [--rate 50]
//!           [--receivers 1] [--warmup 100] [--label lan]
//!
//! One author and N receivers (separate sockets; same machine, so one clock)
//! join a channel. The author sends paced messages and we report:
//!   ws ping rtt                    transport floor
//!   author send->receiver decoded  network + server part of send-to-display
//!   author send->own echo          what the author's own UI waits for
//!   author send->ack (durable)     committed in Postgres
//!   client send->server recv       uplink
//!   server recv->fanout            server processing (trace stamps)
//! UI render time is measured inside the app and added on top.

use anyhow::{bail, Result};
use futures_util::{SinkExt, StreamExt};
use hopon_bench::{arg, save, Client};
use hopon_shared::stats::Latency;
use hopon_shared::time::now_us;
use hopon_shared::*;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as WsMsg;

#[tokio::main]
async fn main() -> Result<()> {
    let url: String = arg("--url", "ws://127.0.0.1:8080/ws".to_string());
    let n: usize = arg("--n", 2000);
    let rate: f64 = arg("--rate", 50.0);
    let receivers: usize = arg("--receivers", 1);
    let warmup: usize = arg("--warmup", 100);
    let label: String = arg("--label", "local".to_string());
    let total = warmup + n;

    // --- setup ---
    let mut author = Client::connect(&url).await?;
    author.signup("bencha").await?;
    let (server_id, channel_id) = match author.call(C2S::CreateServer { name: "bench".into() }).await? {
        S2C::ServerJoined(s) => (s.id, s.channels.iter().find(|c| c.kind == ChannelKind::Text).unwrap().id),
        o => bail!("unexpected {o:?}"),
    };
    let code = match author.call(C2S::CreateInvite { server_id }).await? {
        S2C::Invite { code, .. } => code,
        o => bail!("unexpected {o:?}"),
    };

    let mut rx_tasks = vec![];
    for _ in 0..receivers {
        let mut c = Client::connect(&url).await?;
        c.signup("benchr").await?;
        c.call(C2S::JoinInvite { code: code.clone() }).await?;
        rx_tasks.push(tokio::spawn(async move {
            let mut one_way = Latency::new("author send->receiver decoded");
            let mut got = 0usize;
            while got < total {
                if let S2C::Message(m) = c.recv().await?.msg {
                    let t = now_us();
                    if (m.nonce as usize) >= warmup {
                        one_way.record_us(t - m.trace.unwrap().t_client_send);
                    }
                    got += 1;
                }
            }
            anyhow::Ok(one_way)
        }));
    }

    // --- transport floor ---
    let mut ping = Latency::new("ws ping rtt");
    for _ in 0..300 {
        let t0 = now_us();
        author.call(C2S::Ping { t_client: t0 }).await?;
        ping.record_us(now_us() - t0);
    }

    // --- paced sends ---
    let sent: Arc<Vec<AtomicI64>> = Arc::new((0..total).map(|_| AtomicI64::new(0)).collect());
    let (mut sink, mut stream) = author.ws.split();
    let sent_r = sent.clone();
    let reader = tokio::spawn(async move {
        let mut echo = Latency::new("author send->own echo");
        let mut ack = Latency::new("author send->ack (durable)");
        let mut up = Latency::new("client send->server recv");
        let mut fanout = Latency::new("server recv->fanout");
        let (mut echoes, mut acks) = (0, 0);
        while echoes < total || acks < total {
            let Some(Ok(WsMsg::Binary(b))) = stream.next().await else { bail!("socket closed") };
            let f: ServerFrame = decode(&b)?;
            let t = now_us();
            match f.msg {
                S2C::Message(m) => {
                    echoes += 1;
                    if (m.nonce as usize) >= warmup {
                        let tr = m.trace.unwrap();
                        echo.record_us(t - tr.t_client_send);
                        up.record_us(tr.t_server_recv - tr.t_client_send);
                        fanout.record_us(tr.t_server_send - tr.t_server_recv);
                    }
                }
                S2C::Ack { nonce, .. } => {
                    acks += 1;
                    if (nonce as usize) >= warmup {
                        ack.record_us(t - sent_r[nonce as usize].load(Ordering::Relaxed));
                    }
                }
                S2C::Error { message, .. } => bail!("server error: {message}"),
                _ => {}
            }
        }
        Ok([echo, ack, up, fanout])
    });

    let interval = Duration::from_secs_f64(1.0 / rate);
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let started = std::time::Instant::now();
    for i in 0..total {
        tick.tick().await;
        let t = now_us();
        sent[i].store(t, Ordering::Relaxed);
        let f = ClientFrame {
            req: 1_000 + i as u32,
            msg: C2S::Send { channel_id, content: format!("bench message {i}"), nonce: i as u64, t_input: t, t_client_send: t, reply_to: None },
        };
        sink.send(WsMsg::Binary(encode(&f).into())).await?;
    }
    let mut hs = tokio::time::timeout(Duration::from_secs(30), reader).await???.into_iter().collect::<Vec<_>>();
    let mut recv_all = Latency::new("author send->receiver decoded");
    for t in rx_tasks {
        recv_all.merge(&tokio::time::timeout(Duration::from_secs(30), t).await???);
    }
    let secs = started.elapsed().as_secs_f64();

    println!("\nmsg_rtt  label={label}  n={n}  rate={rate}/s  receivers={receivers}  ({secs:.1}s)");
    println!("{}", ping.line());
    println!("{}", recv_all.line());
    for h in &hs {
        println!("{}", h.line());
    }
    let target = 100.0;
    let p95 = recv_all.summary().p95_ms;
    println!(
        "\nsend->receiver p95 = {p95:.3} ms  (LAN target {target} ms incl. render: {})",
        if p95 < target { "within budget" } else { "OVER" }
    );
    hs.insert(0, recv_all);
    hs.insert(0, ping);
    let rows: Vec<_> = hs.iter().map(|h| serde_json::json!({ "name": h.name, "stats": h.summary() })).collect();
    save("msg_rtt.jsonl", serde_json::json!({ "label": label, "n": n, "rate": rate, "receivers": receivers, "t": now_us(), "results": rows }));
    Ok(())
}
