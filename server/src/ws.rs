//! One WebSocket per client. A reader loop handles requests; a writer task
//! owns the socket sink plus every guild subscription and coalesces writes
//! (feed everything that is ready, then one flush).

use crate::auth;
use crate::persist::{AckTo, PersistOp};
use crate::state::{kind_to_i16, ConnTx, Out, State, VoiceEntry, CONN_QUEUE};
use crate::voice;
use axum::extract::ws::{Message as WsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::State as AxState;
use axum::response::Response;
use bytes::Bytes;
use futures_util::{FutureExt, SinkExt, StreamExt};
use hopon_shared::time::now_us;
use hopon_shared::*;
use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::{errors::BroadcastStreamRecvError, BroadcastStream};
use tokio_stream::StreamMap;

pub async fn handler(ws: WebSocketUpgrade, AxState(st): AxState<Arc<State>>) -> Response {
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .write_buffer_size(0)
        .on_upgrade(move |s| connection(st, s))
}

async fn connection(st: Arc<State>, socket: WebSocket) {
    st.metrics.connections.fetch_add(1, Ordering::Relaxed);
    let (sink, mut stream) = socket.split();
    let (tx, rx) = mpsc::channel(CONN_QUEUE);
    let writer = tokio::spawn(writer(st.clone(), sink, rx));
    let mut s = Session::new(st.clone(), tx);

    // Unauthenticated sockets get 60 s to log in.
    let deadline = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(deadline);
    loop {
        let next = tokio::select! {
            m = stream.next() => m,
            _ = &mut deadline, if s.user.is_none() => break,
        };
        match next {
            Some(Ok(WsMsg::Binary(b))) => {
                let t = now_us();
                match decode::<ClientFrame>(&b) {
                    Ok(f) => s.handle(f, t).await,
                    Err(e) => s.err(0, ErrorCode::BadRequest, &e.0).await,
                }
                if s.closed {
                    break;
                }
            }
            Some(Ok(WsMsg::Close(_))) | None | Some(Err(_)) => break,
            Some(Ok(_)) => {} // ping/pong handled by the transport; text ignored
        }
    }
    s.cleanup();
    let _ = s.tx.send(Out::Close).await;
    drop(s);
    let _ = writer.await;
    st.metrics.connections.fetch_sub(1, Ordering::Relaxed);
}

async fn writer(st: Arc<State>, mut sink: futures_util::stream::SplitSink<WebSocket, WsMsg>, mut rx: mpsc::Receiver<Out>) {
    let mut subs: StreamMap<Id, BroadcastStream<Bytes>> = StreamMap::new();
    // Returns false when the connection should end.
    let apply = |o: Out, subs: &mut StreamMap<Id, BroadcastStream<Bytes>>, frames: &mut Vec<Bytes>| -> bool {
        match o {
            Out::Frame(b) => frames.push(b),
            Out::Subscribe(id, r) => {
                subs.insert(id, BroadcastStream::new(r));
            }
            Out::UnsubscribeAll => subs.clear(),
            Out::Close => return false,
        }
        true
    };
    let mut frames: Vec<Bytes> = Vec::with_capacity(64);
    'outer: loop {
        tokio::select! {
            biased;
            o = rx.recv() => match o {
                Some(o) => if !apply(o, &mut subs, &mut frames) { break },
                None => break,
            },
            Some((_, item)) = subs.next(), if !subs.is_empty() => match item {
                Ok(b) => frames.push(b),
                Err(BroadcastStreamRecvError::Lagged(_)) => {
                    // Too slow to keep up: drop the socket, the client reconnects and resyncs.
                    st.metrics.lagged_disconnects.fetch_add(1, Ordering::Relaxed);
                    break;
                }
            },
        }
        // Drain whatever else is ready without waiting, then write once.
        while frames.len() < 256 {
            if let Ok(o) = rx.try_recv() {
                if !apply(o, &mut subs, &mut frames) {
                    break 'outer;
                }
                continue;
            }
            match subs.next().now_or_never() {
                Some(Some((_, Ok(b)))) => frames.push(b),
                Some(Some((_, Err(_)))) => {
                    st.metrics.lagged_disconnects.fetch_add(1, Ordering::Relaxed);
                    break 'outer;
                }
                _ => break,
            }
        }
        if frames.is_empty() {
            continue;
        }
        for b in frames.drain(..) {
            if sink.feed(WsMsg::Binary(b)).await.is_err() {
                break 'outer;
            }
        }
        if sink.flush().await.is_err() {
            break;
        }
    }
    let _ = sink.close().await;
}

