//! In-memory routing state. One `broadcast` per server (guild): a member's
//! connection holds one receiver per server instead of one per channel, so a
//! user in 10 servers with 30 channels costs 10 receivers, not 30. Events are
//! encoded once and shared as `Bytes` across all receivers.

use crate::{auth::Keys, config::Config, metrics::Metrics, persist::PersistOp};
use anyhow::Result;
use bytes::Bytes;
use dashmap::DashMap;
use hopon_shared::{ids::IdGen, ChannelInfo, ChannelKind, Id, ServerInfo, UserInfo};
use parking_lot::{Mutex, RwLock};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

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
}

impl Guild {
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
    pub persist: mpsc::Sender<PersistOp>,
    pub metrics: Metrics,
    pub http: reqwest::Client,
    /// (author, nonce) → (message, accepted at µs). Makes client resends after
    /// a reconnect idempotent. Entries live `NONCE_TTL_US`.
    pub nonces: DashMap<(Id, u64), (hopon_shared::Message, i64)>,
    next_conn: AtomicU64,
}

pub const NONCE_TTL_US: i64 = 5 * 60 * 1_000_000;

pub fn kind_from_i16(k: i16) -> ChannelKind {
    if k == 1 { ChannelKind::Voice } else { ChannelKind::Text }
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
            persist,
            metrics: Metrics::new(),
            http: reqwest::Client::new(),
            nonces: DashMap::new(),
            next_conn: AtomicU64::new(1),
        }
    }

    /// Drop expired nonce entries (called periodically).
    pub fn prune_nonces(&self) {
        let cutoff = hopon_shared::time::now_us() - NONCE_TTL_US;
        self.nonces.retain(|_, (_, t)| *t > cutoff);
    }

    pub fn conn_id(&self) -> u64 {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }

    pub fn register(&self, user: Id, conn: u64, tx: ConnTx) {
        self.conns.entry(user).or_default().push((conn, tx));
    }

    pub fn unregister(&self, user: Id, conn: u64) {
        if let Some(mut v) = self.conns.get_mut(&user) {
            v.retain(|(c, _)| *c != conn);
        }
        self.conns.remove_if(&user, |_, v| v.is_empty());
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
    pub fn clear_voice(&self, user: Id, server: Id, channel: Option<Id>, announce: Option<&Guild>) -> Option<Id> {
        let removed = {
            let mut v = self.voice.lock();
            match v.get(&user) {
                Some(e) if e.server_id == server && channel.map_or(true, |c| c == e.channel_id) => v.remove(&user),
                _ => None,
            }
        }?;
        if let Some(g) = announce {
            g.publish(Bytes::from(hopon_shared::encode(&hopon_shared::ServerFrame {
                req: 0,
                msg: hopon_shared::S2C::VoicePresence { server_id: server, user_id: user, channel_id: None, muted: false, deafened: false },
            })));
        }
        Some(removed.channel_id)
    }

    pub fn guild_or_insert(&self, id: Id, members: impl IntoIterator<Item = Id>) -> Arc<Guild> {
        self.guilds
            .entry(id)
            .or_insert_with(|| {
                Arc::new(Guild {
                    tx: broadcast::channel(GUILD_BACKLOG).0,
                    members: RwLock::new(members.into_iter().collect()),
                })
            })
            .clone()
    }

    pub fn chan_insert(&self, c: &ChannelInfo) -> Arc<Chan> {
        self.chans
            .entry(c.id)
            .or_insert_with(|| {
                Arc::new(Chan { server_id: c.server_id, kind: c.kind, deleted: Default::default(), order: Mutex::new(()) })
            })
            .clone()
    }

    /// Channel + guild for a member, loading from the DB on a cache miss.
    pub async fn chan_for(&self, channel_id: Id, user: Id) -> Option<(Arc<Chan>, Arc<Guild>)> {
        let chan = match self.chans.get(&channel_id) {
            Some(c) => c.clone(),
            None => {
                let row: Option<(i64, i64, String, i16, String)> =
                    sqlx::query_as("SELECT id, server_id, name, kind, topic FROM channels WHERE id = $1")
                        .bind(channel_id)
                        .fetch_optional(&self.db)
                        .await
                        .ok()?;
                let (id, server_id, name, kind, topic) = row?;
                self.chan_insert(&ChannelInfo { id, server_id, name, kind: kind_from_i16(kind), topic })
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
            sqlx::query_as("SELECT user_id FROM members WHERE server_id = $1").bind(id).fetch_all(&self.db).await?;
        Ok(self.guild_or_insert(id, members.into_iter().map(|m| m.0)))
    }

    /// Full snapshots of the given servers (or every server of `user` when
    /// `only` is None). Three queries regardless of server count.
    pub async fn load_servers(&self, user: Id, only: Option<Id>) -> Result<Vec<ServerInfo>> {
        let rows: Vec<(i64, String, i64)> = match only {
            Some(sid) => sqlx::query_as("SELECT id, name, owner_id FROM servers WHERE id = $1")
                .bind(sid)
                .fetch_all(&self.db)
                .await?,
            None => sqlx::query_as(
                "SELECT s.id, s.name, s.owner_id FROM servers s JOIN members m ON m.server_id = s.id \
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
        let mems: Vec<(i64, i64, String, i32)> = sqlx::query_as(
            "SELECT m.server_id, u.id, u.name, u.avatar_v FROM members m JOIN users u ON u.id = m.user_id \
             WHERE m.server_id = ANY($1) ORDER BY u.name_lower",
        )
        .bind(&ids)
        .fetch_all(&self.db)
        .await?;

        let mut out: Vec<ServerInfo> = rows
            .into_iter()
            .map(|(id, name, owner_id)| ServerInfo { id, name, owner_id, channels: vec![], members: vec![] })
            .collect();
        let idx: HashMap<i64, usize> = out.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
        for (id, server_id, name, kind, topic) in chans {
            let c = ChannelInfo { id, server_id, name, kind: kind_from_i16(kind), topic };
            self.chan_insert(&c);
            out[idx[&server_id]].channels.push(c);
        }
        for (sid, id, name, av) in mems {
            out[idx[&sid]].members.push(UserInfo { id, name, avatar_v: av as u32 });
        }
        for s in &out {
            let g = self.guild_or_insert(s.id, s.members.iter().map(|m| m.id));
            // Refresh membership in case the cached guild is stale.
            let mut m = g.members.write();
            for u in &s.members {
                m.insert(u.id);
            }
        }
        Ok(out)
    }
}
