//! The client core: owns the single WebSocket, all state, the cache and voice.
//! The webview only renders what it is sent.
//!
//! Connection lifecycle: connect at startup (before the user does anything),
//! sync clocks, authenticate from the stored refresh token, then stream.
//! On any failure: reconnect with jittered backoff, re-authenticate with the
//! in-memory access token if still valid, resend un-echoed messages, and
//! resync the open channel.

use crate::cache::Cache;
use crate::perf::{Perf, H};
use crate::ui::*;
use futures_util::{FutureExt, SinkExt, StreamExt};
use hopon_shared::time::{now_us, ClockSync};
use hopon_shared::*;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::tungstenite::Message as WsMsg;

const RECENT_PER_CHANNEL: usize = 300;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub struct PendingSend {
    pub channel_id: Id,
    pub content: String,
    pub reply_to: Option<Id>,
    pub files: Vec<String>,
    pub gifs: Vec<String>,
    pub t_input: i64,
    pub echoed: bool,
}

#[derive(Default)]
pub struct Store {
    pub me: Option<UserInfo>,
    pub servers: Vec<ServerInfo>,
    pub recent: HashMap<Id, VecDeque<Message>>,
    /// user → (server, presence)
    pub voice: HashMap<Id, (Id, VoicePresence)>,
    pub pending: HashMap<u64, PendingSend>,
    pub access_token: Option<(String, i64)>,
    /// Latest account preferences JSON (sent to the UI before any snapshot).
    pub prefs: Option<String>,
    pub refresh_token: Option<String>,
    pub open_channel: Option<Id>,
}

impl Store {
    fn insert_recent(&mut self, m: Message) {
        let q = self.recent.entry(m.channel_id).or_default();
        match q.binary_search_by_key(&m.id, |x| x.id) {
            Ok(i) => q[i] = m,
            Err(i) => {
                // Older than our window and the window is full: not "recent".
                if i == 0 && q.len() >= RECENT_PER_CHANNEL {
                    return;
                }
                q.insert(i, m);
                while q.len() > RECENT_PER_CHANNEL {
                    q.pop_front();
                }
            }
        }
    }
    fn session_event(&self) -> UiEvent {
        UiEvent::Session {
            user: self.me.as_ref().map(Into::into),
            servers: self.servers.iter().map(Into::into).collect(),
            voice: self.voice.values().map(|(_, p)| p.into()).collect(),
        }
    }
}

pub struct Core {
    pub perf: Perf,
    pub cache: Cache,
    pub store: Mutex<Store>,
    pub clock: Mutex<ClockSync>,
    pub url: Mutex<String>,
    /// Subscribed windows (label → channel), plus events buffered while the
    /// main window isn't attached yet.
    ui: Mutex<(Vec<(String, Channel<UiEvent>)>, Vec<UiEvent>)>,
    /// HTTP client for uploads (separate connections: never blocks chat).
    http: reqwest::Client,
    out: Mutex<Option<mpsc::UnboundedSender<WsMsg>>>,
    waiters: Mutex<HashMap<u32, oneshot::Sender<S2C>>>,
    req: AtomicU32,
    reconnect: Notify,
    pub voice: crate::voice::Voice,
    pub games: crate::games::Games,
    /// Set once in `setup`.
    pub app: std::sync::OnceLock<tauri::AppHandle>,
}

pub type Res<T> = Result<T, String>;

impl Core {
    pub fn new(cache: Cache, url: String) -> Arc<Self> {
        Arc::new(Self {
            perf: Perf::new(),
            cache,
            store: Mutex::new(Store::default()),
            clock: Mutex::new(ClockSync::default()),
            url: Mutex::new(url),
            ui: Mutex::new((Vec::new(), Vec::new())),
            http: reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().unwrap_or_default(),
            out: Mutex::new(None),
            waiters: Mutex::new(HashMap::new()),
            req: AtomicU32::new(1),
            reconnect: Notify::new(),
            voice: crate::voice::Voice::new(),
            games: crate::games::Games::new(),
            app: std::sync::OnceLock::new(),
        })
    }

    // ---------- UI plumbing ----------

    pub fn emit(&self, ev: UiEvent) {
        let mut ui = self.ui.lock();
        let mut main_ok = false;
        ui.0.retain(|(label, ch)| {
            let ok = ch.send(ev.clone()).is_ok();
            main_ok |= ok && label == "main";
            ok
        });
        if !main_ok && ui.1.len() < 512 {
            ui.1.push(ev);
        }
    }