struct Session {
    st: Arc<State>,
    tx: ConnTx,
    conn: u64,
    user: Option<(Id, String)>,
    guilds: HashSet<Id>,
    auth_attempts: u32,
    // Token bucket for sends: `send_rate`/s, burst 3x.
    bucket: f64,
    bucket_t: Instant,
    closed: bool,
}

fn frame(req: u32, msg: S2C) -> Bytes {
    Bytes::from(encode(&ServerFrame { req, msg }))
}

impl Session {
    fn new(st: Arc<State>, tx: ConnTx) -> Self {
        let conn = st.conn_id();
        let bucket = st.cfg.send_rate * 3.0;
        Self { st, tx, conn, user: None, guilds: HashSet::new(), auth_attempts: 0, bucket, bucket_t: Instant::now(), closed: false }
    }

    async fn send(&mut self, req: u32, msg: S2C) {
        if self.tx.send(Out::Frame(frame(req, msg))).await.is_err() {
            self.closed = true;
        }
    }

    async fn err(&mut self, req: u32, code: ErrorCode, m: &str) {
        self.send(req, S2C::Error { code, message: m.to_owned() }).await;
    }

    fn take_token(&mut self) -> bool {
        let now = Instant::now();
        let rate = self.st.cfg.send_rate;
        self.bucket = (self.bucket + now.duration_since(self.bucket_t).as_secs_f64() * rate).min(rate * 3.0);
        self.bucket_t = now;
        if self.bucket >= 1.0 {
            self.bucket -= 1.0;
            true
        } else {
            false
        }
    }

    fn cleanup(&mut self) {
        if let Some((uid, _)) = self.user.take() {
            self.st.unregister(uid, self.conn);
            self.leave_voice(uid);
        }
    }

    fn leave_voice(&self, uid: Id) {
        let prev = {
            let mut v = self.st.voice.lock();
            match v.get(&uid) {
                Some(e) if e.conn_id == self.conn => v.remove(&uid),
                _ => None,
            }
        };
        if let Some(e) = prev {
            if let Some(g) = self.st.guilds.get(&e.server_id) {
                g.publish(frame(0, S2C::VoicePresence { server_id: e.server_id, user_id: uid, channel_id: None, muted: false, deafened: false }));
            }
        }
    }

    async fn handle(&mut self, f: ClientFrame, t_recv: i64) {
        let req = f.req;
        let r = match f.msg {
            C2S::Ping { t_client } => {
                self.send(req, S2C::Pong { t_client, t_server: now_us() }).await;
                Ok(())
            }
            C2S::Signup { username, password } => self.signup(req, username, password).await,
            C2S::Login { username, password } => self.login(req, username, password).await,
            C2S::Resume { access_token } => self.resume(req, access_token).await,
            C2S::Refresh { refresh_token } => self.refresh(req, refresh_token).await,
            other => match self.user.clone() {
                None => Err((ErrorCode::Unauthorized, "log in first".into())),
                Some((uid, name)) => self.authed(req, uid, &name, other, t_recv).await,
            },
        };
        if let Err((code, m)) = r {
            self.err(req, code, &m).await;
        }
    }

    // ---------- auth ----------

    fn auth_gate(&mut self) -> Result<(), (ErrorCode, String)> {
        self.auth_attempts += 1;
        if self.auth_attempts > 10 {
            self.closed = true;
            return Err((ErrorCode::RateLimited, "too many attempts".into()));
        }
        Ok(())
    }

