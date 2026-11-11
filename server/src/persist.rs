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
    Insert { channel_id: Id, id: Id, author_id: Id, content: String, t_enqueue: i64, ack: AckTo },
    /// `reply` gets whether a row owned by `author_id` was changed.
    Edit { channel_id: Id, id: Id, author_id: Id, content: String, edited_at: i64, reply: oneshot::Sender<bool> },
    Delete { channel_id: Id, id: Id, author_id: Id, reply: oneshot::Sender<bool> },
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
async fn write_batch(st: &State, batch: &[PersistOp]) -> anyhow::Result<Vec<bool>> {
    let (mut ch, mut ids, mut au, mut ct) = (vec![], vec![], vec![], vec![]);
    for op in batch {
        if let PersistOp::Insert { channel_id, id, author_id, content, .. } = op {
            ch.push(*channel_id);
            ids.push(*id);
            au.push(*author_id);
            ct.push(content.as_str());
        }
    }
    let mut tx = st.db.begin().await?;
    if !ids.is_empty() {
        sqlx::query(
            "INSERT INTO messages (channel_id, id, author_id, content) \
             SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[], $4::text[]) \
             ON CONFLICT DO NOTHING",
        )
        .bind(&ch)
        .bind(&ids)
        .bind(&au)
        .bind(&ct)
        .execute(&mut *tx)
        .await?;
    }
    let mut results = Vec::with_capacity(batch.len());
    for op in batch {
        let ok = match op {
            PersistOp::Edit { channel_id, id, author_id, content, edited_at, .. } => {
                sqlx::query(
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
                    == 1
            }
            PersistOp::Delete { channel_id, id, author_id, .. } => {
                sqlx::query("DELETE FROM messages WHERE channel_id = $1 AND id = $2 AND author_id = $3")
                    .bind(channel_id)
                    .bind(id)
                    .bind(author_id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
                    == 1
            }
            _ => true,
        };
        results.push(ok);
    }
    tx.commit().await?;
    st.metrics.batch_rows.lock().record_us(batch.len() as i64 * 1000);
    Ok(results)
}

fn finish(st: &State, ops: impl Iterator<Item = PersistOp>, results: Option<Vec<bool>>) {
    let t = now_us();
    let mut hist = st.metrics.persist.lock();
    for (i, op) in ops.enumerate() {
        let ok = results.as_ref().map(|r| r[i]);
        match op {
            PersistOp::Insert { channel_id, id, t_enqueue, ack, .. } => {
                hist.record_us(t - t_enqueue);
                let msg = match ok {
                    Some(_) => S2C::Ack { channel_id, nonce: ack.nonce, id, t_server_recv: ack.t_server_recv, t_persisted: t },
                    None => S2C::Error { code: ErrorCode::Internal, message: "message could not be saved".into() },
                };
                let _ = ack.conn.try_send(Out::Frame(Bytes::from(encode(&ServerFrame { req: ack.req, msg }))));
            }
            PersistOp::Edit { reply, .. } | PersistOp::Delete { reply, .. } => {
                let _ = reply.send(ok.unwrap_or(false));
            }
            PersistOp::Flush(done) => {
                let _ = done.send(());
            }
        }
    }
}
