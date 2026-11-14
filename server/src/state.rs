//! In-memory routing state. One `broadcast` per server (guild): a member's
//! connection holds one receiver per server instead of one per channel, so a
//! user in 10 servers with 30 channels costs 10 receivers, not 30. Events are
//! encoded once and shared as `Bytes` across all receivers.

use crate::{auth::Keys, config::Config, metrics::Metrics, persist::PersistOp};
use anyhow::Result;
use bytes::Bytes;
use dashmap::DashMap;
use hopon_shared::{encode, ids::IdGen, ChannelInfo, ChannelKind, Friend, FriendState, Id, MediaPresence, MediaSource, ServerFrame, ServerInfo, StatusMode, UserInfo, UserStatus, S2C};
use parking_lot::{Mutex, RwLock};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};
use tokio::sync::Semaphore;

pub const GUILD_BACKLOG: usize = 2048;
pub const CONN_QUEUE: usize = 1024;

pub enum Out {
    Frame(Bytes),
    Subscribe(Id, broadcast::Receiver<Bytes>),
    Unsubscribe(Id),
    UnsubscribeAll,
    Close,
}
pub type ConnTx = mpsc::Sender<Out>;

pub struct Guild {
    pub tx: broadcast::Sender<Bytes>,
    pub members: RwLock<HashSet<Id>>,
    /// A direct message between these two people (a hidden server).
    pub dm: Option<(Id, Id)>,
    /// DM only: the two are still friends, so new messages are allowed.
    pub dm_open: AtomicBool,
}