    /// A window subscribes (again, after a reload). The main window also gets
    /// whatever was buffered while it wasn't listening.
    pub fn attach_ui(&self, label: &str, ch: Channel<UiEvent>) {
        let mut ui = self.ui.lock();
        let (prefs, snap) = {
            let s = self.store.lock();
            (s.prefs.clone(), s.session_event())
        };
        // Prefs first: the UI uses them to choose the server to open.
        if let Some(json) = prefs.filter(|_| snap_has_user(&snap)) {
            let _ = ch.send(UiEvent::Prefs { json });
        }
        let _ = ch.send(snap);
        if label == "main" {
            for ev in ui.1.drain(..) {
                let _ = ch.send(ev);
            }
        }
        ui.0.retain(|(l, _)| l != label);
        ui.0.push((label.to_owned(), ch));
    }

    pub fn detach_ui(&self, label: &str) {
        self.ui.lock().0.retain(|(l, _)| l != label);
    }

    pub fn session_snapshot(&self) -> UiEvent {
        self.store.lock().session_event()
    }

    // ---------- requests ----------

    fn next_req(&self) -> u32 {
        // Wraps far beyond any realistic session; 0 is reserved for events.
        let r = self.req.fetch_add(1, Ordering::Relaxed);
        if r == 0 { self.req.fetch_add(1, Ordering::Relaxed) } else { r }
    }

    pub fn send_frame(&self, req: u32, msg: C2S) -> bool {
        let bytes = encode(&ClientFrame { req, msg });
        match &*self.out.lock() {
            Some(tx) => tx.send(WsMsg::Binary(bytes.into())).is_ok(),
            None => false,
        }
    }