    async fn signup(&mut self, req: u32, username: String, password: String) -> R {
        self.auth_gate()?;
        if !auth::valid_username(&username) {
            return Err((ErrorCode::BadRequest, "username must be 2-32 letters, digits, _ . -".into()));
        }
        if !auth::valid_password(&password) {
            return Err((ErrorCode::BadRequest, "password must be at least 8 characters".into()));
        }
        let hash = auth::hash_password(password).await.map_err(internal)?;
        let id = self.st.ids.next();
        let row: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO users (id, name, name_lower, pw_hash) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (name_lower) DO NOTHING RETURNING id",
        )
        .bind(id)
        .bind(&username)
        .bind(username.to_lowercase())
        .bind(hash)
        .fetch_optional(&self.st.db)
        .await
        .map_err(internal)?;
        if row.is_none() {
            return Err((ErrorCode::Conflict, "username taken".into()));
        }
        self.establish(req, id, username, true).await
    }

    async fn login(&mut self, req: u32, username: String, password: String) -> R {
        self.auth_gate()?;
        let row: Option<(i64, String, String)> =
            sqlx::query_as("SELECT id, name, pw_hash FROM users WHERE name_lower = $1")
                .bind(username.to_lowercase())
                .fetch_optional(&self.st.db)
                .await
                .map_err(internal)?;
        // Verify against a dummy hash on unknown users so timing does not leak existence.
        const DUMMY: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$J3Lw6rI6Bt0mWkh0H9r0V9P9oQkq1d5r9b0b1a2Yc3s";
        let (id, name, hash) = row.clone().unwrap_or((0, String::new(), DUMMY.into()));
        if !auth::verify_password(password, hash).await || row.is_none() {
            return Err((ErrorCode::Unauthorized, "wrong username or password".into()));
        }
        self.establish(req, id, name, true).await
    }

    async fn resume(&mut self, req: u32, token: String) -> R {
        self.auth_gate()?;
        let (id, name) = self.st.keys.verify(&token).ok_or((ErrorCode::Unauthorized, "token expired".into()))?;
        self.establish(req, id, name, false).await
    }

    async fn refresh(&mut self, req: u32, token: String) -> R {
        self.auth_gate()?;
        let row: Option<(i64, String)> = sqlx::query_as(
            "DELETE FROM refresh_tokens r USING users u WHERE r.token_hash = $1 AND r.user_id = u.id \
             AND r.expires_at > now() RETURNING u.id, u.name",
        )
        .bind(auth::hash_refresh(&token))
        .fetch_optional(&self.st.db)
        .await
        .map_err(internal)?;
        let (id, name) = row.ok_or((ErrorCode::Unauthorized, "session expired".into()))?;
        self.establish(req, id, name, true).await
    }

    async fn establish(&mut self, req: u32, uid: Id, name: String, new_refresh: bool) -> R {
        if self.user.is_some() {
            self.cleanup();
            let _ = self.tx.send(Out::UnsubscribeAll).await;
            self.guilds.clear();
        }
        let refresh_token = if new_refresh {
            let (tok, h) = auth::new_refresh();
            sqlx::query("INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))")
                .bind(h)
                .bind(uid)
                .bind(auth::REFRESH_TTL_S as f64)
                .execute(&self.st.db)
                .await
                .map_err(internal)?;
            tok
        } else {
            String::new()
        };
        let servers = self.st.load_servers(uid, None).await.map_err(internal)?;
        // Subscribe before replying so no event can fall between snapshot and stream.
        for s in &servers {
            self.subscribe(s.id).await;
        }
        let voice = {
            let v = self.st.voice.lock();
            v.iter()
                .filter(|(_, e)| self.guilds.contains(&e.server_id))
                .map(|(u, e)| VoicePresence { channel_id: e.channel_id, user_id: *u, muted: e.muted, deafened: e.deafened })
                .collect()
        };
        self.user = Some((uid, name.clone()));
        self.st.register(uid, self.conn, self.tx.clone());
        let access_token = self.st.keys.access_token(uid, &name);
        self.send(req, S2C::Authed { user: UserInfo { id: uid, name }, access_token, refresh_token, servers, voice }).await;
        Ok(())
    }

    async fn subscribe(&mut self, server_id: Id) {
        if let Some(g) = self.st.guilds.get(&server_id) {
            if self.guilds.insert(server_id) {
                let _ = self.tx.send(Out::Subscribe(server_id, g.tx.subscribe())).await;
            }
        }
    }

    // ---------- authenticated ----------

    async fn authed(&mut self, req: u32, uid: Id, name: &str, msg: C2S, t_recv: i64) -> R {
        match msg {
            C2S::Send { channel_id, content, nonce, t_input, t_client_send } => {
                if !self.take_token() {
                    return Err((ErrorCode::RateLimited, "slow down".into()));
                }
                let content = content.trim().to_owned();
                if content.is_empty() || content.chars().count() > MAX_MESSAGE_CHARS {
                    return Err((ErrorCode::BadRequest, "message must be 1-4000 characters".into()));
                }
                let (chan, guild) = self.member_chan(channel_id, uid).await?;
                if chan.kind != ChannelKind::Text {
                    return Err((ErrorCode::BadRequest, "not a text channel".into()));
                }
                // A resend after reconnect: already fanned out. Echo to this
                // socket only and re-queue the (idempotent) insert so the author
                // gets its durable ack on the new connection.
                if nonce != 0 {
                    if let Some(prev) = self.st.nonces.get(&(uid, nonce)).map(|e| e.0.clone()) {
                        self.send(0, S2C::Message(prev.clone())).await;
                        let op = PersistOp::Insert {
                            channel_id: prev.channel_id,
                            id: prev.id,
                            author_id: uid,
                            content: prev.content,
                            t_enqueue: now_us(),
                            ack: AckTo { conn: self.tx.clone(), req, nonce, t_server_recv: t_recv },
                        };
                        self.st.persist.send(op).await.map_err(internal)?;
                        return Ok(());
                    }
                }
                // Hot path: assign ID, fan out, then persist asynchronously.
                let id = {
                    let _order = chan.order.lock();
                    let id = self.st.ids.next();
                    let t_send = now_us();
                    let msg = Message {
                        id,
                        channel_id,
                        author_id: uid,
                        content: content.clone(),
                        edited_at: None,
                        nonce,
                        trace: Some(Trace { t_input, t_client_send, t_server_recv: t_recv, t_server_send: t_send }),
                    };
                    guild.publish(frame(0, S2C::Message(msg.clone())));
                    self.st.metrics.fanout.lock().record_us(t_send - t_recv);
                    if nonce != 0 {
                        self.st.nonces.insert((uid, nonce), (msg, t_send));
                    }
                    id
                };
                self.st.metrics.messages.fetch_add(1, Ordering::Relaxed);
                let op = PersistOp::Insert {
                    channel_id,
                    id,
                    author_id: uid,
                    content,
                    t_enqueue: now_us(),
                    ack: AckTo { conn: self.tx.clone(), req, nonce, t_server_recv: t_recv },
                };
                self.st.persist.send(op).await.map_err(internal)?;
                Ok(())
            }
            C2S::Edit { channel_id, message_id, content } => {
                let content = content.trim().to_owned();
                if content.is_empty() || content.chars().count() > MAX_MESSAGE_CHARS {
                    return Err((ErrorCode::BadRequest, "message must be 1-4000 characters".into()));
                }
                let (_, guild) = self.member_chan(channel_id, uid).await?;
                let edited_at = now_us() / 1000;
                let (reply, rx) = oneshot::channel();
                self.st
                    .persist
                    .send(PersistOp::Edit { channel_id, id: message_id, author_id: uid, content: content.clone(), edited_at, reply })
                    .await
                    .map_err(internal)?;
                if !rx.await.unwrap_or(false) {
                    return Err((ErrorCode::NotFound, "no such message of yours".into()));
                }
                guild.publish(frame(0, S2C::Edited { channel_id, id: message_id, content, edited_at }));
                self.send(req, S2C::Ok).await;
                Ok(())
            }
            C2S::Delete { channel_id, message_id } => {
                let (_, guild) = self.member_chan(channel_id, uid).await?;
                let (reply, rx) = oneshot::channel();
                self.st
                    .persist
                    .send(PersistOp::Delete { channel_id, id: message_id, author_id: uid, reply })
                    .await
                    .map_err(internal)?;
                if !rx.await.unwrap_or(false) {
                    return Err((ErrorCode::NotFound, "no such message of yours".into()));
                }
                guild.publish(frame(0, S2C::Deleted { channel_id, id: message_id }));
                self.send(req, S2C::Ok).await;
                Ok(())
            }
            C2S::History { channel_id, before, limit } => {
                self.member_chan(channel_id, uid).await?;
                let limit = limit.clamp(1, HISTORY_PAGE_MAX) as i64;
                // Off the reader loop so a slow query never delays live sends.
                let (st, tx) = (self.st.clone(), self.tx.clone());
                tokio::spawn(async move {
                    let rows: Result<Vec<(i64, i64, String, Option<i64>)>, _> = sqlx::query_as(
                        "SELECT id, author_id, content, edited_at FROM messages \
                         WHERE channel_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
                    )
                    .bind(channel_id)
                    .bind(before.unwrap_or(i64::MAX))
                    .bind(limit + 1)
                    .fetch_all(&st.db)
                    .await;
                    let msg = match rows {
                        Ok(mut rows) => {
                            let more = rows.len() as i64 > limit;
                            rows.truncate(limit as usize);
                            let messages = rows
                                .into_iter()
                                .map(|(id, author_id, content, edited_at)| Message { id, channel_id, author_id, content, edited_at, nonce: 0, trace: None })
                                .collect();
                            S2C::History { channel_id, messages, more }
                        }
                        Err(e) => S2C::Error { code: ErrorCode::Internal, message: e.to_string() },
                    };
                    let _ = tx.send(Out::Frame(frame(req, msg))).await;
                });
                Ok(())
            }
            C2S::CreateServer { name: sname } => {
                let sname = sname.trim().to_owned();
                if sname.is_empty() || sname.chars().count() > 64 {
                    return Err((ErrorCode::BadRequest, "server name must be 1-64 characters".into()));
                }
                let (sid, text_id, voice_id) = (self.st.ids.next(), self.st.ids.next(), self.st.ids.next());
                let mut tx = self.st.db.begin().await.map_err(internal)?;
                sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
                    .bind(sid).bind(&sname).bind(uid).execute(&mut *tx).await.map_err(internal)?;
                sqlx::query("INSERT INTO members (server_id, user_id) VALUES ($1, $2)")
                    .bind(sid).bind(uid).execute(&mut *tx).await.map_err(internal)?;
                sqlx::query("INSERT INTO channels (id, server_id, name, kind) VALUES ($1, $3, 'general', 0), ($2, $3, 'Voice', 1)")
                    .bind(text_id).bind(voice_id).bind(sid).execute(&mut *tx).await.map_err(internal)?;
                tx.commit().await.map_err(internal)?;
                self.joined_server(req, uid, sid).await
            }
            C2S::CreateChannel { server_id, name: cname, kind } => {
                let cname = cname.trim().to_owned();
                if cname.is_empty() || cname.chars().count() > 64 {
                    return Err((ErrorCode::BadRequest, "channel name must be 1-64 characters".into()));
                }
                let owner: Option<(i64,)> = sqlx::query_as("SELECT owner_id FROM servers WHERE id = $1")
                    .bind(server_id).fetch_optional(&self.st.db).await.map_err(internal)?;
                if owner.map(|o| o.0) != Some(uid) {
                    return Err((ErrorCode::Forbidden, "only the owner can create channels".into()));
                }
                let id = self.st.ids.next();
                sqlx::query("INSERT INTO channels (id, server_id, name, kind) VALUES ($1, $2, $3, $4)")
                    .bind(id).bind(server_id).bind(&cname).bind(kind_to_i16(kind))
                    .execute(&self.st.db).await.map_err(internal)?;
                let info = ChannelInfo { id, server_id, name: cname, kind };
                self.st.chan_insert(&info);
                let g = self.st.guild(server_id).await.map_err(internal)?;
                g.publish(frame(0, S2C::ChannelCreated(info)));
                self.send(req, S2C::Ok).await;
                Ok(())
            }
            C2S::CreateInvite { server_id } => {
                let g = self.st.guild(server_id).await.map_err(internal)?;
                if !g.is_member(uid) {
                    return Err((ErrorCode::Forbidden, "not a member".into()));
                }
                let code = auth::invite_code();
                sqlx::query("INSERT INTO invites (code, server_id, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '7 days')")
                    .bind(&code).bind(server_id).bind(uid).execute(&self.st.db).await.map_err(internal)?;
                self.send(req, S2C::Invite { server_id, code }).await;
                Ok(())
            }
            C2S::JoinInvite { code } => {
                let code = code.trim().rsplit('/').next().unwrap_or("").to_owned();
                let row: Option<(i64,)> = sqlx::query_as("SELECT server_id FROM invites WHERE code = $1 AND expires_at > now()")
                    .bind(&code).fetch_optional(&self.st.db).await.map_err(internal)?;
                let (sid,) = row.ok_or((ErrorCode::NotFound, "invite is invalid or expired".into()))?;
                let inserted = sqlx::query("INSERT INTO members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
                    .bind(sid).bind(uid).execute(&self.st.db).await.map_err(internal)?.rows_affected() == 1;
                let g = self.st.guild(sid).await.map_err(internal)?;
                g.members.write().insert(uid);
                if inserted {
                    g.publish(frame(0, S2C::MemberJoined { server_id: sid, user: UserInfo { id: uid, name: name.to_owned() } }));
                }
                self.joined_server(req, uid, sid).await
            }
            C2S::VoiceGrant { channel_id } => {
                let (chan, _) = self.member_chan(channel_id, uid).await?;
                if chan.kind != ChannelKind::Voice {
                    return Err((ErrorCode::BadRequest, "not a voice channel".into()));
                }
                let token = voice::grant(&self.st.cfg.livekit_key, &self.st.cfg.livekit_secret, uid, name, channel_id);
                self.send(req, S2C::VoiceGrant { channel_id, url: self.st.cfg.livekit_url.clone(), token }).await;
                Ok(())
            }
            C2S::VoiceState { channel_id, muted, deafened } => {
                match channel_id {
                    None => self.leave_voice(uid),
                    Some(cid) => {
                        let (chan, guild) = self.member_chan(cid, uid).await?;
                        if chan.kind != ChannelKind::Voice {
                            return Err((ErrorCode::BadRequest, "not a voice channel".into()));
                        }
                        let prev = self.st.voice.lock().insert(
                            uid,
                            VoiceEntry { server_id: chan.server_id, channel_id: cid, muted, deafened, conn_id: self.conn },
                        );
                        if let Some(p) = prev.filter(|p| p.server_id != chan.server_id) {
                            if let Some(g) = self.st.guilds.get(&p.server_id) {
                                g.publish(frame(0, S2C::VoicePresence { server_id: p.server_id, user_id: uid, channel_id: None, muted: false, deafened: false }));
                            }
                        }
                        guild.publish(frame(0, S2C::VoicePresence { server_id: chan.server_id, user_id: uid, channel_id: Some(cid), muted, deafened }));
                    }
                }
                self.send(req, S2C::Ok).await;
                Ok(())
            }
            C2S::Logout { refresh_token } => {
                sqlx::query("DELETE FROM refresh_tokens WHERE token_hash = $1")
                    .bind(auth::hash_refresh(&refresh_token)).execute(&self.st.db).await.map_err(internal)?;
                self.cleanup();
                let _ = self.tx.send(Out::UnsubscribeAll).await;
                self.guilds.clear();
                self.send(req, S2C::LoggedOut).await;
                Ok(())
            }
            C2S::Ping { .. } | C2S::Signup { .. } | C2S::Login { .. } | C2S::Resume { .. } | C2S::Refresh { .. } => unreachable!(),
        }
    }

    async fn member_chan(&self, channel_id: Id, uid: Id) -> Result<(Arc<crate::state::Chan>, Arc<crate::state::Guild>), (ErrorCode, String)> {
        self.st.chan_for(channel_id, uid).await.ok_or((ErrorCode::NotFound, "no such channel".into()))
    }

    async fn joined_server(&mut self, req: u32, uid: Id, sid: Id) -> R {
        let info = self.st.load_servers(uid, Some(sid)).await.map_err(internal)?.pop().ok_or((ErrorCode::NotFound, "server vanished".into()))?;
        // Every connection of this user subscribes and learns about the server.
        let g = self.st.guild(sid).await.map_err(internal)?;
        self.guilds.insert(sid);
        let _ = self.tx.send(Out::Subscribe(sid, g.tx.subscribe())).await;
        let me = self.conn;
        if let Some(v) = self.st.conns.get(&uid) {
            for (_, tx) in v.iter().filter(|(c, _)| *c != me) {
                let _ = tx.try_send(Out::Subscribe(sid, g.tx.subscribe()));
                let _ = tx.try_send(Out::Frame(frame(0, S2C::ServerJoined(info.clone()))));
            }
        }
        self.send(req, S2C::ServerJoined(info)).await;
        Ok(())
    }
}

type R = Result<(), (ErrorCode, String)>;

fn internal<E: std::fmt::Display>(e: E) -> (ErrorCode, String) {
    tracing::error!("internal: {e}");
    (ErrorCode::Internal, "internal error".into())
}
