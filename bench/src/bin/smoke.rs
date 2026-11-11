//! Functional smoke test of every chat feature against a running server.
//!   smoke [--url ws://127.0.0.1:8080/ws]

use anyhow::{bail, ensure, Result};
use hopon_bench::{arg, Client};
use hopon_shared::time::now_us;
use hopon_shared::*;

async fn next_msg(c: &mut Client) -> Result<S2C> {
    loop {
        let f = tokio::time::timeout(std::time::Duration::from_secs(5), c.recv()).await??;
        if f.req == 0 {
            return Ok(f.msg);
        }
    }
}

macro_rules! check {
    ($name:expr, $e:expr) => {{
        let r: Result<()> = async { $e }.await;
        match &r {
            Ok(()) => println!("ok    {}", $name),
            Err(e) => println!("FAIL  {}: {e:#}", $name),
        }
        r.is_ok()
    }};
}

#[tokio::main]
async fn main() -> Result<()> {
    let url: String = arg("--url", "ws://127.0.0.1:8080/ws".to_string());
    let mut pass = true;
    let name = format!("smoke{:06x}", rand::random::<u32>() & 0xffffff);
    let mut a = Client::connect(&url).await?;
    let mut refresh = String::new();
    let mut access = String::new();

    pass &= check!("signup", {
        match a.call(C2S::Signup { username: name.clone(), password: "smoke-password".into() }).await? {
            S2C::Authed { refresh_token, access_token, .. } => { refresh = refresh_token; access = access_token; Ok(()) }
            o => bail!("{o:?}"),
        }
    });
    pass &= check!("duplicate signup rejected", {
        let mut c = Client::connect(&url).await?;
        ensure!(c.call(C2S::Signup { username: name.to_uppercase(), password: "smoke-password".into() }).await.is_err());
        Ok(())
    });
    pass &= check!("wrong password rejected", {
        let mut c = Client::connect(&url).await?;
        ensure!(c.call(C2S::Login { username: name.clone(), password: "nope-nope-nope".into() }).await.is_err());
        Ok(())
    });
    pass &= check!("unauthenticated send rejected", {
        let mut c = Client::connect(&url).await?;
        ensure!(c.call(C2S::Send { channel_id: 1, content: "x".into(), nonce: 1, t_input: 0, t_client_send: 0 }).await.is_err());
        Ok(())
    });
    pass &= check!("resume with access token", {
        let mut c = Client::connect(&url).await?;
        ensure!(matches!(c.call(C2S::Resume { access_token: access.clone() }).await?, S2C::Authed { .. }));
        Ok(())
    });
    pass &= check!("refresh token rotates (old one dies)", {
        let mut c = Client::connect(&url).await?;
        let S2C::Authed { refresh_token: new, .. } = c.call(C2S::Refresh { refresh_token: refresh.clone() }).await? else { bail!("no authed") };
        let mut d = Client::connect(&url).await?;
        ensure!(d.call(C2S::Refresh { refresh_token: refresh.clone() }).await.is_err(), "old refresh still valid");
        refresh = new;
        Ok(())
    });

    let mut server_id = 0;
    let mut text = 0;
    let mut voice = 0;
    pass &= check!("create server with default channels", {
        let S2C::ServerJoined(s) = a.call(C2S::CreateServer { name: "Smoke Test".into() }).await? else { bail!("no server") };
        server_id = s.id;
        text = s.channels.iter().find(|c| c.kind == ChannelKind::Text).map(|c| c.id).unwrap_or(0);
        voice = s.channels.iter().find(|c| c.kind == ChannelKind::Voice).map(|c| c.id).unwrap_or(0);
        ensure!(text != 0 && voice != 0);
        Ok(())
    });

    let mut b = Client::connect(&url).await?;
    b.signup("smokeb").await?;
    pass &= check!("non-member cannot read or send", {
        ensure!(b.call(C2S::History { channel_id: text, before: None, limit: 10 }).await.is_err());
        ensure!(b.call(C2S::Send { channel_id: text, content: "x".into(), nonce: 1, t_input: 0, t_client_send: 0 }).await.is_err());
        Ok(())
    });
    pass &= check!("invite link join + member event", {
        let S2C::Invite { code, .. } = a.call(C2S::CreateInvite { server_id }).await? else { bail!("no invite") };
        ensure!(matches!(b.call(C2S::JoinInvite { code: format!("hopon://invite/{code}") }).await?, S2C::ServerJoined(_)));
        ensure!(matches!(next_msg(&mut a).await?, S2C::MemberJoined { .. }));
        Ok(())
    });
    pass &= check!("bad invite rejected", {
        ensure!(b.call(C2S::JoinInvite { code: "notacode".into() }).await.is_err());
        Ok(())
    });

    let mut first_id = 0;
    pass &= check!("send: realtime delivery, echo, durable ack, ordering", {
        for i in 0..20u64 {
            let t = now_us();
            a.send(C2S::Send { channel_id: text, content: format!("m{i}"), nonce: 100 + i, t_input: t, t_client_send: t }).await?;
        }
        let mut last = 0;
        for i in 0..20u64 {
            let S2C::Message(m) = next_msg(&mut b).await? else { bail!("expected message") };
            ensure!(m.content == format!("m{i}"), "order: got {} at {i}", m.content);
            ensure!(m.id > last, "ids not increasing");
            if i == 0 { first_id = m.id; }
            last = m.id;
        }
        let (mut echoes, mut acks) = (0, 0);
        while echoes < 20 || acks < 20 {
            let f = tokio::time::timeout(std::time::Duration::from_secs(5), a.recv()).await??;
            match f.msg { S2C::Message(_) => echoes += 1, S2C::Ack { .. } => acks += 1, _ => {} }
        }
        Ok(())
    });
    pass &= check!("resend with same nonce is idempotent (one row, same id)", {
        let t = now_us();
        let mut a2 = Client::connect(&url).await?;
        a2.call(C2S::Refresh { refresh_token: refresh.clone() }).await.map(|r| if let S2C::Authed { refresh_token, .. } = r { refresh = refresh_token; }).ok();
        let send = C2S::Send { channel_id: text, content: "once".into(), nonce: 4242, t_input: t, t_client_send: t };
        a.send(send.clone()).await?;
        let S2C::Message(first) = next_msg(&mut b).await? else { bail!("expected message") };
        // Same nonce from another socket of the same user (as after a reconnect).
        a2.send(send).await?;
        let (mut echo_id, mut acked) = (0, false);
        while echo_id == 0 || !acked {
            let f = tokio::time::timeout(std::time::Duration::from_secs(5), a2.recv()).await??;
            match f.msg {
                S2C::Message(m) if m.nonce == 4242 => echo_id = m.id,
                S2C::Ack { id, nonce: 4242, .. } => { ensure!(id == first.id, "ack id differs"); acked = true }
                _ => {}
            }
        }
        ensure!(echo_id == first.id, "resend got a new id");
        // b must not see a second copy.
        if let Ok(Ok(f)) = tokio::time::timeout(std::time::Duration::from_millis(300), b.recv()).await {
            if let S2C::Message(m) = f.msg { bail!("duplicate broadcast: {}", m.content); }
        }
        let S2C::History { messages, .. } = b.call(C2S::History { channel_id: text, before: None, limit: 5 }).await? else { bail!("h") };
        ensure!(messages.iter().filter(|m| m.content == "once").count() == 1, "duplicate row");
        Ok(())
    });
    pass &= check!("empty and oversized messages rejected", {
        ensure!(a.call(C2S::Send { channel_id: text, content: "   ".into(), nonce: 1, t_input: 0, t_client_send: 0 }).await.is_err());
        ensure!(a.call(C2S::Send { channel_id: text, content: "x".repeat(4001), nonce: 1, t_input: 0, t_client_send: 0 }).await.is_err());
        Ok(())
    });
    pass &= check!("edit own message (broadcast)", {
        ensure!(matches!(a.call(C2S::Edit { channel_id: text, message_id: first_id, content: "edited".into() }).await?, S2C::Ok));
        loop { if let S2C::Edited { id, content, .. } = next_msg(&mut b).await? { ensure!(id == first_id && content == "edited"); break; } }
        Ok(())
    });
    pass &= check!("cannot edit or delete others' messages", {
        ensure!(b.call(C2S::Edit { channel_id: text, message_id: first_id, content: "hijack".into() }).await.is_err());
        ensure!(b.call(C2S::Delete { channel_id: text, message_id: first_id }).await.is_err());
        Ok(())
    });
    pass &= check!("history paging (newest first, before cursor, more flag)", {
        let S2C::History { messages: p1, more, .. } = b.call(C2S::History { channel_id: text, before: None, limit: 8 }).await? else { bail!("h") };
        ensure!(p1.len() == 8 && more && p1[0].content == "once" && p1[1].content == "m19");
        let S2C::History { messages: p2, .. } = b.call(C2S::History { channel_id: text, before: Some(p1[7].id), limit: 8 }).await? else { bail!("h") };
        ensure!(p2[0].id < p1[7].id && p2[0].content == "m12");
        let S2C::History { messages: p3, more, .. } = b.call(C2S::History { channel_id: text, before: Some(p2[7].id), limit: 8 }).await? else { bail!("h") };
        ensure!(p3.len() == 5 && !more, "got {} more={more}", p3.len());
        ensure!(p3.last().unwrap().content == "edited", "edit not persisted");
        Ok(())
    });
    pass &= check!("delete own message (broadcast + gone from history)", {
        ensure!(matches!(a.call(C2S::Delete { channel_id: text, message_id: first_id }).await?, S2C::Ok));
        loop { if let S2C::Deleted { id, .. } = next_msg(&mut b).await? { ensure!(id == first_id); break; } }
        let S2C::History { messages, .. } = b.call(C2S::History { channel_id: text, before: None, limit: 100 }).await? else { bail!("h") };
        ensure!(messages.len() == 20 && messages.iter().all(|m| m.id != first_id));
        Ok(())
    });
    pass &= check!("owner creates channel; members are told", {
        ensure!(matches!(a.call(C2S::CreateChannel { server_id, name: "random".into(), kind: ChannelKind::Text }).await?, S2C::Ok));
        loop { if let S2C::ChannelCreated(c) = next_msg(&mut b).await? { ensure!(c.name == "random"); break; } }
        ensure!(b.call(C2S::CreateChannel { server_id, name: "nope".into(), kind: ChannelKind::Text }).await.is_err());
        Ok(())
    });
    pass &= check!("voice grant + presence (join, mute, leave on disconnect)", {
        ensure!(matches!(a.call(C2S::VoiceGrant { channel_id: voice }).await?, S2C::VoiceGrant { .. }));
        ensure!(a.call(C2S::VoiceGrant { channel_id: text }).await.is_err());
        a.call(C2S::VoiceState { channel_id: Some(voice), muted: true, deafened: false }).await?;
        loop { if let S2C::VoicePresence { channel_id, muted, .. } = next_msg(&mut b).await? { ensure!(channel_id == Some(voice) && muted); break; } }
        let mut c = Client::connect(&url).await?;
        c.call(C2S::Refresh { refresh_token: refresh.clone() }).await.map(|_| ()).ok();
        drop(a);
        loop { if let S2C::VoicePresence { channel_id, .. } = next_msg(&mut b).await? { ensure!(channel_id.is_none()); break; } }
        Ok(())
    });
    pass &= check!("avatar: set/get, broadcast, rejects SVG and oversized", {
        let mut c = Client::connect(&url).await?;
        let S2C::Authed { .. } = c.call(C2S::Login { username: name.clone(), password: "smoke-password".into() }).await? else { bail!("login") };
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&[7u8; 200]);
        let S2C::UserUpdated(u) = c.call(C2S::SetAvatar { data: png.clone() }).await? else { bail!("set") };
        ensure!(u.avatar_v >= 1);
        loop { if let S2C::UserUpdated(x) = next_msg(&mut b).await? { ensure!(x.avatar_v == u.avatar_v); break; } }
        let S2C::Avatar { data, avatar_v, .. } = b.call(C2S::GetAvatar { user_id: u.id }).await? else { bail!("get") };
        ensure!(data == png && avatar_v == u.avatar_v, "avatar round trip");
        ensure!(c.call(C2S::SetAvatar { data: b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec() }).await.is_err(), "svg accepted");
        let mut big = png.clone(); big.resize(MAX_AVATAR_BYTES + 1, 0);
        ensure!(c.call(C2S::SetAvatar { data: big }).await.is_err(), "oversized accepted");
        Ok(())
    });
    pass &= check!("logout revokes the refresh token", {
        let mut c = Client::connect(&url).await?;
        let S2C::Authed { refresh_token, .. } = c.call(C2S::Login { username: name.clone(), password: "smoke-password".into() }).await? else { bail!("login") };
        ensure!(matches!(c.call(C2S::Logout { refresh_token: refresh_token.clone() }).await?, S2C::LoggedOut));
        let mut d = Client::connect(&url).await?;
        ensure!(d.call(C2S::Refresh { refresh_token }).await.is_err());
        Ok(())
    });

    println!("\n{}", if pass { "ALL PASSED" } else { "FAILURES" });
    std::process::exit(if pass { 0 } else { 1 });
}