    /// Request/response with timeout. Server errors become `Err(message)`.
    pub async fn request(&self, msg: C2S) -> Res<S2C> {
        let req = self.next_req();
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().insert(req, tx);
        if !self.send_frame(req, msg) {
            self.waiters.lock().remove(&req);
            return Err("offline".into());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(S2C::Error { message, .. })) => Err(message),
            Ok(Ok(m)) => Ok(m),
            Ok(Err(_)) => Err("connection lost".into()),
            Err(_) => {
                self.waiters.lock().remove(&req);
                Err("timed out".into())
            }
        }
    }

    pub fn force_reconnect(&self) {
        self.reconnect.notify_one();
    }

    // ---------- connection loop ----------

    pub async fn run(self: Arc<Self>) {
        let mut backoff = 100u64;
        let mut first = true;
        let mut incompatible = false;
        loop {
            if !incompatible {
                self.emit(UiEvent::Conn { state: "connecting", rtt_ms: None });
            }
            let url = self.url.lock().clone();
            incompatible = false;
            match tokio::time::timeout(Duration::from_secs(5), connect(&url)).await {
                Ok(Ok(ws)) => {
                    backoff = 100;
                    self.clone().session(ws, &mut first).await;
                }
                Ok(Err(e)) => {
                    incompatible = matches!(e.downcast_ref::<tokio_tungstenite::tungstenite::Error>(),
                        Some(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status().as_u16() == 426);
                    if incompatible {
                        self.emit(UiEvent::Conn { state: "incompatible", rtt_ms: None });
                        backoff = 5_000;
                    }
                    tracing::info!("connect {url}: {e}");
                }
                Err(_) => tracing::info!("connect {url}: timeout"),
            }
            *self.out.lock() = None;
            for (_, w) in self.waiters.lock().drain() {
                drop(w);
            }
            if !incompatible {
                self.emit(UiEvent::Conn { state: "offline", rtt_ms: None });
            }
            let jitter = (now_us() as u64) % (backoff / 2 + 1);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(backoff + jitter)) => {}
                _ = self.reconnect.notified() => {}
            }
            backoff = (backoff * 2).min(5_000);
        }
    }

    async fn session(self: Arc<Self>, ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>, first: &mut bool) {
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<WsMsg>();
        *self.out.lock() = Some(tx);

        // Writer: feed everything ready, flush once.
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.feed(m).await.is_err() {
                    return;
                }
                while let Some(Some(m)) = rx.recv().now_or_never() {
                    if sink.feed(m).await.is_err() {
                        return;
                    }
                }
                if sink.flush().await.is_err() {
                    return;
                }
            }
        });

        // Reader runs concurrently with the handshake below.
        let me = self.clone();
        let reader = tokio::spawn(async move {
            loop {
                let next = tokio::time::timeout(Duration::from_secs(25), stream.next()).await;
                match next {
                    Ok(Some(Ok(WsMsg::Binary(b)))) => {
                        let t = now_us();
                        match decode::<ServerFrame>(&b) {
                            Ok(f) => me.on_frame(f, t),
                            Err(e) => tracing::warn!("bad frame: {e}"),
                        }
                    }
                    Ok(Some(Ok(WsMsg::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => return,
                    Ok(Some(Ok(_))) => {}
                }
            }
        });

        // Clock sync: a burst of pings, keep the tightest.
        let mut best = None;
        for _ in 0..5 {
            if let Some(rtt) = self.ping().await {
                best = Some(best.map_or(rtt, |b: i64| b.min(rtt)));
            }
        }
        self.emit(UiEvent::Conn { state: "online", rtt_ms: best.map(|r| r as f64 / 1000.0) });
        if std::mem::take(first) {
            let t = now_us() - self.perf.t_main;
            self.perf.t_connected.store(now_us(), Ordering::Relaxed);
            tracing::info!("connected {:.1} ms after start", t as f64 / 1000.0);
        }
        self.clone().authenticate().await;

        let keepalive = {
            let me = self.clone();
            tokio::spawn(async move {
                let mut iv = tokio::time::interval(Duration::from_secs(10));
                iv.tick().await;
                loop {
                    iv.tick().await;
                    let rtt = me.ping().await;
                    me.emit(UiEvent::Conn { state: "online", rtt_ms: rtt.map(|r| r as f64 / 1000.0) });
                }
            })
        };

        tokio::select! {
            _ = reader => {}
            _ = self.reconnect.notified() => {}
        }
        keepalive.abort();
        writer.abort();
    }

    async fn ping(&self) -> Option<i64> {
        let t0 = now_us();
        match self.request(C2S::Ping { t_client: t0 }).await {
            Ok(S2C::Pong { t_server, .. }) => {
                let t1 = now_us();
                let rtt = self.clock.lock().sample(t0, t_server, t1);
                self.perf.rec(H::WsRtt, rtt);
                Some(rtt)
            }
            _ => None,
        }
    }

    async fn authenticate(self: Arc<Self>) {
        let (access, refresh) = {
            let s = self.store.lock();
            (s.access_token.clone(), s.refresh_token.clone())
        };
        let refresh = match refresh {
            Some(r) => Some(r),
            None => self.cache.kv_get("refresh").await.and_then(|b| crate::secure::unprotect(&b)).and_then(|b| String::from_utf8(b).ok()),
        };
        let now_s = now_us() / 1_000_000;
        if let Some((tok, exp)) = access.filter(|(_, exp)| *exp > now_s + 30) {
            let _ = exp;
            if self.request(C2S::Resume { access_token: tok }).await.is_ok() {
                return self.after_auth().await;
            }
        }
        if let Some(r) = refresh {
            match self.request(C2S::Refresh { refresh_token: r }).await {
                Ok(_) => return self.after_auth().await,
                Err(e) if e == "offline" || e == "timed out" || e == "connection lost" => return,
                Err(_) => {
                    self.cache.kv_set("refresh", None);
                    self.store.lock().refresh_token = None;
                }
            }
        }
        // Benchmark automation only: log in without the UI.
        if let Some((u, p)) = std::env::var("HOPON_PERF_LOGIN").ok().as_deref().and_then(|v| v.split_once(':')) {
            if self.request(C2S::Login { username: u.into(), password: p.into() }).await.is_ok() {
                return self.after_auth().await;
            }
        }
        let ev = self.session_snapshot();
        self.emit(ev);
    }

    /// After (re)authentication: resend un-echoed sends, resync the open channel.
    async fn after_auth(self: Arc<Self>) {
        let resend: Vec<(u64, Id, String, i64, Option<Id>, Vec<String>, Vec<String>)> = {
            let s = self.store.lock();
            s.pending
                .iter()
                .filter(|(_, p)| !p.echoed)
                .map(|(n, p)| (*n, p.channel_id, p.content.clone(), p.t_input, p.reply_to, p.files.clone(), p.gifs.clone()))
                .collect()
        };
        let off = self.clock.lock().offset_us;
        for (nonce, channel_id, content, t_input, reply_to, files, gifs) in resend {
            self.send_frame(self.next_req(), C2S::Send { channel_id, content, nonce, t_input: t_input + off, t_client_send: now_us() + off, reply_to, files, gifs });
        }
        let open = self.store.lock().open_channel;
        if let Some(ch) = open {
            self.clone().refresh_latest(ch);
        }
        self.voice.on_reconnect(self.clone());
    }

    /// Fetch the latest page from the server and merge into the UI.
    pub fn refresh_latest(self: Arc<Self>, ch: Id) {
        tauri::async_runtime::spawn(async move {
            if let Ok(S2C::History { messages, .. }) = self.request(C2S::History { channel_id: ch, before: None, limit: 50 }).await {
                let ui: Vec<UiMsg> = messages.iter().rev().map(|m| UiMsg::from_msg(m, 2)).collect();
                {
                    let mut s = self.store.lock();
                    for m in &messages {
                        s.insert_recent(m.clone());
                    }
                }
                self.cache.put(messages);
                self.emit(UiEvent::Messages { channel_id: sid(ch), msgs: ui });
            }
        });
    }

    // ---------- inbound ----------

    fn on_frame(self: &Arc<Self>, f: ServerFrame, t_recv: i64) {
        self.apply(&f.msg, t_recv);
        if f.req != 0 {
            if let Some(w) = self.waiters.lock().remove(&f.req) {
                let _ = w.send(f.msg);
            }
        }
    }

    fn apply(self: &Arc<Self>, msg: &S2C, t_recv: i64) {
        match msg {
            S2C::Authed { user, access_token, refresh_token, servers, voice, prefs } => {
                // Before the session snapshot, so the UI can pick your last server.
                self.store.lock().prefs = Some(prefs.clone());
                self.emit(UiEvent::Prefs { json: prefs.clone() });
                {
                    let mut s = self.store.lock();
                    if s.me.as_ref().map(|u| u.id) != Some(user.id) {
                        s.recent.clear();
                        s.pending.clear();
                        s.open_channel = None;
                    }
                    s.me = Some(user.clone());
                    s.servers = servers.clone();
                    s.voice = voice
                        .iter()
                        .filter_map(|v| servers.iter().find(|sv| sv.channels.iter().any(|c| c.id == v.channel_id)).map(|sv| (v.user_id, (sv.id, v.clone()))))
                        .collect();
                    s.access_token = Some((access_token.clone(), now_us() / 1_000_000 + 14 * 60));
                    if !refresh_token.is_empty() {
                        s.refresh_token = Some(refresh_token.clone());
                    }
                }
                if !refresh_token.is_empty() {
                    if let Some(b) = crate::secure::protect(refresh_token.as_bytes()) {
                        self.cache.kv_set("refresh", Some(b));
                    }
                }
                let ev = self.session_snapshot();
                self.emit(ev);
            }
            S2C::Message(m) => {
                let t_emit = now_us();
                let (own, t_input_local) = {
                    let mut s = self.store.lock();
                    let own = s.me.as_ref().map(|u| u.id) == Some(m.author_id);
                    let mut t_in = None;
                    if own {
                        if let Some(p) = s.pending.get_mut(&m.nonce) {
                            p.echoed = true;
                            t_in = Some(p.t_input);
                        }
                    }
                    s.insert_recent(m.clone());
                    if let Some(c) = s.servers.iter_mut().flat_map(|sv| sv.channels.iter_mut()).find(|c| c.id == m.channel_id) {
                        c.last_id = c.last_id.max(m.id);
                    }
                    (own, t_in)
                };
                let clock = *self.clock.lock();
                if let Some(t) = t_input_local {
                    self.perf.rec(H::OwnEcho, t_recv - t);
                }
                if let Some(tr) = m.trace {
                    self.perf.expect_server(sid(m.id), clock.to_local(tr.t_input), clock.to_local(tr.t_server_send), t_emit, own);
                }
                self.cache.put(vec![Message { trace: None, ..m.clone() }]);
                self.emit(UiEvent::Messages { channel_id: sid(m.channel_id), msgs: vec![UiMsg::from_msg(m, 1)] });
                if !own {
                    if let Some(me) = self.store.lock().me.as_ref().map(|u| u.id) {
                        if hopon_shared::mentions(&m.content).contains(&me) {
                            self.emit(UiEvent::Mentioned { channel_id: sid(m.channel_id) });
                            self.attention();
                        }
                    }
                }
            }
            S2C::Ack { channel_id, nonce, id, .. } => {
                if let Some(p) = self.store.lock().pending.remove(nonce) {
                    self.perf.rec(H::OwnAck, t_recv - p.t_input);
                }
                self.emit(UiEvent::MsgState { channel_id: sid(*channel_id), nonce: nonce.to_string(), id: sid(*id), state: 2 });
            }
            S2C::Edited { channel_id, id, content, edited_at } => {
                {
                    let mut s = self.store.lock();
                    if let Some(q) = s.recent.get_mut(channel_id) {
                        if let Ok(i) = q.binary_search_by_key(id, |x| x.id) {
                            q[i].content = content.clone();
                            q[i].edited_at = Some(*edited_at);
                        }
                    }
                }
                self.cache.edit(*channel_id, *id, content.clone(), *edited_at);
                self.emit(UiEvent::Edited { channel_id: sid(*channel_id), id: sid(*id), content: content.clone(), edited_at: *edited_at });
            }
            S2C::Deleted { channel_id, id } => {
                {
                    let mut s = self.store.lock();
                    if let Some(q) = s.recent.get_mut(channel_id) {
                        if let Ok(i) = q.binary_search_by_key(id, |x| x.id) {
                            q.remove(i);
                        }
                    }
                }
                self.cache.delete(*channel_id, *id);
                self.emit(UiEvent::Deleted { channel_id: sid(*channel_id), id: sid(*id) });
            }
            S2C::ServerJoined(sv) => {
                {
                    let mut s = self.store.lock();
                    s.servers.retain(|x| x.id != sv.id);
                    s.servers.push(sv.clone());
                }
                self.emit(UiEvent::Server { server: sv.into() });
            }
            S2C::ChannelCreated(c) => {
                {
                    let mut s = self.store.lock();
                    if let Some(sv) = s.servers.iter_mut().find(|x| x.id == c.server_id) {
                        if !sv.channels.iter().any(|x| x.id == c.id) {
                            sv.channels.push(c.clone());
                        }
                    }
                }
                self.emit(UiEvent::ChannelCreated { channel: c.into() });
            }
            S2C::MemberJoined { server_id, user } => {
                {
                    let mut s = self.store.lock();
                    if let Some(sv) = s.servers.iter_mut().find(|x| x.id == *server_id) {
                        if !sv.members.iter().any(|x| x.id == user.id) {
                            sv.members.push(user.clone());
                        }
                        if !sv.online.contains(&user.id) {
                            sv.online.push(user.id);
                        }
                    }
                }
                self.emit(UiEvent::MemberJoined { server_id: sid(*server_id), user: user.into() });
            }
            S2C::ServerUpdated { server_id, name } => {
                if let Some(sv) = self.store.lock().servers.iter_mut().find(|x| x.id == *server_id) {
                    sv.name = name.clone();
                }
                self.emit_server(*server_id);
            }
            S2C::ChannelUpdated(c) => {
                if let Some(sv) = self.store.lock().servers.iter_mut().find(|x| x.id == c.server_id) {
                    if let Some(x) = sv.channels.iter_mut().find(|x| x.id == c.id) {
                        let last = x.last_id.max(c.last_id);
                        *x = c.clone();
                        x.last_id = last;
                    }
                }
                self.emit_server(c.server_id);
            }
            S2C::ChannelDeleted { server_id, channel_id } => {
                {
                    let mut s = self.store.lock();
                    if let Some(sv) = s.servers.iter_mut().find(|x| x.id == *server_id) {
                        sv.channels.retain(|x| x.id != *channel_id);
                    }
                    s.recent.remove(channel_id);
                    s.pending.retain(|_, p| p.channel_id != *channel_id);
                }
                self.cache.purge_channels(vec![*channel_id]);
                self.voice.leave_if_in(self.clone(), &[*channel_id]);
                self.emit_server(*server_id);
                self.emit(UiEvent::ChannelDeleted { server_id: sid(*server_id), channel_id: sid(*channel_id) });
            }
            S2C::MemberLeft { server_id, user_id, .. } => {
                {
                    let mut s = self.store.lock();
                    if let Some(sv) = s.servers.iter_mut().find(|x| x.id == *server_id) {
                        sv.members.retain(|m| m.id != *user_id);
                    }
                    if s.voice.get(user_id).map_or(false, |(srv, _)| srv == server_id) {
                        s.voice.remove(user_id);
                    }
                }
                self.emit_server(*server_id);
            }
            S2C::ServerRemoved { server_id, reason } => {
                let channels: Vec<Id> = {
                    let mut s = self.store.lock();
                    let chans = s.servers.iter().find(|x| x.id == *server_id).map(|sv| sv.channels.iter().map(|c| c.id).collect()).unwrap_or_default();
                    s.servers.retain(|x| x.id != *server_id);
                    for c in &chans {
                        s.recent.remove(c);
                    }
                    s.voice.retain(|_, (srv, _)| srv != server_id);
                    chans
                };
                self.voice.leave_if_in(self.clone(), &channels);
                self.cache.purge_channels(channels);
                let reason = match reason {
                    RemovedReason::Deleted => "deleted",
                    RemovedReason::Kicked => "kicked",
                    RemovedReason::Left => "left",
                };
                self.emit(UiEvent::ServerRemoved { server_id: sid(*server_id), reason });
            }
            S2C::Reaction { channel_id, message_id, emoji, user_id, add } => {
                let updated = {
                    let mut s = self.store.lock();
                    s.recent.get_mut(channel_id).and_then(|q| {
                        let i = q.binary_search_by_key(message_id, |x| x.id).ok()?;
                        let m = &mut q[i];
                        apply_reaction(&mut m.reactions, emoji, *user_id, *add);
                        Some(m.clone())
                    })
                };
                if let Some(m) = updated {
                    self.cache.put(vec![m]);
                }
                self.emit(UiEvent::Reaction { channel_id: sid(*channel_id), message_id: sid(*message_id), emoji: emoji.clone(), user_id: sid(*user_id), add: *add });
            }
            S2C::PrefsUpdated { json } => {
                self.store.lock().prefs = Some(json.clone());
                self.emit(UiEvent::Prefs { json: json.clone() });
            }
            S2C::Typing { channel_id, user_id } => {
                if self.store.lock().me.as_ref().map(|u| u.id) != Some(*user_id) {
                    self.emit(UiEvent::Typing { channel_id: sid(*channel_id), user_id: sid(*user_id) });
                }
            }
            S2C::ReadUpdated { channel_id, last_read } => {
                {
                    let mut s = self.store.lock();
                    if let Some(sv) = s.servers.iter_mut().find(|sv| sv.channels.iter().any(|c| c.id == *channel_id)) {
                        match sv.reads.iter_mut().find(|(c, _)| c == channel_id) {
                            Some(r) => r.1 = r.1.max(*last_read),
                            None => sv.reads.push((*channel_id, *last_read)),
                        }
                    }
                }
                self.emit(UiEvent::ReadUpdated { channel_id: sid(*channel_id), last_read: sid(*last_read) });
            }
            S2C::UserPresence { user_id, online } => {
                {
                    let mut s = self.store.lock();
                    for sv in s.servers.iter_mut().filter(|sv| sv.members.iter().any(|m| m.id == *user_id)) {
                        sv.online.retain(|u| u != user_id);
                        if *online {
                            sv.online.push(*user_id);
                        }
                    }
                }
                self.emit(UiEvent::UserPresence { user_id: sid(*user_id), online: *online });
            }
            S2C::UserUpdated(u) => {
                {
                    let mut s = self.store.lock();
                    for sv in s.servers.iter_mut() {
                        for m in sv.members.iter_mut().filter(|m| m.id == u.id) {
                            *m = u.clone();
                        }
                    }
                    if let Some(me) = s.me.as_mut().filter(|me| me.id == u.id) {
                        *me = u.clone();
                    }
                }
                self.emit(UiEvent::UserUpdated { user: u.into() });
            }
            S2C::VoicePresence { server_id, user_id, channel_id, muted, deafened } => {
                {
                    let mut s = self.store.lock();
                    match channel_id {
                        Some(c) => {
                            s.voice.insert(*user_id, (*server_id, VoicePresence { channel_id: *c, user_id: *user_id, muted: *muted, deafened: *deafened }));
                        }
                        None => {
                            s.voice.remove(user_id);
                        }
                    }
                }
                self.emit(UiEvent::Presence {
                    server_id: sid(*server_id),
                    presence: UiPresence { user_id: sid(*user_id), channel_id: channel_id.map(sid), muted: *muted, deafened: *deafened },
                });
            }
            S2C::LoggedOut => {
                *self.store.lock() = Store::default();
                self.cache.kv_set("refresh", None);
                let ev = self.session_snapshot();
                self.emit(ev);
            }
            S2C::Error { message, .. } => {
                tracing::debug!("server error: {message}");
            }
            S2C::Pong { .. } | S2C::AccessToken { .. } | S2C::Gifs { .. } | S2C::History { .. } | S2C::Invite { .. } | S2C::VoiceGrant { .. } | S2C::Avatar { .. } | S2C::Ok => {}
        }
    }

    /// Flash the taskbar if the window isn't focused (no plugin needed).
    pub fn attention(&self) {
        use tauri::Manager;
        if let Some(app) = self.app.get() {
            if let Some(w) = app.get_webview_window("main") {
                if !w.is_focused().unwrap_or(true) {
                    let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
                }
            }
        }
    }

    /// Mark `channel` read up to `message_id` (skipped if not newer).
    pub fn mark_read(self: &Arc<Self>, channel: Id, message_id: Id) {
        let newer = {
            let s = self.store.lock();
            let cur = s.servers.iter().flat_map(|sv| sv.reads.iter()).find(|(c, _)| *c == channel).map_or(0, |r| r.1);
            message_id > cur
        };
        if newer {
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = me.request(C2S::MarkRead { channel_id: channel, message_id }).await;
            });
        }
    }

    /// Push the full current state of one server to the UI.
    fn emit_server(&self, server_id: Id) {
        let ev = self.store.lock().servers.iter().find(|x| x.id == server_id).map(|sv| UiEvent::Server { server: sv.into() });
        if let Some(ev) = ev {
            self.emit(ev);
        }
    }

    // ---------- outbound helpers used by commands ----------

    #[allow(clippy::too_many_arguments)]
    pub fn send_message(&self, channel_id: Id, content: String, nonce: u64, t_input: i64, reply_to: Option<Id>, files: Vec<String>, gifs: Vec<String>) -> Res<()> {
        let content = content.trim().to_owned();
        let n_att = files.len() + gifs.len();
        if (content.is_empty() && n_att == 0) || content.chars().count() > MAX_MESSAGE_CHARS {
            return Err("message must be 1-4000 characters".into());
        }
        if n_att > MAX_ATTACHMENTS {
            return Err(format!("at most {MAX_ATTACHMENTS} attachments per message"));
        }
        let off = self.clock.lock().offset_us;
        self.perf.expect_local(format!("p{nonce}"), t_input, now_us());
        self.store.lock().pending.insert(nonce, PendingSend { channel_id, content: content.clone(), reply_to, files: files.clone(), gifs: gifs.clone(), t_input, echoed: false });
        // Offline: stays pending and is sent after reconnect.
        self.send_frame(self.next_req(), C2S::Send { channel_id, content, nonce, t_input: t_input + off, t_client_send: now_us() + off, reply_to, files, gifs });
        Ok(())
    }

    /// HTTP base of the chat server (`wss://h/ws` → `https://h`).
    pub fn http_base(&self) -> String {
        http_base(&self.url.lock())
    }

    /// A still-valid access token for HTTP calls (fetched fresh when close to expiry).
    async fn access_token(&self) -> Res<String> {
        let now_s = now_us() / 1_000_000;
        if let Some((t, exp)) = self.store.lock().access_token.clone() {
            if exp > now_s + 60 {
                return Ok(t);
            }
        }
        match self.request(C2S::AccessToken).await? {
            S2C::AccessToken { token } => {
                self.store.lock().access_token = Some((token.clone(), now_s + 14 * 60));
                Ok(token)
            }
            _ => Err("unexpected reply".into()),
        }
    }

    /// Upload one file; returns its attachment (send it with `send_message`).
    pub async fn upload(&self, name: &str, data: Vec<u8>, w: u32, h: u32) -> Res<Attachment> {
        if data.is_empty() {
            return Err("that file is empty".into());
        }
        let token = self.access_token().await?;
        let url = format!("{}/files", self.http_base());
        let res = self
            .http
            .post(url)
            .query(&[("name", name.to_owned()), ("w", w.to_string()), ("h", h.to_string())])
            .bearer_auth(token)
            .timeout(Duration::from_secs(300))
            .body(data)
            .send()
            .await
            .map_err(|e| if e.is_timeout() { "upload timed out".to_string() } else { "couldn't reach the server".to_string() })?;
        let status = res.status();
        if !status.is_success() {
            let msg = res.text().await.unwrap_or_default();
            return Err(if msg.is_empty() || msg.len() > 200 { format!("upload failed ({status})") } else { msg });
        }
        res.json::<Attachment>().await.map_err(|_| "upload failed (bad reply)".to_string())
    }

    pub async fn gif_search(&self, query: String) -> Res<(bool, Vec<Gif>)> {
        match self.request(C2S::GifSearch { query }).await? {
            S2C::Gifs { enabled, results } => Ok((enabled, results)),
            _ => Err("unexpected reply".into()),
        }
    }

    /// Messages to show immediately when a channel is opened.
    pub async fn open_channel(self: &Arc<Self>, ch: Id) -> Vec<UiMsg> {
        let mut msgs: Vec<Message> = {
            let mut s = self.store.lock();
            s.open_channel = Some(ch);
            s.recent.get(&ch).map(|q| q.iter().rev().take(80).rev().cloned().collect()).unwrap_or_default()
        };
        if msgs.len() < 40 {
            let before = msgs.first().map(|m| m.id).unwrap_or(i64::MAX);
            let mut older = self.cache.page(ch, before, 60).await;
            older.reverse();
            older.extend(msgs);
            msgs = older;
        }
        self.clone().refresh_latest(ch);
        msgs.iter().map(|m| UiMsg::from_msg(m, 2)).collect()
    }

    /// Avatar as a data URL, cached in SQLite by (user, version).
    pub async fn avatar(&self, user: Id, v: u32) -> Option<String> {
        if v == 0 {
            return None;
        }
        let key = format!("av:{user}:{v}");
        let bytes = match self.cache.kv_get(&key).await {
            Some(b) => b,
            None => match self.request(C2S::GetAvatar { user_id: user }).await {
                Ok(S2C::Avatar { data, avatar_v, .. }) if !data.is_empty() => {
                    self.cache.kv_set(&format!("av:{user}:{avatar_v}"), Some(data.clone()));
                    data
                }
                _ => return None,
            },
        };
        let mime = hopon_shared::image_mime(&bytes)?;
        use base64::Engine;
        Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
    }

    /// Older page: server when online (authoritative), local cache when offline.
    pub async fn load_older(&self, ch: Id, before: Id) -> (Vec<UiMsg>, bool) {
        match self.request(C2S::History { channel_id: ch, before: Some(before), limit: 50 }).await {
            Ok(S2C::History { messages, more, .. }) => {
                let ui = messages.iter().rev().map(|m| UiMsg::from_msg(m, 2)).collect();
                self.cache.put(messages);
                (ui, more)
            }
            _ => {
                let msgs = self.cache.page(ch, before, 50).await;
                let more = msgs.len() == 50;
                (msgs.iter().rev().map(|m| UiMsg::from_msg(m, 2)).collect(), more)
            }
        }
    }
}

