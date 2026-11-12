//! Local SQLite cache: recent history per channel (instant channel switches
//! and offline scroll-back) plus a small key/value store. One dedicated thread
//! owns the connection; writes are coalesced into one transaction per wake-up.

use hopon_shared::{Id, Message};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::mpsc;
use tokio::sync::oneshot;

enum Op {
    Put(Vec<Message>),
    Edit(Id, Id, String, i64),
    Delete(Id, Id),
    PurgeChannels(Vec<Id>),
    Page { channel: Id, before: Id, limit: u32, reply: oneshot::Sender<Vec<Message>> },
    KvSet(String, Option<Vec<u8>>),
    KvGet(String, oneshot::Sender<Option<Vec<u8>>>),
}

#[derive(Clone)]
pub struct Cache {
    tx: mpsc::Sender<Op>,
}

/// Bump when the message table changes. The cache is disposable: an old
/// version's message table is dropped and refilled from the server.
const SCHEMA_VERSION: i64 = 3;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS messages (
  channel_id INTEGER NOT NULL, id INTEGER NOT NULL, author_id INTEGER NOT NULL,
  content TEXT NOT NULL, edited_at INTEGER, reply_to INTEGER, reactions TEXT, attachments TEXT,
  PRIMARY KEY (channel_id, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID;
";

fn reactions_json(r: &[hopon_shared::Reaction]) -> Option<String> {
    if r.is_empty() {
        return None;
    }
    let v: Vec<(&str, &[Id])> = r.iter().map(|x| (x.emoji.as_str(), x.users.as_slice())).collect();
    serde_json::to_string(&v).ok()
}

fn reactions_from(s: Option<String>) -> Vec<hopon_shared::Reaction> {
    s.and_then(|s| serde_json::from_str::<Vec<(String, Vec<Id>)>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|(emoji, users)| hopon_shared::Reaction { emoji, users })
        .collect()
}

/// Rows kept per channel; older pages come from the server.
const KEEP_PER_CHANNEL: i64 = 5000;

impl Cache {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        Self::start(Connection::open(path)?)
    }

    /// Fallback when the cache file can't be used (locked, corrupt, read-only).
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::start(Connection::open_in_memory()?)
    }

    fn start(conn: Connection) -> anyhow::Result<Self> {
        // Wait for another holder (e.g. an old instance shutting down)
        // instead of failing immediately with "database is locked".
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if v < SCHEMA_VERSION {
            conn.execute_batch(&format!("DROP TABLE IF EXISTS messages; PRAGMA user_version = {SCHEMA_VERSION};"))?;
        }
        conn.execute_batch(SCHEMA)?;
        let (tx, rx) = mpsc::channel::<Op>();
        std::thread::Builder::new().name("hopon-cache".into()).spawn(move || run(conn, rx))?;
        Ok(Self { tx })
    }

    pub fn put(&self, m: Vec<Message>) {
        if !m.is_empty() {
            let _ = self.tx.send(Op::Put(m));
        }
    }
    pub fn edit(&self, ch: Id, id: Id, content: String, at: i64) {
        let _ = self.tx.send(Op::Edit(ch, id, content, at));
    }
    pub fn delete(&self, ch: Id, id: Id) {
        let _ = self.tx.send(Op::Delete(ch, id));
    }
    /// Forget every cached message of these channels (deleted or no longer
    /// accessible).
    pub fn purge_channels(&self, ids: Vec<Id>) {
        if !ids.is_empty() {
            let _ = self.tx.send(Op::PurgeChannels(ids));
        }
    }
    /// Newest-first page older than `before`.
    pub async fn page(&self, channel: Id, before: Id, limit: u32) -> Vec<Message> {
        let (reply, rx) = oneshot::channel();
        let _ = self.tx.send(Op::Page { channel, before, limit, reply });
        rx.await.unwrap_or_default()
    }
    pub fn kv_set(&self, k: &str, v: Option<Vec<u8>>) {
        let _ = self.tx.send(Op::KvSet(k.into(), v));
    }
    pub async fn kv_get(&self, k: &str) -> Option<Vec<u8>> {
        let (reply, rx) = oneshot::channel();
        let _ = self.tx.send(Op::KvGet(k.into(), reply));
        rx.await.ok().flatten()
    }
}

