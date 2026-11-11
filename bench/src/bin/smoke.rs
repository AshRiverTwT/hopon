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


/// Wait for an unsolicited event matching `f` (skipping others), 5 s max.
async fn wait_for<T>(c: &mut Client, f: impl Fn(&S2C) -> Option<T>) -> Result<T> {
    loop {
        let m = next_msg(c).await?;
        if let Some(t) = f(&m) {
            return Ok(t);
        }
    }
}

/// True if no event matching `f` arrives within `ms`.
async fn quiet(c: &mut Client, ms: u64, f: impl Fn(&S2C) -> bool) -> bool {
    let end = tokio::time::Instant::now() + std::time::Duration::from_millis(ms);
    loop {
        match tokio::time::timeout_at(end, c.recv()).await {
            Err(_) => return true,
            Ok(Ok(fr)) if fr.req == 0 && f(&fr.msg) => return false,
            Ok(Ok(_)) => {}
            Ok(Err(_)) => return true,
        }
    }
}

/// Owner + member in a fresh server: (owner, member, server, text, voice, member id).
async fn admin_setup(url: &str) -> Result<(Client, Client, Id, Id, Id, Id)> {
    let mut o = Client::connect(url).await?;
    o.signup("own").await?;
    let S2C::ServerJoined(s) = o.call(C2S::CreateServer { name: "Admin Test".into() }).await? else { bail!("create") };
    let text = s.channels.iter().find(|c| c.kind == ChannelKind::Text).unwrap().id;
    let voice = s.channels.iter().find(|c| c.kind == ChannelKind::Voice).unwrap().id;
    let S2C::Invite { code, .. } = o.call(C2S::CreateInvite { server_id: s.id }).await? else { bail!("invite") };
    let mut m = Client::connect(url).await?;
    m.signup("mem").await?;
    m.call(C2S::JoinInvite { code: code.clone() }).await?;
    let mid = wait_for(&mut o, |e| if let S2C::MemberJoined { user, .. } = e { Some(user.id) } else { None }).await?;
    Ok((o, m, s.id, text, voice, mid))
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
        ensure!(c.call(C2S::Send { channel_id: 1, content: "x".into(), nonce: 1, t_input: 0, t_client_send: 0, reply_to: None }).await.is_err());
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
        ensure!(b.call(C2S::Send { channel_id: text, content: "x".into(), nonce: 1, t_input: 0, t_client_send: 0, reply_to: None }).await.is_err());
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
            a.send(C2S::Send { channel_id: text, content: format!("m{i}"), nonce: 100 + i, t_input: t, t_client_send: t, reply_to: None }).await?;
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
        let send = C2S::Send { channel_id: text, content: "once".into(), nonce: 4242, t_input: t, t_client_send: t, reply_to: None };
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
        ensure!(a.call(C2S::Send { channel_id: text, content: "   ".into(), nonce: 1, t_input: 0, t_client_send: 0, reply_to: None }).await.is_err());
        ensure!(a.call(C2S::Send { channel_id: text, content: "x".repeat(4001), nonce: 1, t_input: 0, t_client_send: 0, reply_to: None }).await.is_err());
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
    pass &= check!("admin: non-owners are refused everything", {
        let (_o, mut m, sid, text, voice, _) = admin_setup(&url).await?;
        let deny = |r: Result<S2C>| match r { Err(e) if e.to_string().contains("Forbidden") => Ok(()), other => Err(anyhow::anyhow!("not forbidden: {other:?}")) };
        deny(m.call(C2S::RenameServer { server_id: sid, name: "x".into() }).await)?;
        deny(m.call(C2S::UpdateChannel { channel_id: text, name: Some("x".into()), topic: None }).await)?;
        deny(m.call(C2S::DeleteChannel { channel_id: voice }).await)?;
        deny(m.call(C2S::DeleteServer { server_id: sid }).await)?;
        deny(m.call(C2S::Kick { server_id: sid, user_id: 1 }).await)?;
        deny(m.call(C2S::RevokeInvites { server_id: sid }).await)?;
        Ok(())
    });
    pass &= check!("admin: rename server and channel, set topic (broadcast)", {
        let (mut o, mut m, sid, text, _, _) = admin_setup(&url).await?;
        o.call(C2S::RenameServer { server_id: sid, name: "  Renamed  ".into() }).await?;
        let n = wait_for(&mut m, |e| if let S2C::ServerUpdated { name, .. } = e { Some(name.clone()) } else { None }).await?;
        ensure!(n == "Renamed", "got {n}");
        o.call(C2S::UpdateChannel { channel_id: text, name: Some("lobby".into()), topic: Some("say hi".into()) }).await?;
        let c = wait_for(&mut m, |e| if let S2C::ChannelUpdated(c) = e { Some(c.clone()) } else { None }).await?;
        ensure!(c.name == "lobby" && c.topic == "say hi");
        ensure!(o.call(C2S::UpdateChannel { channel_id: text, name: None, topic: Some("t".repeat(MAX_TOPIC_CHARS + 1)) }).await.is_err());
        ensure!(o.call(C2S::RenameServer { server_id: sid, name: "   ".into() }).await.is_err());
        Ok(())
    });
    pass &= check!("admin: owner can delete anyone's message", {
        let (mut o, mut m, _, text, _, _) = admin_setup(&url).await?;
        let t = now_us();
        m.send(C2S::Send { channel_id: text, content: "spam".into(), nonce: 9, t_input: t, t_client_send: t, reply_to: None }).await?;
        let id = wait_for(&mut o, |e| if let S2C::Message(x) = e { Some(x.id) } else { None }).await?;
        ensure!(matches!(o.call(C2S::Delete { channel_id: text, message_id: id }).await?, S2C::Ok));
        Ok(())
    });
    pass &= check!("admin: delete text channel (gone for sends and history)", {
        let (mut o, mut m, _, text, _, _) = admin_setup(&url).await?;
        let t = now_us();
        m.send(C2S::Send { channel_id: text, content: "before".into(), nonce: 1, t_input: t, t_client_send: t, reply_to: None }).await?;
        wait_for(&mut o, |e| matches!(e, S2C::Message(_)).then_some(())).await?;
        o.call(C2S::DeleteChannel { channel_id: text }).await?;
        wait_for(&mut m, |e| matches!(e, S2C::ChannelDeleted { channel_id, .. } if *channel_id == text).then_some(())).await?;
        ensure!(m.call(C2S::Send { channel_id: text, content: "after".into(), nonce: 2, t_input: t, t_client_send: t, reply_to: None }).await.is_err(), "send into deleted channel");
        ensure!(m.call(C2S::History { channel_id: text, before: None, limit: 10 }).await.is_err(), "history of deleted channel");
        Ok(())
    });
    pass &= check!("admin: delete voice channel clears who's in it", {
        let (mut o, mut m, _, _, voice, _) = admin_setup(&url).await?;
        m.call(C2S::VoiceState { channel_id: Some(voice), muted: false, deafened: false }).await?;
        wait_for(&mut o, |e| matches!(e, S2C::VoicePresence { channel_id: Some(_), .. }).then_some(())).await?;
        o.call(C2S::DeleteChannel { channel_id: voice }).await?;
        wait_for(&mut o, |e| matches!(e, S2C::VoicePresence { channel_id: None, .. }).then_some(())).await?;
        Ok(())
    });
    pass &= check!("admin: kick (member removed, stops receiving, told why)", {
        let (mut o, mut m, sid, text, voice, mid) = admin_setup(&url).await?;
        m.call(C2S::VoiceState { channel_id: Some(voice), muted: false, deafened: false }).await?;
        o.call(C2S::Kick { server_id: sid, user_id: mid }).await?;
        let r = wait_for(&mut m, |e| if let S2C::ServerRemoved { reason, .. } = e { Some(*reason) } else { None }).await?;
        ensure!(r == RemovedReason::Kicked);
        wait_for(&mut o, |e| matches!(e, S2C::MemberLeft { user_id, .. } if *user_id == mid).then_some(())).await?;
        let t = now_us();
        ensure!(m.call(C2S::Send { channel_id: text, content: "still here?".into(), nonce: 3, t_input: t, t_client_send: t, reply_to: None }).await.is_err(), "kicked user can send");
        o.send(C2S::Send { channel_id: text, content: "secret".into(), nonce: 4, t_input: t, t_client_send: t, reply_to: None }).await?;
        ensure!(quiet(&mut m, 400, |e| matches!(e, S2C::Message(_))).await, "kicked user still receives messages");
        ensure!(o.call(C2S::Kick { server_id: sid, user_id: mid }).await.is_err(), "double kick");
        Ok(())
    });
    pass &= check!("admin: leave server; owner cannot leave", {
        let (mut o, mut m, sid, _, _, mid) = admin_setup(&url).await?;
        m.call(C2S::LeaveServer { server_id: sid }).await?;
        let r = wait_for(&mut o, |e| if let S2C::MemberLeft { user_id, reason, .. } = e { (*user_id == mid).then_some(*reason) } else { None }).await?;
        ensure!(r == RemovedReason::Left);
        ensure!(o.call(C2S::LeaveServer { server_id: sid }).await.is_err(), "owner left");
        Ok(())
    });
    pass &= check!("admin: revoke invites", {
        let (mut o, _m, sid, _, _, _) = admin_setup(&url).await?;
        let S2C::Invite { code, .. } = o.call(C2S::CreateInvite { server_id: sid }).await? else { bail!("invite") };
        o.call(C2S::RevokeInvites { server_id: sid }).await?;
        let mut x = Client::connect(&url).await?;
        x.signup("late").await?;
        ensure!(x.call(C2S::JoinInvite { code }).await.is_err(), "revoked invite still works");
        Ok(())
    });
    pass &= check!("admin: delete server (everyone told, data gone)", {
        let (mut o, mut m, sid, text, _, _) = admin_setup(&url).await?;
        o.call(C2S::DeleteServer { server_id: sid }).await?;
        let r = wait_for(&mut m, |e| if let S2C::ServerRemoved { reason, .. } = e { Some(*reason) } else { None }).await?;
        ensure!(r == RemovedReason::Deleted);
        ensure!(o.call(C2S::History { channel_id: text, before: None, limit: 5 }).await.is_err(), "history after delete");
        ensure!(o.call(C2S::RenameServer { server_id: sid, name: "zombie".into() }).await.is_err(), "rename after delete");
        Ok(())
    });
    pass &= check!("read state: forward-only, synced to other devices, in the snapshot; own sends count as read", {
        let mut o = Client::connect(&url).await?;
        let ou = o.signup("rown").await?;
        let S2C::ServerJoined(sv) = o.call(C2S::CreateServer { name: "Reads".into() }).await? else { bail!("create") };
        let text = sv.channels.iter().find(|c| c.kind == ChannelKind::Text).unwrap().id;
        let S2C::Invite { code, .. } = o.call(C2S::CreateInvite { server_id: sv.id }).await? else { bail!("invite") };
        let mut m = Client::connect(&url).await?;
        let mu = m.signup("rmem").await?;
        m.call(C2S::JoinInvite { code }).await?;
        let mut newest = 0;
        for i in 0..3u64 {
            let t = now_us();
            o.send(C2S::Send { channel_id: text, content: format!("r{i}"), nonce: 50 + i, t_input: t, t_client_send: t, reply_to: None }).await?;
            newest = wait_for(&mut m, |e| if let S2C::Message(x) = e { Some(x.id) } else { None }).await?;
        }
        // Second device of the member sees the marker move.
        let mut m2 = Client::connect(&url).await?;
        m2.call(C2S::Login { username: mu.name.clone(), password: "benchmark-pass".into() }).await?;
        m.call(C2S::MarkRead { channel_id: text, message_id: newest }).await?;
        let lr = wait_for(&mut m2, |e| if let S2C::ReadUpdated { last_read, .. } = e { Some(*last_read) } else { None }).await?;
        ensure!(lr == newest, "other device not told");
        m.call(C2S::MarkRead { channel_id: text, message_id: newest - 1 }).await?;
        // (m's own copy is skipped by call() while it waits for the reply.)
        let lr2 = wait_for(&mut m2, |e| if let S2C::ReadUpdated { last_read, .. } = e { Some(*last_read) } else { None }).await?;
        ensure!(lr2 == newest, "marker moved backwards");
        // Fresh login: snapshot carries last_id and the marker.
        let mut m3 = Client::connect(&url).await?;
        let S2C::Authed { servers, .. } = m3.call(C2S::Login { username: mu.name.clone(), password: "benchmark-pass".into() }).await? else { bail!("login") };
        let s3 = servers.iter().find(|x| x.id == sv.id).unwrap();
        ensure!(s3.channels.iter().find(|c| c.id == text).unwrap().last_id == newest, "last_id");
        ensure!(s3.reads.contains(&(text, newest)), "reads {:?}", s3.reads);
        // The author's own sends marked the channel read for them.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let mut o2 = Client::connect(&url).await?;
        let S2C::Authed { servers, .. } = o2.call(C2S::Login { username: ou.name.clone(), password: "benchmark-pass".into() }).await? else { bail!("login") };
        let so = servers.iter().find(|x| x.id == sv.id).unwrap();
        ensure!(so.reads.contains(&(text, newest)), "own sends not read: {:?}", so.reads);
        ensure!(so.online.contains(&mu.id), "member not listed online");
        Ok(())
    });
    pass &= check!("presence: offline announced after the last connection closes", {
        let (mut o, m, _, _, _, mid) = admin_setup(&url).await?;
        drop(m);
        let off = wait_for(&mut o, |e| if let S2C::UserPresence { user_id, online } = e { (*user_id == mid).then_some(*online) } else { None }).await?;
        ensure!(!off, "expected offline");
        Ok(())
    });
    pass &= check!("replies + reactions (broadcast, idempotent, in history, limits, ordering)", {
        let (mut o, mut m, _, text, _, _) = admin_setup(&url).await?;
        let t = now_us();
        o.send(C2S::Send { channel_id: text, content: "root".into(), nonce: 70, t_input: t, t_client_send: t, reply_to: None }).await?;
        let root = wait_for(&mut m, |e| if let S2C::Message(x) = e { (x.content == "root").then_some(x.id) } else { None }).await?;
        m.send(C2S::Send { channel_id: text, content: "re".into(), nonce: 71, t_input: t, t_client_send: t, reply_to: Some(root) }).await?;
        let rep = wait_for(&mut o, |e| if let S2C::Message(x) = e { (x.content == "re").then(|| x.clone()) } else { None }).await?;
        ensure!(rep.reply_to == Some(root), "reply_to not delivered");
        // React immediately after sending: the reaction must wait for the insert.
        o.send(C2S::Send { channel_id: text, content: "fresh".into(), nonce: 72, t_input: t, t_client_send: t, reply_to: None }).await?;
        let fresh = wait_for(&mut m, |e| if let S2C::Message(x) = e { (x.content == "fresh").then_some(x.id) } else { None }).await?;
        ensure!(matches!(m.call(C2S::React { channel_id: text, message_id: fresh, emoji: "🔥".into(), add: true }).await?, S2C::Ok), "react on fresh message");
        m.call(C2S::React { channel_id: text, message_id: root, emoji: "👍".into(), add: true }).await?;
        let (e1, add) = wait_for(&mut o, |e| if let S2C::Reaction { emoji, add, message_id, .. } = e { (*message_id == root).then(|| (emoji.clone(), *add)) } else { None }).await?;
        ensure!(e1 == "👍" && add);
        // Idempotent: second add changes nothing and broadcasts nothing.
        m.call(C2S::React { channel_id: text, message_id: root, emoji: "👍".into(), add: true }).await?;
        ensure!(quiet(&mut o, 300, |e| matches!(e, S2C::Reaction { .. })).await, "duplicate reaction broadcast");
        o.call(C2S::React { channel_id: text, message_id: root, emoji: "👍".into(), add: true }).await?;
        let S2C::History { messages, .. } = o.call(C2S::History { channel_id: text, before: None, limit: 10 }).await? else { bail!("h") };
        let r = messages.iter().find(|x| x.id == root).unwrap();
        ensure!(r.reactions.len() == 1 && r.reactions[0].users.len() == 2, "aggregate {:?}", r.reactions);
        ensure!(messages.iter().find(|x| x.id == rep.id).unwrap().reply_to == Some(root), "reply_to not persisted");
        m.call(C2S::React { channel_id: text, message_id: root, emoji: "👍".into(), add: false }).await?;
        let S2C::History { messages, .. } = o.call(C2S::History { channel_id: text, before: None, limit: 10 }).await? else { bail!("h") };
        ensure!(messages.iter().find(|x| x.id == root).unwrap().reactions[0].users.len() == 1, "remove");
        ensure!(m.call(C2S::React { channel_id: text, message_id: root, emoji: "lol".into(), add: true }).await.is_err(), "text reaction accepted");
        ensure!(m.call(C2S::React { channel_id: text, message_id: 12345, emoji: "👍".into(), add: true }).await.is_err(), "reaction on missing message");
        let emojis = ["😀","😁","😂","🤣","😃","😄","😅","😆","😉","😊","😋","😎","😍","😘","🥰","😗","😙","😚","🙂","🤗"];
        for e in emojis.iter().skip(1) { o.call(C2S::React { channel_id: text, message_id: root, emoji: (*e).into(), add: true }).await?; }
        ensure!(o.call(C2S::React { channel_id: text, message_id: root, emoji: "🦀".into(), add: true }).await.is_err(), "21st distinct reaction accepted");
        // Deleting the message drops its reactions.
        o.call(C2S::Delete { channel_id: text, message_id: root }).await?;
        let n: Vec<_> = { let S2C::History { messages, .. } = o.call(C2S::History { channel_id: text, before: None, limit: 10 }).await? else { bail!("h") }; messages };
        ensure!(!n.iter().any(|x| x.id == root));
        Ok(())
    });
    pass &= check!("typing: relayed to others, rate-limited", {
        let (mut o, mut m, _, text, _, mid) = admin_setup(&url).await?;
        m.send(C2S::Typing { channel_id: text }).await?;
        let who = wait_for(&mut o, |e| if let S2C::Typing { user_id, .. } = e { Some(*user_id) } else { None }).await?;
        ensure!(who == mid);
        m.send(C2S::Typing { channel_id: text }).await?;
        ensure!(quiet(&mut o, 400, |e| matches!(e, S2C::Typing { .. })).await, "not rate-limited");
        Ok(())
    });
    pass &= check!("preferences: saved to the account, in the login snapshot, synced live, validated", {
        let mut a1 = Client::connect(&url).await?;
        let u = a1.signup("pref").await?;
        let mut a2 = Client::connect(&url).await?;
        let S2C::Authed { prefs, .. } = a2.call(C2S::Login { username: u.name.clone(), password: "benchmark-pass".into() }).await? else { bail!("login") };
        ensure!(prefs == "{}", "fresh prefs {prefs}");
        let j = r#"{"sounds":false,"pttKey":20,"recentEmoji":["🔥"]}"#.to_string();
        ensure!(matches!(a1.call(C2S::SavePrefs { json: j.clone() }).await?, S2C::Ok));
        let got = wait_for(&mut a2, |e| if let S2C::PrefsUpdated { json } = e { Some(json.clone()) } else { None }).await?;
        ensure!(got == j, "live sync");
        let mut a3 = Client::connect(&url).await?;
        let S2C::Authed { prefs, .. } = a3.call(C2S::Login { username: u.name.clone(), password: "benchmark-pass".into() }).await? else { bail!("login") };
        ensure!(prefs == j, "not persisted: {prefs}");
        ensure!(a1.call(C2S::SavePrefs { json: "[1,2]".into() }).await.is_err(), "non-object accepted");
        ensure!(a1.call(C2S::SavePrefs { json: format!("{{\"x\":\"{}\"}}", "a".repeat(MAX_PREFS_BYTES)) }).await.is_err(), "oversized accepted");
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
