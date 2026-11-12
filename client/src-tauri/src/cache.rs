//! Local SQLite cache: recent history per channel (instant channel switches
//! and offline scroll-back) plus a small key/value store. One dedicated thread
//! owns the connection; writes are coalesced into one transaction per wake-up.

use hopon_shared::{Id, Message};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use tokio::sync::oneshot;

const CACHE_QUEUE_CAPACITY: usize = 2048;
const OUTBOX_MAX_ITEMS: i64 = 1000;
const CACHE_MAX_BYTES: i64 = 512 * 1024 * 1024;
const CACHE_TRIM_BYTES: i64 = 320 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutboxItem {
    pub nonce: u64,
    pub user_id: Id,
    pub channel_id: Id,
    pub content: String,
    pub reply_to: Option<Id>,
    pub files: Vec<String>,
    pub gifs: Vec<String>,
    pub t_input: i64,
}

enum Op {
    Put(Vec<Message>),
    Edit(Id, Id, String, i64),
    Delete(Id, Id),
    PurgeChannels(Vec<Id>),
    Page {
        channel: Id,
        before: Id,
        limit: u32,
        reply: oneshot::Sender<Vec<Message>>,
    },
    KvSet(String, Option<Vec<u8>>),
    KvGet(String, oneshot::Sender<Option<Vec<u8>>>),
    OutboxPut(OutboxItem, oneshot::Sender<bool>),
    OutboxRemove(u64, oneshot::Sender<bool>),
    OutboxList(oneshot::Sender<Vec<OutboxItem>>),
}

#[derive(Clone)]
pub struct Cache {
    tx: SyncSender<Op>,
}

/// Bump when the message table changes. The cache is disposable: an old
/// version's message table is dropped and refilled from the server.
const SCHEMA_VERSION: i64 = 4;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA auto_vacuum = INCREMENTAL;
CREATE TABLE IF NOT EXISTS messages (
  channel_id INTEGER NOT NULL, id INTEGER NOT NULL, author_id INTEGER NOT NULL,
  content TEXT NOT NULL, edited_at INTEGER, reply_to INTEGER, reactions TEXT, attachments TEXT,
  PRIMARY KEY (channel_id, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS channel_access (channel_id INTEGER PRIMARY KEY, touched_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS outbox (nonce TEXT PRIMARY KEY, body BLOB NOT NULL) WITHOUT ROWID;
";

fn reactions_json(r: &[hopon_shared::Reaction]) -> Option<String> {
    if r.is_empty() {
        return None;
    }
    let v: Vec<(&str, &[Id])> = r
        .iter()
        .map(|x| (x.emoji.as_str(), x.users.as_slice()))
        .collect();
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
            conn.execute_batch(&format!("DROP TABLE IF EXISTS messages; PRAGMA user_version = {SCHEMA_VERSION}; PRAGMA auto_vacuum = INCREMENTAL; VACUUM;"))?;
        }
        conn.execute_batch(SCHEMA)?;
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        conn.pragma_update(None, "max_page_count", CACHE_MAX_BYTES / page_size.max(1))?;
        let (tx, rx) = mpsc::sync_channel::<Op>(CACHE_QUEUE_CAPACITY);
        std::thread::Builder::new()
            .name("hopon-cache".into())
            .spawn(move || run(conn, rx))?;
        Ok(Self { tx })
    }

    pub fn put(&self, m: Vec<Message>) {
        if !m.is_empty() {
            Self::try_send(&self.tx, Op::Put(m));
        }
    }
    pub fn edit(&self, ch: Id, id: Id, content: String, at: i64) {
        if self.tx.send(Op::Edit(ch, id, content, at)).is_err() {
            tracing::warn!("cache worker stopped; edit cache invalidation lost");
        }
    }
    pub fn delete(&self, ch: Id, id: Id) {
        if self.tx.send(Op::Delete(ch, id)).is_err() {
            tracing::warn!("cache worker stopped; delete cache invalidation lost");
        }
    }
    /// Forget every cached message of these channels (deleted or no longer
    /// accessible).
    pub fn purge_channels(&self, ids: Vec<Id>) {
        if !ids.is_empty() {
            if self.tx.send(Op::PurgeChannels(ids)).is_err() {
                tracing::warn!("cache worker stopped; channel purge lost");
            }
        }
    }
    /// Newest-first page older than `before`.
    pub async fn page(&self, channel: Id, before: Id, limit: u32) -> Vec<Message> {
        let (reply, rx) = oneshot::channel();
        Self::send_wait(
            &self.tx,
            Op::Page {
                channel,
                before,
                limit,
                reply,
            },
        )
        .await;
        rx.await.unwrap_or_default()
    }
    pub fn kv_set(&self, k: &str, v: Option<Vec<u8>>) {
        if self.tx.send(Op::KvSet(k.into(), v)).is_err() {
            tracing::warn!("cache worker stopped; settings write lost");
        }
    }
    pub async fn kv_get(&self, k: &str) -> Option<Vec<u8>> {
        let (reply, rx) = oneshot::channel();
        Self::send_wait(&self.tx, Op::KvGet(k.into(), reply)).await;
        rx.await.ok().flatten()
    }

    pub async fn outbox_put(&self, item: OutboxItem) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        Self::send_wait(&self.tx, Op::OutboxPut(item, tx)).await;
        if rx.await.unwrap_or(false) {
            Ok(())
        } else {
            Err(anyhow::anyhow!("could not persist outgoing message"))
        }
    }

    pub async fn outbox_remove(&self, nonce: u64) {
        let (tx, rx) = oneshot::channel();
        Self::send_wait(&self.tx, Op::OutboxRemove(nonce, tx)).await;
        let _ = rx.await;
    }

    pub async fn outbox_list(&self) -> Vec<OutboxItem> {
        let (tx, rx) = oneshot::channel();
        Self::send_wait(&self.tx, Op::OutboxList(tx)).await;
        rx.await.unwrap_or_default()
    }

    fn try_send(tx: &SyncSender<Op>, op: Op) {
        match tx.try_send(op) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                tracing::warn!("cache worker queue full; disposable cache update skipped")
            }
            Err(TrySendError::Disconnected(_)) => tracing::warn!("cache worker stopped"),
        }
    }

    async fn send_wait(tx: &SyncSender<Op>, mut op: Op) {
        loop {
            match tx.try_send(op) {
                Ok(()) => return,
                Err(TrySendError::Full(next)) => {
                    op = next;
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                Err(TrySendError::Disconnected(_)) => return,
            }
        }
    }
}