fn run(mut conn: Connection, rx: mpsc::Receiver<Op>) {
    let mut puts = 0u32;
    while let Ok(first) = rx.recv() {
        let mut ops = vec![first];
        while let Ok(o) = rx.try_recv() {
            ops.push(o);
            if ops.len() >= 512 {
                break;
            }
        }
        let Ok(tx) = conn.transaction() else { continue };
        for op in ops {
            let r: rusqlite::Result<()> = (|| {
                match op {
                    Op::Put(ms) => {
                        let mut st = tx.prepare_cached(
                            "INSERT INTO messages (channel_id, id, author_id, content, edited_at, reply_to, reactions, attachments) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                             ON CONFLICT (channel_id, id) DO UPDATE SET content = excluded.content, edited_at = excluded.edited_at, \
                             reply_to = excluded.reply_to, reactions = excluded.reactions, attachments = excluded.attachments",
                        )?;
                        for m in ms {
                            let att = (!m.attachments.is_empty()).then(|| serde_json::to_string(&m.attachments).unwrap_or_default());
                            st.execute(params![m.channel_id, m.id, m.author_id, m.content, m.edited_at, m.reply_to, reactions_json(&m.reactions), att])?;
                        }
                        puts += 1;
                    }
                    Op::Edit(ch, id, c, at) => {
                        tx.prepare_cached("UPDATE messages SET content = ?3, edited_at = ?4 WHERE channel_id = ?1 AND id = ?2")?
                            .execute(params![ch, id, c, at])?;
                    }
                    Op::Delete(ch, id) => {
                        tx.prepare_cached("DELETE FROM messages WHERE channel_id = ?1 AND id = ?2")?.execute(params![ch, id])?;
                    }
                    Op::PurgeChannels(ids) => {
                        let mut st = tx.prepare_cached("DELETE FROM messages WHERE channel_id = ?1")?;
                        for id in ids {
                            st.execute(params![id])?;
                        }
                    }
                    Op::Page { channel, before, limit, reply } => {
                        let mut st = tx.prepare_cached(
                            "SELECT id, author_id, content, edited_at, reply_to, reactions, attachments FROM messages WHERE channel_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3",
                        )?;
                        let rows = st
                            .query_map(params![channel, before, limit], |r| {
                                Ok(Message {
                                    id: r.get(0)?,
                                    channel_id: channel,
                                    author_id: r.get(1)?,
                                    content: r.get(2)?,
                                    edited_at: r.get(3)?,
                                    nonce: 0,
                                    trace: None,
                                    reply_to: r.get(4)?,
                                    reactions: reactions_from(r.get(5)?),
                                    attachments: r.get::<_, Option<String>>(6)?.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default(),
                                })
                            })?
                            .filter_map(Result::ok)
                            .collect();
                        let _ = reply.send(rows);
                    }
                    Op::KvSet(k, Some(v)) => {
                        tx.prepare_cached("INSERT OR REPLACE INTO kv (k, v) VALUES (?1, ?2)")?.execute(params![k, v])?;
                    }
                    Op::KvSet(k, None) => {
                        tx.prepare_cached("DELETE FROM kv WHERE k = ?1")?.execute(params![k])?;
                    }
                    Op::KvGet(k, reply) => {
                        let v = tx.prepare_cached("SELECT v FROM kv WHERE k = ?1")?.query_row(params![k], |r| r.get(0)).optional()?;
                        let _ = reply.send(v);
                    }
                }
                Ok(())
            })();
            if let Err(e) = r {
                tracing::warn!("cache: {e}");
            }
        }
        let _ = tx.commit();
        // Trim occasionally so the cache stays bounded.
        if puts >= 200 {
            puts = 0;
            let _ = conn.execute(
                "DELETE FROM messages WHERE (channel_id, id) IN (SELECT channel_id, id FROM (SELECT channel_id, id, \
                 ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY id DESC) rn FROM messages) WHERE rn > ?1)",
                params![KEEP_PER_CHANNEL],
            );
        }
    }
}
