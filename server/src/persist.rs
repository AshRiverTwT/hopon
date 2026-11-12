//! Asynchronous, batched persistence. Messages are fanned out before they are
//! written; this single ordered queue writes them in batches (one `UNNEST`
//! insert per transaction) and acks the author once committed.
//!
//! Ordering: within a batch all inserts run first, then edits/deletes in
//! arrival order. An edit can only target a message that was enqueued before
//! it, so that order is always valid.

use crate::state::{ConnTx, Out, State};
use bytes::Bytes;
use hopon_shared::{encode, time::now_us, ErrorCode, Id, ServerFrame, S2C};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub const QUEUE: usize = 65_536;
const MAX_BATCH: usize = 1024;

pub struct AckTo {
    pub conn: ConnTx,
    pub req: u32,
    pub nonce: u64,
    pub t_server_recv: i64,
}

pub enum PersistOp {
    /// `attachments` is the JSON array stored with the row. `ack = None` for
    /// server-authored messages (no one to acknowledge).
    Insert { channel_id: Id, id: Id, author_id: Id, content: String, reply_to: Option<Id>, attachments: Option<String>, t_enqueue: i64, ack: Option<AckTo> },
    /// Add/remove a reaction. `reply` gets whether anything changed
    /// (Err = message missing or reaction limit reached).
    React { channel_id: Id, message_id: Id, user_id: Id, emoji: String, add: bool, reply: oneshot::Sender<Result<bool, &'static str>> },
    /// `reply` gets whether a row owned by `author_id` was changed.
    Edit { channel_id: Id, id: Id, author_id: Id, content: String, edited_at: i64, reply: oneshot::Sender<bool> },
    /// `author_id = None` deletes regardless of author (server owner moderation).
    Delete { channel_id: Id, id: Id, author_id: Option<Id>, reply: oneshot::Sender<bool> },
    /// Delete every message (and per-message data) of these channels. Runs in
    /// queue order, after any inserts already enqueued for them.
    PurgeChannels(Vec<Id>),
    /// Resolves once every op queued before it is durable.
    Flush(oneshot::Sender<()>),
}

pub async fn run(st: Arc<State>, mut rx: mpsc::Receiver<PersistOp>) {
    let mut batch: Vec<PersistOp> = Vec::with_capacity(MAX_BATCH);
    loop {
        if rx.recv_many(&mut batch, MAX_BATCH).await == 0 {
            return;
        }
        let mut delay = Duration::from_millis(50);
        let mut attempt = 0;
        loop {
            match write_batch(&st, &batch).await {
                Ok(results) => {
                    finish(&st, batch.drain(..), Some(results));
                    break;
                }
                Err(e) => {
                    attempt += 1;
                    tracing::error!(attempt, "persist batch failed: {e:#}");
                    if attempt >= 6 {
                        st.metrics.persist_failures.fetch_add(1, Ordering::Relaxed);
                        finish(&st, batch.drain(..), None);
                        break;
                    }
                    tokio::time::sleep(delay).await;
                    delay *= 2;
                }
            }
        }
    }
}

/// Per-op success for edits/deletes (inserts are all-or-nothing).
/// Per-op outcome. `Err` is a rejected op (not a database failure).
type Outcome = Result<bool, &'static str>;

async fn write_batch(st: &State, batch: &[PersistOp]) -> anyhow::Result<Vec<Outcome>> {
    let (mut ch, mut ids, mut au, mut ct, mut rt, mut at) = (vec![], vec![], vec![], vec![], vec![], vec![]);
    for op in batch {
        if let PersistOp::Insert { channel_id, id, author_id, content, reply_to, attachments, .. } = op {
            ch.push(*channel_id);
            ids.push(*id);
            au.push(*author_id);
            ct.push(content.as_str());
            rt.push(*reply_to);
            at.push(attachments.as_deref());
        }
    }
    let mut tx = st.db.begin().await?;
    if !ids.is_empty() {
        sqlx::query(
            "INSERT INTO messages (channel_id, id, author_id, content, reply_to, attachments) \
             SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[], $4::text[], $5::bigint[], $6::text[]) \
             ON CONFLICT DO NOTHING",
        )
        .bind(&ch)
        .bind(&ids)
        .bind(&au)
        .bind(&ct)
        .bind(&rt)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    }
    if !ids.is_empty() {
        // Your own message marks the channel read for you (same transaction,
        // no extra round trip). Newest id per (author, channel) in the batch.
        let mut newest: std::collections::HashMap<(Id, Id), Id> = std::collections::HashMap::new();
        for i in (0..ids.len()).filter(|i| au[*i] != hopon_shared::SYSTEM_USER) {
            let e = newest.entry((au[i], ch[i])).or_insert(ids[i]);
            *e = (*e).max(ids[i]);
        }
        let (ru, rc, rm): (Vec<Id>, Vec<Id>, Vec<Id>) = newest.into_iter().fold((vec![], vec![], vec![]), |mut a, ((u, c), m)| {
            a.0.push(u);
            a.1.push(c);
            a.2.push(m);
            a
        });
        sqlx::query(
            "INSERT INTO channel_reads (user_id, channel_id, last_read) SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[]) \
             ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read = GREATEST(channel_reads.last_read, EXCLUDED.last_read)",
        )
        .bind(&ru)
        .bind(&rc)
        .bind(&rm)
        .execute(&mut *tx)
        .await?;
    }
    let mut results = Vec::with_capacity(batch.len());
    for op in batch {
        let ok: Outcome = match op {
            PersistOp::React { channel_id, message_id, user_id, emoji, add, .. } => {
                let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM messages WHERE channel_id = $1 AND id = $2")
                    .bind(channel_id)
                    .bind(message_id)
                    .fetch_optional(&mut *tx)
                    .await?;
                if exists.is_none() {
                    Err("no such message")
                } else if *add {
                    let (distinct, have): (i64, bool) = sqlx::query_as(
                        "SELECT count(DISTINCT emoji), bool_or(emoji = $3) IS TRUE FROM reactions WHERE channel_id = $1 AND message_id = $2",
                    )
                    .bind(channel_id)
                    .bind(message_id)
                    .bind(emoji)
                    .fetch_one(&mut *tx)
                    .await?;
                    if !have && distinct as usize >= hopon_shared::MAX_REACTIONS_PER_MESSAGE {
                        Err("too many different reactions on this message")
                    } else {
                        Ok(sqlx::query("INSERT INTO reactions (channel_id, message_id, emoji, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
                            .bind(channel_id)
                            .bind(message_id)
                            .bind(emoji)
                            .bind(user_id)
                            .execute(&mut *tx)
                            .await?
                            .rows_affected()
                            == 1)
                    }
                } else {
                    Ok(sqlx::query("DELETE FROM reactions WHERE channel_id = $1 AND message_id = $2 AND emoji = $3 AND user_id = $4")
                        .bind(channel_id)
                        .bind(message_id)
                        .bind(emoji)
                        .bind(user_id)
                        .execute(&mut *tx)
                        .await?
                        .rows_affected()
                        == 1)
                }
            }
            PersistOp::Edit { channel_id, id, author_id, content, edited_at, .. } => {
                Ok(sqlx::query(
                    "UPDATE messages SET content = $4, edited_at = $5 \
                     WHERE channel_id = $1 AND id = $2 AND author_id = $3",
                )
                .bind(channel_id)
                .bind(id)
                .bind(author_id)
                .bind(content)
                .bind(edited_at)
                .execute(&mut *tx)
                .await?
                .rows_affected()
                    == 1)
            }
            PersistOp::Delete { channel_id, id, author_id, .. } => {
                let gone = sqlx::query("DELETE FROM messages WHERE channel_id = $1 AND id = $2 AND ($3::bigint IS NULL OR author_id = $3)")
                    .bind(channel_id)
                    .bind(id)
                    .bind(author_id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
                    == 1;
                if gone {
                    sqlx::query("DELETE FROM reactions WHERE channel_id = $1 AND message_id = $2").bind(channel_id).bind(id).execute(&mut *tx).await?;
                }
                Ok(gone)
            }
            PersistOp::PurgeChannels(ids) => {
                sqlx::query("DELETE FROM messages WHERE channel_id = ANY($1)").bind(ids).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM reactions WHERE channel_id = ANY($1)").bind(ids).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM channel_reads WHERE channel_id = ANY($1)").bind(ids).execute(&mut *tx).await?;
                Ok(true)
            }
            _ => Ok(true),
        };
        results.push(ok);
    }
    tx.commit().await?;
    st.metrics.batch_rows.lock().record_us(batch.len() as i64 * 1000);
    Ok(results)
}

fn finish(st: &State, ops: impl Iterator<Item = PersistOp>, results: Option<Vec<Outcome>>) {
    let t = now_us();
    let mut hist = st.metrics.persist.lock();
    for (i, op) in ops.enumerate() {
        let ok = results.as_ref().map(|r| r[i]);
        match op {
            PersistOp::Insert { channel_id, id, t_enqueue, ack, .. } => {
                hist.record_us(t - t_enqueue);
                let msg = match ok {
                    Some(_) => S2C::Ack { channel_id, nonce: 0, id, t_server_recv: 0, t_persisted: t },
                    None => S2C::Error { code: ErrorCode::Internal, message: "message could not be saved".into() },
                };
                if let Some(ack) = ack {
                    let msg = match msg {
                        S2C::Ack { channel_id, id, t_persisted, .. } => S2C::Ack { channel_id, nonce: ack.nonce, id, t_server_recv: ack.t_server_recv, t_persisted },
                        m => m,
                    };
                    let _ = ack.conn.try_send(Out::Frame(Bytes::from(encode(&ServerFrame { req: ack.req, msg }))));
                }
            }
            PersistOp::Edit { reply, .. } | PersistOp::Delete { reply, .. } => {
                let _ = reply.send(matches!(ok, Some(Ok(true))));
            }
            PersistOp::React { reply, .. } => {
                let _ = reply.send(ok.unwrap_or(Err("could not be saved")));
            }
            PersistOp::PurgeChannels(_) => {}
            PersistOp::Flush(done) => {
                let _ = done.send(());
            }
        }
    }
}