fn run(mut conn: Connection, rx: mpsc::Receiver<Op>) {
    let _ = trim_global(&mut conn);
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
        let mut replies: Vec<(oneshot::Sender<bool>, bool)> = Vec::new();
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
                            let att = (!m.attachments.is_empty())
                                .then(|| serde_json::to_string(&m.attachments).unwrap_or_default());
                            st.execute(params![
                                m.channel_id,
                                m.id,
                                m.author_id,
                                m.content,
                                m.edited_at,
                                m.reply_to,
                                reactions_json(&m.reactions),
                                att
                            ])?;
                            tx.prepare_cached("INSERT INTO channel_access (channel_id, touched_at) VALUES (?1, unixepoch()) ON CONFLICT(channel_id) DO UPDATE SET touched_at=excluded.touched_at")?.execute([m.channel_id])?;
                        }
                        puts += 1;
                    }
                    Op::Edit(ch, id, c, at) => {
                        tx.prepare_cached("UPDATE messages SET content = ?3, edited_at = ?4 WHERE channel_id = ?1 AND id = ?2")?
                            .execute(params![ch, id, c, at])?;
                    }
                    Op::Delete(ch, id) => {
                        tx.prepare_cached(
                            "DELETE FROM messages WHERE channel_id = ?1 AND id = ?2",
                        )?
                        .execute(params![ch, id])?;
                    }
                    Op::PurgeChannels(ids) => {
                        let mut st =
                            tx.prepare_cached("DELETE FROM messages WHERE channel_id = ?1")?;
                        for id in ids {
                            st.execute(params![id])?;
                        }
                    }
                    Op::Page {
                        channel,
                        before,
                        limit,
                        reply,
                    } => {
                        tx.prepare_cached("INSERT INTO channel_access (channel_id, touched_at) VALUES (?1, unixepoch()) ON CONFLICT(channel_id) DO UPDATE SET touched_at=excluded.touched_at")?.execute([channel])?;
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
                                    attachments: r
                                        .get::<_, Option<String>>(6)?
                                        .and_then(|j| serde_json::from_str(&j).ok())
                                        .unwrap_or_default(),
                                })
                            })?
                            .filter_map(Result::ok)
                            .collect();
                        let _ = reply.send(rows);
                    }
                    Op::KvSet(k, Some(v)) => {
                        tx.prepare_cached("INSERT OR REPLACE INTO kv (k, v) VALUES (?1, ?2)")?
                            .execute(params![k, v])?;
                    }
                    Op::KvSet(k, None) => {
                        tx.prepare_cached("DELETE FROM kv WHERE k = ?1")?
                            .execute(params![k])?;
                    }
                    Op::KvGet(k, reply) => {
                        let v = tx
                            .prepare_cached("SELECT v FROM kv WHERE k = ?1")?
                            .query_row(params![k], |r| r.get(0))
                            .optional()?;
                        let _ = reply.send(v);
                    }
                    Op::OutboxPut(item, reply) => {
                        let count: i64 =
                            tx.query_row("SELECT count(*) FROM outbox", [], |r| r.get(0))?;
                        let exists: bool = tx.query_row(
                            "SELECT EXISTS(SELECT 1 FROM outbox WHERE nonce = ?1)",
                            [item.nonce.to_string()],
                            |r| r.get(0),
                        )?;
                        if count >= OUTBOX_MAX_ITEMS && !exists {
                            replies.push((reply, false));
                            return Ok(());
                        }
                        let body = serde_json::to_vec(&item)
                            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                        tx.prepare_cached(
                            "INSERT OR REPLACE INTO outbox (nonce, body) VALUES (?1, ?2)",
                        )?
                        .execute(params![item.nonce.to_string(), body])?;
                        replies.push((reply, true));
                    }
                    Op::OutboxRemove(nonce, reply) => {
                        tx.prepare_cached("DELETE FROM outbox WHERE nonce = ?1")?
                            .execute([nonce.to_string()])?;
                        replies.push((reply, true));
                    }
                    Op::OutboxList(reply) => {
                        let mut st = tx.prepare_cached("SELECT body FROM outbox ORDER BY nonce")?;
                        let items = st
                            .query_map([], |r| r.get::<_, Vec<u8>>(0))?
                            .filter_map(Result::ok)
                            .filter_map(|b| serde_json::from_slice::<OutboxItem>(&b).ok())
                            .collect();
                        drop(st);
                        // List is read-only; the result can be delivered before this batch commits.
                        // The transaction boundary guarantees a consistent snapshot.
                        let _ = reply.send(items);
                    }
                }
                Ok(())
            })();
            if let Err(e) = r {
                tracing::warn!("cache: {e}");
            }
        }
        let committed = tx.commit().is_ok();
        for (reply, ok) in replies {
            let _ = reply.send(committed && ok);
        }
        // Trim occasionally so the cache stays bounded.
        if puts >= 200 {
            puts = 0;
            let _ = conn.execute(
                "DELETE FROM messages WHERE (channel_id, id) IN (SELECT channel_id, id FROM (SELECT channel_id, id, \
                 ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY id DESC) rn FROM messages) WHERE rn > ?1)",
                params![KEEP_PER_CHANNEL],
            );
            let _ = trim_global(&mut conn);
        }
    }
}

fn trim_global(conn: &mut Connection) -> rusqlite::Result<()> {
    let page_size = conn.query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0))?;
    let tx = conn.transaction()?;
    loop {
        let bytes: i64 = tx.query_row("SELECT COALESCE(SUM(length(content) + length(COALESCE(attachments, '')) + 96), 0) FROM messages", [], |r| r.get(0))?;
        if bytes <= CACHE_TRIM_BYTES {
            break;
        }
        let channel: Option<i64> = tx
            .query_row(
                "SELECT channel_id FROM channel_access ORDER BY touched_at ASC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let Some(channel) = channel else { break };
        tx.execute("DELETE FROM messages WHERE channel_id = ?1", [channel])?;
        tx.execute(
            "DELETE FROM channel_access WHERE channel_id = ?1",
            [channel],
        )?;
    }
    tx.commit()?;
    let max_pages = CACHE_MAX_BYTES / page_size.max(1);
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    if page_count > max_pages || page_count.saturating_mul(page_size) > CACHE_TRIM_BYTES {
        conn.execute_batch("PRAGMA incremental_vacuum(512)")?;
    }
    Ok(())
}