/// The two ids of a pair, smaller first (friendships and DMs are stored that way).
pub fn pair(a: Id, b: Id) -> (Id, Id) {
    (a.min(b), a.max(b))
}
pub fn dm_key(a: Id, b: Id) -> String {
    let (x, y) = pair(a, b);
    format!("{x}:{y}")
}
fn parse_dm(k: &str) -> Option<(Id, Id)> {
    let (a, b) = k.split_once(':')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

impl Guild {
    /// Admin actions, invites and new channels don't apply to DMs.
    pub fn is_dm(&self) -> bool {
        self.dm.is_some()
    }
    pub fn is_member(&self, u: Id) -> bool {
        self.members.read().contains(&u)
    }
    pub fn publish(&self, b: Bytes) {
        // Err only means no receivers are online.
        let _ = self.tx.send(b);
    }
}

pub struct Chan {
    pub server_id: Id,
    pub kind: ChannelKind,
    /// Set (under `order`) when the channel is deleted; sends check it under
    /// the same lock so nothing is published into a deleted channel.
    pub deleted: std::sync::atomic::AtomicBool,
    /// Newest message id fanned out in this process (0 = none yet).
    pub last_id: std::sync::atomic::AtomicI64,
    /// Held while assigning an ID and publishing, so fan-out order equals ID
    /// order within a channel. Never held across an await.
    pub order: Mutex<()>,
}

#[derive(Clone, Copy)]
pub struct VoiceEntry {
    pub server_id: Id,
    pub channel_id: Id,
    pub muted: bool,
    pub deafened: bool,
    pub conn_id: u64,
}

pub struct State {
    pub cfg: Config,
    pub db: PgPool,
    pub keys: Keys,
    pub ids: IdGen,
    pub guilds: DashMap<Id, Arc<Guild>>,
    pub chans: DashMap<Id, Arc<Chan>>,
    pub conns: DashMap<Id, Vec<(u64, ConnTx)>>,
    pub voice: Mutex<HashMap<Id, VoiceEntry>>,
    /// Active video sources advertised over the main socket.
    pub media: DashMap<(Id, MediaSource), MediaPresence>,
    /// Caps expensive history/replay work across the process.
    pub history_slots: Arc<Semaphore>,
    /// Per-account concurrency cap for history and replay requests.
    pub user_history_slots: DashMap<Id, Arc<Semaphore>>,
    /// Caps simultaneous disk uploads before streaming bodies to storage.
    pub upload_slots: Arc<Semaphore>,
    /// Bounds CPU and blocking-pool demand from Argon2 password work.
    pub auth_slots: Arc<Semaphore>,
    pub persist: mpsc::Sender<PersistOp>,
    pub metrics: Metrics,
    pub http: reqwest::Client,
    /// (author, nonce) → (message, accepted at µs). Makes client resends after
    /// a reconnect idempotent. Entries live `NONCE_TTL_US`.
    pub nonces: DashMap<(Id, u64), (hopon_shared::Message, i64)>,
    /// Serializes concurrent retries of the same author nonce until its write
    /// is committed, preventing two live fan-outs for one message key.
    pub nonce_locks: DashMap<(Id, u64), Arc<tokio::sync::Mutex<()>>>,
    /// GIF id → (attachment, fetched at), from this server's own searches.
    pub gifs: DashMap<String, (hopon_shared::Attachment, std::time::Instant)>,
    /// What each connected user is playing (cleared when they go offline).
    pub activities: DashMap<Id, String>,
    /// Chosen presence and custom status of each connected user (loaded at sign-in).
    pub statuses: DashMap<Id, UserStatus>,
    /// Connections whose device reported idle, per user.
    pub idle_conns: DashMap<Id, HashSet<u64>>,
    next_conn: AtomicU64,
}

pub const NONCE_TTL_US: i64 = 5 * 60 * 1_000_000;

pub fn kind_from_i16(k: i16) -> ChannelKind {
    if k == 1 {
        ChannelKind::Voice
    } else {
        ChannelKind::Text
    }
}
pub fn kind_to_i16(k: ChannelKind) -> i16 {
    match k {
        ChannelKind::Text => 0,
        ChannelKind::Voice => 1,
    }
}

impl State {
    pub fn new(cfg: Config, db: PgPool, persist: mpsc::Sender<PersistOp>) -> Self {
        Self {
            keys: Keys::new(&cfg.jwt_secret),
            ids: IdGen::new(cfg.node_id),
            cfg,
            db,
            guilds: DashMap::new(),
            chans: DashMap::new(),
            conns: DashMap::new(),
            voice: Mutex::new(HashMap::new()),
            media: DashMap::new(),
            history_slots: Arc::new(Semaphore::new(128)),
            user_history_slots: DashMap::new(),
            upload_slots: Arc::new(Semaphore::new(8)),
            auth_slots: Arc::new(Semaphore::new(8)),
            persist,
            metrics: Metrics::new(),
            http: reqwest::Client::new(),
            nonces: DashMap::new(),
            nonce_locks: DashMap::new(),
            gifs: DashMap::new(),
            activities: DashMap::new(),
            statuses: DashMap::new(),
            idle_conns: DashMap::new(),
            next_conn: AtomicU64::new(1),
        }
    }

    /// Drop expired nonce entries (called periodically).
    pub fn prune_nonces(&self) {
        let cutoff = hopon_shared::time::now_us() - NONCE_TTL_US;
        self.nonces.retain(|_, (_, t)| *t > cutoff);
        self.nonce_locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    }

    pub fn conn_id(&self) -> u64 {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }

    /// Returns true if this is the user's first connection (came online).
    pub fn register(&self, user: Id, conn: u64, tx: ConnTx) -> bool {
        let mut e = self.conns.entry(user).or_default();
        let first = e.is_empty();
        e.push((conn, tx));
        first
    }

    /// Returns true if that was the user's last connection.
    pub fn unregister(&self, user: Id, conn: u64) -> bool {
        if let Some(mut v) = self.conns.get_mut(&user) {
            v.retain(|(c, _)| *c != conn);
        }
        self.conns.remove_if(&user, |_, v| v.is_empty()).is_some()
    }

    pub fn is_online(&self, user: Id) -> bool {
        self.conns.get(&user).map_or(false, |v| !v.is_empty())
    }

    pub fn is_invisible(&self, user: Id) -> bool {
        self.statuses.get(&user).map_or(false, |s| s.mode == StatusMode::Invisible)
    }

    /// Connected and not invisible: what everyone else sees as online.
    pub fn is_visible(&self, user: Id) -> bool {
        self.is_online(user) && !self.is_invisible(user)
    }

    /// Every connection of the user reported idle.
    pub fn is_idle(&self, user: Id) -> bool {
        let Some(idle) = self.idle_conns.get(&user) else { return false };
        self.conns.get(&user).map_or(false, |v| !v.is_empty() && v.iter().all(|(c, _)| idle.contains(c)))
    }

    /// How others see the user right now (None while offline or invisible).
    pub fn shown_status(&self, user: Id) -> Option<UserStatus> {
        if !self.is_visible(user) {
            return None;
        }
        let mut s = self.statuses.get(&user).map(|s| s.current(hopon_shared::time::now_us() / 1000)).unwrap_or_default();
        if s.mode != StatusMode::Dnd && self.is_idle(user) {
            s.mode = StatusMode::Idle;
        }
        Some(s)
    }

    /// (user, status) for the visible users among `users` whose status isn't plain online.
    pub fn statuses_of(&self, users: impl IntoIterator<Item = Id>) -> Vec<(Id, UserStatus)> {
        let now = hopon_shared::time::now_us() / 1000;
        users
            .into_iter()
            .filter_map(|u| self.shown_status(u).filter(|s| !s.is_plain(now)).map(|s| (u, s)))
            .collect()
    }

    /// Tell the user's servers (and their own devices) about a status change.
    pub fn announce_status(&self, user: Id) {
        let shown = self.shown_status(user);
        if let Some(status) = shown.clone() {
            let f = Bytes::from(encode(&ServerFrame { req: 0, msg: S2C::Status { user_id: user, status } }));
            for g in self.guilds.iter().filter(|g| g.is_member(user)) {
                g.publish(f.clone());
            }
        }
        // Your own devices get your chosen status (they may not share a server
        // with you, and while invisible nothing goes to the servers).
        let own = self.statuses.get(&user).map(|s| s.clone()).unwrap_or_default();
        let own = UserStatus { mode: shown.map_or(own.mode, |s| if s.mode == StatusMode::Idle { StatusMode::Idle } else { own.mode }), ..own };
        let f = Bytes::from(encode(&ServerFrame { req: 0, msg: S2C::Status { user_id: user, status: own } }));
        self.to_user(user, || Out::Frame(f.clone()));
    }

    /// Tell the user's servers what they're playing ("" = nothing). Nothing
    /// is announced while they're invisible.
    pub fn announce_activity(&self, user: Id, game: &str) {
        if !game.is_empty() && !self.is_visible(user) {
            return;
        }
        let f = Bytes::from(hopon_shared::encode(&hopon_shared::ServerFrame {
            req: 0,
            msg: hopon_shared::S2C::Activity {
                user_id: user,
                game: game.to_owned(),
            },
        }));
        for g in self.guilds.iter().filter(|g| g.is_member(user)) {
            g.publish(f.clone());
        }
    }

    /// Online/offline as others see it. Going offline clears the game shown;
    /// coming online re-sends the game and status.
    pub fn announce_presence(&self, user: Id, online: bool) {
        if !online && self.activities.contains_key(&user) {
            self.announce_activity(user, "");
        }
        let f = Bytes::from(hopon_shared::encode(&hopon_shared::ServerFrame {
            req: 0,
            msg: hopon_shared::S2C::UserPresence {
                user_id: user,
                online,
            },
        }));
        for g in self.guilds.iter().filter(|g| g.is_member(user)) {
            g.publish(f.clone());
        }
        if online {
            if let Some(game) = self.activities.get(&user).map(|g| g.clone()) {
                self.announce_activity(user, &game);
            }
            self.announce_status(user);
        }
    }

    /// The user's last connection is gone for good: forget their live state and
    /// tell everyone who could see them.
    pub fn went_offline(&self, user: Id) {
        let was_visible = !self.is_invisible(user);
        if was_visible {
            self.announce_presence(user, false);
        }
        self.activities.remove(&user);
        self.statuses.remove(&user);
        self.idle_conns.remove(&user);
    }

    /// Owner of a server (DB lookup; admin actions are rare).
    pub async fn owner_of(&self, server_id: Id) -> Option<Id> {
        sqlx::query_as::<_, (i64,)>("SELECT owner_id FROM servers WHERE id = $1")
            .bind(server_id)
            .fetch_optional(&self.db)
            .await
            .ok()
            .flatten()
            .map(|r| r.0)
    }

    /// Send to every connection of a user.
    pub fn to_user(&self, user: Id, mk: impl Fn() -> Out) {
        if let Some(v) = self.conns.get(&user) {
            for (_, tx) in v.iter() {
                let _ = tx.try_send(mk());
            }
        }
    }

    /// Clear a user's voice presence if it is in `server` (optionally only in
    /// `channel`), announcing the leave. Returns the channel they were in.
    pub fn clear_voice(
        &self,
        user: Id,
        server: Id,
        channel: Option<Id>,
        announce: Option<&Guild>,
    ) -> Option<Id> {
        let removed = {
            let mut v = self.voice.lock();
            match v.get(&user) {
                Some(e) if e.server_id == server && channel.map_or(true, |c| c == e.channel_id) => {
                    self.clear_media(user, e.channel_id);
                    v.remove(&user)
                }
                _ => None,
            }
        }?;
        if let Some(g) = announce {
            g.publish(Bytes::from(hopon_shared::encode(
                &hopon_shared::ServerFrame {
                    req: 0,
                    msg: hopon_shared::S2C::VoicePresence {
                        server_id: server,
                        user_id: user,
                        channel_id: None,
                        muted: false,
                        deafened: false,
                    },
                },
            )));
        }
        Some(removed.channel_id)
    }

    pub fn set_media(&self, presence: MediaPresence) {
        let key = (presence.user_id, presence.source);
        let changed = if presence.active {
            self.media.insert(key, presence) != Some(presence)
        } else {
            self.media.remove_if(&key, |_, current| current.channel_id == presence.channel_id).is_some()
        };
        if changed {
            if let Some(guild) = self.guilds.get(&presence.server_id) {
                guild.publish(Bytes::from(encode(&ServerFrame { req: 0, msg: S2C::MediaPresence(presence) })));
            }
        }
    }

    pub fn clear_media(&self, user: Id, channel: Id) {
        for source in [MediaSource::Screen, MediaSource::Camera] {
            let presence = self.media.get(&(user, source)).map(|entry| *entry.value());
            if let Some(mut presence) = presence.filter(|p| p.channel_id == channel) {
                presence.active = false;
                self.set_media(presence);
            }
        }
    }

    pub fn guild_or_insert(&self, id: Id, members: impl IntoIterator<Item = Id>, dm: Option<(Id, Id)>, dm_open: bool) -> Arc<Guild> {
        self.guilds
            .entry(id)
            .or_insert_with(|| {
                Arc::new(Guild {
                    tx: broadcast::channel(GUILD_BACKLOG).0,
                    members: RwLock::new(members.into_iter().collect()),
                    dm,
                    dm_open: AtomicBool::new(dm_open),
                })
            })
            .clone()
    }

    pub fn chan_insert(&self, c: &ChannelInfo) -> Arc<Chan> {
        self.chans
            .entry(c.id)
            .or_insert_with(|| {
                Arc::new(Chan {
                    server_id: c.server_id,
                    kind: c.kind,
                    deleted: Default::default(),
                    last_id: Default::default(),
                    order: Mutex::new(()),
                })
            })
            .clone()
    }

    /// Channel + guild for a member, loading from the DB on a cache miss.
    pub async fn chan_for(&self, channel_id: Id, user: Id) -> Option<(Arc<Chan>, Arc<Guild>)> {
        let chan = match self.chans.get(&channel_id) {
            Some(c) => c.clone(),
            None => {
                let row: Option<(i64, i64, String, i16, String)> = sqlx::query_as(
                    "SELECT id, server_id, name, kind, topic FROM channels WHERE id = $1",
                )
                .bind(channel_id)
                .fetch_optional(&self.db)
                .await
                .ok()?;
                let (id, server_id, name, kind, topic) = row?;
                self.chan_insert(&ChannelInfo {
                    id,
                    server_id,
                    name,
                    kind: kind_from_i16(kind),
                    topic,
                    last_id: 0,
                })
            }
        };
        if chan.deleted.load(std::sync::atomic::Ordering::Relaxed) {
            return None;
        }
        let guild = self.guild(chan.server_id).await.ok()?;
        guild.is_member(user).then_some((chan, guild))
    }

    pub async fn guild(&self, id: Id) -> Result<Arc<Guild>> {
        if let Some(g) = self.guilds.get(&id) {
            return Ok(g.clone());
        }
        let members: Vec<(i64,)> =
            sqlx::query_as("SELECT user_id FROM members WHERE server_id = $1")
                .bind(id)
                .fetch_all(&self.db)
                .await?;
        let dm: Option<(Id, Id)> = sqlx::query_scalar::<_, Option<String>>("SELECT dm_pair FROM servers WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .flatten()
            .and_then(|k| parse_dm(&k));
        let open = match dm {
            Some((a, b)) => self.are_friends(a, b).await?,
            None => false,
        };
        Ok(self.guild_or_insert(id, members.into_iter().map(|m| m.0), dm, open))
    }

    pub async fn are_friends(&self, a: Id, b: Id) -> Result<bool> {
        let (x, y) = pair(a, b);
        Ok(sqlx::query_scalar::<_, bool>("SELECT accepted FROM friendships WHERE user_a = $1 AND user_b = $2")
            .bind(x)
            .bind(y)
            .fetch_optional(&self.db)
            .await?
            .unwrap_or(false))
    }

    /// The DM server between two people, if it exists.
    pub async fn dm_between(&self, a: Id, b: Id) -> Result<Option<Id>> {
        Ok(sqlx::query_scalar("SELECT id FROM servers WHERE dm_pair = $1")
            .bind(dm_key(a, b))
            .fetch_optional(&self.db)
            .await?)
    }

    /// Everyone `user` is friends with or has a request with, seen from `user`'s side.
    pub async fn load_friends(&self, user: Id) -> Result<Vec<Friend>> {
        let rows: Vec<(i64, String, String, i32, i16, i64, bool, Option<i64>)> = sqlx::query_as(
            "SELECT u.id, u.name, COALESCE(u.display_name, u.name), u.avatar_v, u.accent, f.requested_by, f.accepted, \
                    (SELECT s.id FROM servers s WHERE s.dm_pair = f.user_a::text || ':' || f.user_b::text) \
             FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END \
             WHERE f.user_a = $1 OR f.user_b = $1 ORDER BY u.name_lower",
        )
        .bind(user)
        .fetch_all(&self.db)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, username, name, avatar_v, accent, by, accepted, dm)| Friend {
                user: UserInfo { id, name, avatar_v: avatar_v as u32, accent: accent as u8 },
                username,
                state: if accepted { FriendState::Friends } else if by == user { FriendState::Outgoing } else { FriendState::Incoming },
                dm_server: dm,
            })
            .collect())
    }

    /// One friendship as `user` sees it (None: no friendship or request).
    pub async fn friend_of(&self, user: Id, other: Id) -> Result<Option<Friend>> {
        Ok(self.load_friends(user).await?.into_iter().find(|f| f.user.id == other))
    }

    /// Full snapshots of the given servers (or every server of `user` when
    /// `only` is None). Three queries regardless of server count.
    pub async fn load_servers(&self, user: Id, only: Option<Id>) -> Result<Vec<ServerInfo>> {
        let rows: Vec<(i64, String, i64, Option<String>)> = match only {
            Some(sid) => sqlx::query_as("SELECT id, name, owner_id, dm_pair FROM servers WHERE id = $1")
                .bind(sid)
                .fetch_all(&self.db)
                .await?,
            None => sqlx::query_as(
                "SELECT s.id, s.name, s.owner_id, s.dm_pair FROM servers s JOIN members m ON m.server_id = s.id \
                 WHERE m.user_id = $1 ORDER BY s.id",
            )
            .bind(user)
            .fetch_all(&self.db)
            .await?,
        };
        let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
        let chans: Vec<(i64, i64, String, i16, String)> = sqlx::query_as(
            "SELECT id, server_id, name, kind, topic FROM channels WHERE server_id = ANY($1) ORDER BY id",
        )
        .bind(&ids)
        .fetch_all(&self.db)
        .await?;
        let counts: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT server_id, count(*) FROM members WHERE server_id = ANY($1) GROUP BY server_id",
        )
        .bind(&ids)
        .fetch_all(&self.db)
        .await?;
        let counts: HashMap<i64, u32> =
            counts.into_iter().map(|(sid, n)| (sid, n as u32)).collect();

        let chan_ids: Vec<i64> = chans.iter().map(|c| c.0).collect();
        // Newest message per channel: one backward index probe each.
        let lasts: Vec<(i64, Option<i64>)> = sqlx::query_as(
            "SELECT c.id, (SELECT m.id FROM messages m WHERE m.channel_id = c.id ORDER BY m.id DESC LIMIT 1) \
             FROM unnest($1::bigint[]) AS c(id)",
        )
        .bind(&chan_ids)
        .fetch_all(&self.db)
        .await?;
        let lasts: HashMap<i64, i64> = lasts
            .into_iter()
            .map(|(c, m)| (c, m.unwrap_or(0)))
            .collect();
        let reads: Vec<(i64, i64)> = sqlx::query_as("SELECT channel_id, last_read FROM channel_reads WHERE user_id = $1 AND channel_id = ANY($2)")
            .bind(user)
            .bind(&chan_ids)
            .fetch_all(&self.db)
            .await?;
        let read_map: HashMap<i64, i64> = reads.into_iter().collect();

        let mut out: Vec<ServerInfo> = rows
            .into_iter()
            .map(|(id, name, owner_id, dm)| ServerInfo {
                id,
                name,
                owner_id,
                channels: vec![],
                members: vec![],
                member_ids: vec![],
                member_count: counts.get(&id).copied().unwrap_or(0),
                reads: vec![],
                online: vec![],
                activities: vec![],
                statuses: vec![],
                dm_with: dm.as_deref().and_then(parse_dm).map(|(a, b)| if a == user { b } else { a }),
            })
            .collect();
        // A DM's two people travel with it (the other person may not be a friend any more).
        let dm_ids: Vec<i64> = out.iter().filter(|s| s.dm_with.is_some()).map(|s| s.id).collect();
        if !dm_ids.is_empty() {
            let people: Vec<(i64, i64, String, i32, i16)> = sqlx::query_as(
                "SELECT m.server_id, u.id, COALESCE(u.display_name, u.name), u.avatar_v, u.accent FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ANY($1)",
            )
            .bind(&dm_ids)
            .fetch_all(&self.db)
            .await?;
            for (sid, uid, name, av, accent) in people {
                if let Some(s) = out.iter_mut().find(|s| s.id == sid) {
                    s.members.push(UserInfo { id: uid, name, avatar_v: av as u32, accent: accent as u8 });
                    s.member_ids.push(uid);
                    if self.is_visible(uid) {
                        s.online.push(uid);
                        if let Some(g) = self.activities.get(&uid) {
                            s.activities.push((uid, g.clone()));
                        }
                    }
                    s.statuses.extend(self.statuses_of([uid]));
                }
            }
        }
        let idx: HashMap<i64, usize> = out.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
        for (id, server_id, name, kind, topic) in chans {
            let mut c = ChannelInfo {
                id,
                server_id,
                name,
                kind: kind_from_i16(kind),
                topic,
                last_id: 0,
            };
            let chan = self.chan_insert(&c);
            // Persistence lags fan-out slightly: take whichever is newer.
            c.last_id = lasts
                .get(&id)
                .copied()
                .unwrap_or(0)
                .max(chan.last_id.load(std::sync::atomic::Ordering::Relaxed));
            if let Some(r) = read_map.get(&id) {
                out[idx[&server_id]].reads.push((id, *r));
            }
            out[idx[&server_id]].channels.push(c);
        }
        for s in &out {
            // Routing membership stays server-side; the compact client manifest
            // intentionally contains no full roster.
            let _ = self.guild(s.id).await?;
        }
        Ok(out)
    }

    pub async fn load_members(
        &self,
        user: Id,
        server_id: Id,
        offset: u32,
        limit: u16,
    ) -> Result<(Vec<UserInfo>, Vec<Id>, Vec<(Id, String)>, Vec<(Id, UserStatus)>)> {
        let guild = self.guild(server_id).await?;
        anyhow::ensure!(guild.is_member(user), "not a member");
        let rows: Vec<(i64, String, i32, i16)> = sqlx::query_as(
            "SELECT u.id, COALESCE(u.display_name, u.name), u.avatar_v, u.accent FROM members m JOIN users u ON u.id = m.user_id \
             WHERE m.server_id = $1 ORDER BY u.name_lower, u.id LIMIT $2 OFFSET $3",
        )
        .bind(server_id)
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&self.db)
        .await?;
        let users: Vec<UserInfo> = rows
            .into_iter()
            .map(|(id, name, avatar_v, accent)| UserInfo {
                id,
                name,
                avatar_v: avatar_v as u32,
                accent: accent as u8,
            })
            .collect();
        let online: Vec<Id> = users
            .iter()
            .filter(|u| self.is_visible(u.id))
            .map(|u| u.id)
            .collect();
        let activities = online
            .iter()
            .filter_map(|u| self.activities.get(u).map(|g| (*u, g.clone())))
            .collect();
        let statuses = self.statuses_of(online.iter().copied());
        Ok((users, online, activities, statuses))
    }

    pub async fn search_members(
        &self,
        user: Id,
        server_id: Id,
        query: &str,
        limit: u16,
    ) -> Result<Vec<UserInfo>> {
        let guild = self.guild(server_id).await?;
        anyhow::ensure!(guild.is_member(user), "not a member");
        let prefix = query.to_lowercase();
        let rows: Vec<(i64, String, i32, i16)> = sqlx::query_as(
            "SELECT u.id, COALESCE(u.display_name, u.name), u.avatar_v, u.accent FROM members m JOIN users u ON u.id = m.user_id \
             WHERE m.server_id = $1 AND (left(lower(COALESCE(u.display_name, u.name)), char_length($2)) = $2 \
               OR left(u.name_lower, char_length($2)) = $2) ORDER BY u.name_lower, u.id LIMIT $3",
        )
        .bind(server_id).bind(prefix).bind(limit as i64).fetch_all(&self.db).await?;
        Ok(rows
            .into_iter()
            .map(|(id, name, avatar_v, accent)| UserInfo {
                id,
                name,
                avatar_v: avatar_v as u32,
                accent: accent as u8,
            })
            .collect())
    }

    pub async fn lookup_member(
        &self,
        user: Id,
        server_id: Id,
        user_id: Id,
    ) -> Result<Option<UserInfo>> {
        let guild = self.guild(server_id).await?;
        anyhow::ensure!(guild.is_member(user), "not a member");
        let row: Option<(i64, String, i32, i16)> = sqlx::query_as(
            "SELECT u.id, COALESCE(u.display_name, u.name), u.avatar_v, u.accent FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = $1 AND u.id = $2",
        )
        .bind(server_id).bind(user_id).fetch_optional(&self.db).await?;
        Ok(row.map(|(id, name, avatar_v, accent)| UserInfo {
            id,
            name,
            avatar_v: avatar_v as u32,
            accent: accent as u8,
        }))
    }
}