fn snap_has_user(ev: &UiEvent) -> bool {
    matches!(ev, UiEvent::Session { user: Some(_), .. })
}

/// Apply one reaction change to an aggregated list (idempotent).
pub fn apply_reaction(list: &mut Vec<Reaction>, emoji: &str, user: Id, add: bool) {
    match list.iter_mut().position(|r| r.emoji == emoji) {
        Some(i) => {
            let users = &mut list[i].users;
            if add {
                if !users.contains(&user) {
                    users.push(user);
                }
            } else {
                users.retain(|u| *u != user);
                if users.is_empty() {
                    list.remove(i);
                }
            }
        }
        None if add => list.push(Reaction { emoji: emoji.to_owned(), users: vec![user] }),
        None => {}
    }
}

pub fn http_base(ws_url: &str) -> String {
    let (scheme, rest) = ws_url.split_once("://").unwrap_or(("ws", ws_url));
    let host = rest.split('/').next().unwrap_or("");
    format!("{}://{host}", if scheme == "wss" { "https" } else { "http" })
}

async fn connect(url: &str) -> anyhow::Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>> {
    let (scheme, rest) = url.split_once("://").ok_or_else(|| anyhow::anyhow!("bad url"))?;
    let hostport = rest.split('/').next().unwrap_or("");
    let default = if scheme == "wss" { 443 } else { 80 };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.trim_matches(['[', ']']).to_string(), p.parse()?),
        None => (hostport.to_string(), default),
    };
    let tcp = TcpStream::connect((host.as_str(), port)).await?;
    tcp.set_nodelay(true)?;
    let mut cfg = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    cfg.max_message_size = Some(MAX_FRAME_BYTES);
    cfg.write_buffer_size = 0;
    let (ws, _) = tokio_tungstenite::client_async_tls_with_config(versioned_url(url), tcp, Some(cfg), None).await?;
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::apply_reaction;

    #[test]
    fn reactions_are_idempotent_and_clean_up() {
        let mut l = vec![];
        apply_reaction(&mut l, "👍", 1, true);
        apply_reaction(&mut l, "👍", 1, true);
        apply_reaction(&mut l, "👍", 2, true);
        apply_reaction(&mut l, "🔥", 1, true);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].users, vec![1, 2]);
        apply_reaction(&mut l, "🔥", 1, false);
        apply_reaction(&mut l, "🔥", 1, false);
        apply_reaction(&mut l, "🙃", 1, false);
        assert_eq!(l.len(), 1);
    }
}
