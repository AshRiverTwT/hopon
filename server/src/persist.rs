//! Asynchronous, batched persistence. Messages are fanned out before they are
//! written; this single ordered queue writes them in batches (one `UNNEST`
//! insert per transaction) and acks the author once committed.
//!
//! Ordering: within a batch all inserts run first, then edits/deletes in
//! arrival order. An edit can only target a message that was enqueued before
//! it, so that order is always valid.

use crate::state::{ConnTx, Out, State};
use bytes::Bytes;
use hopon_shared::{encode, time::now_us, DurableEvent, DurablePayload, ErrorCode, Id, ServerFrame, S2C};
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
    Insert { channel_id: Id, id: Id, author_id: Id, client_nonce: Option<i64>, content: String, reply_to: Option<Id>, attachments: Option<String>, durable_event: Option<hopon_shared::Message>, t_enqueue: i64, ack: Option<AckTo> },
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

#[derive(Clone, Copy)]
struct WriteResult {
    outcome: Outcome,
    cursor: Option<Id>,
    inserted: bool,
    message_id: Option<Id>,
}

impl Default for WriteResult {
    fn default() -> Self {
        Self { outcome: Ok(true), cursor: None, inserted: false, message_id: None }
    }
}

async fn write_batch(st: &State, batch: &[PersistOp]) -> anyhow::Result<Vec<WriteResult>> {
    let mut results = vec![WriteResult::default(); batch.len()];
    let (mut channels, mut ids, mut authors, mut contents, mut replies, mut attachment_values, mut nonces) =
        (vec![], vec![], vec![], vec![], vec![], vec![], vec![]);
    let mut insert_indexes = Vec::new();
    for (index, op) in batch.iter().enumerate() {
        if let PersistOp::Insert { channel_id, id, author_id, client_nonce, content, reply_to, attachments, .. } = op {
            insert_indexes.push(index);
            channels.push(*channel_id);
            ids.push(*id);
            authors.push(*author_id);
            contents.push(content.as_str());
            replies.push(*reply_to);
            attachment_values.push(attachments.as_deref());
            nonces.push(*client_nonce);
        }
    }

    let mut tx = st.db.begin().await?;
    let mut inserted_ids = std::collections::HashSet::new();
    if !ids.is_empty() {
        let inserted: Vec<(Id, Id)> = sqlx::query_as(
            "INSERT INTO messages (channel_id, id, author_id, content, reply_to, attachments, client_nonce) \
             SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[], $4::text[], $5::bigint[], $6::text[], $7::bigint[]) \
             ON CONFLICT DO NOTHING RETURNING channel_id, id",
        )
        .bind(&channels).bind(&ids).bind(&authors).bind(&contents).bind(&replies).bind(&attachment_values).bind(&nonces)
        .fetch_all(&mut *tx).await?;
        inserted_ids.extend(inserted);

        // A single batch can contain several messages from the same author in
        // the same channel.  Collapse those rows before the upsert: Postgres
        // rejects an ON CONFLICT statement that tries to update one target row
        // more than once in the same command.
        let mut newest_reads: std::collections::HashMap<(Id, Id), Id> =
            std::collections::HashMap::new();
        for index in insert_indexes.iter().copied() {
            let PersistOp::Insert { channel_id, id, author_id, client_nonce, attachments, durable_event, .. } = &batch[index] else { unreachable!() };
            let inserted = inserted_ids.remove(&(*channel_id, *id));
            let actual_id = if inserted {
                Some(*id)
            } else if let Some(nonce) = client_nonce {
                sqlx::query_scalar::<_, Id>("SELECT id FROM messages WHERE author_id = $1 AND client_nonce = $2")
                    .bind(author_id).bind(nonce).fetch_optional(&mut *tx).await?
            } else {
                None
            };
            results[index].inserted = inserted;
            results[index].message_id = actual_id;
            results[index].outcome = if actual_id.is_some() { Ok(true) } else { Err("message could not be saved") };
            if !inserted { continue; }

            if *author_id != hopon_shared::SYSTEM_USER {
                newest_reads
                    .entry((*author_id, *channel_id))
                    .and_modify(|last| *last = (*last).max(*id))
                    .or_insert(*id);
            }

            // The claim and the message row must become durable together.  A
            // separate async link can leave files stuck in the reserved state
            // if the process exits between those two writes.
            if let Some(raw) = attachments {
                let file_ids: Vec<String> = serde_json::from_str::<Vec<hopon_shared::Attachment>>(raw)?
                    .into_iter()
                    .map(|file| file.id)
                    .collect();
                if !file_ids.is_empty() {
                    sqlx::query(
                        "UPDATE files SET channel_id = $1, message_id = $2 WHERE id = ANY($3)",
                    )
                    .bind(channel_id)
                    .bind(id)
                    .bind(&file_ids)
                    .execute(&mut *tx)
                    .await?;
                }
            }
            if let Some(message) = durable_event {
                let payload = serde_json::to_string(&DurablePayload::Message(message.clone()))?;
                let cursor: Id = sqlx::query_scalar("INSERT INTO durable_events (channel_id, payload) VALUES ($1, $2::jsonb) RETURNING cursor")
                    .bind(channel_id).bind(payload).fetch_one(&mut *tx).await?;
                results[index].cursor = Some(cursor);
            }
        }
        if !newest_reads.is_empty() {
            let (read_users, read_channels, read_messages) = newest_reads.into_iter().fold(
                (Vec::new(), Vec::new(), Vec::new()),
                |mut rows, ((user, channel), message)| {
                    rows.0.push(user);
                    rows.1.push(channel);
                    rows.2.push(message);
                    rows
                },
            );
            sqlx::query(
                "INSERT INTO channel_reads (user_id, channel_id, last_read) SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[]) \
                 ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read = GREATEST(channel_reads.last_read, EXCLUDED.last_read)",
            )
            .bind(&read_users).bind(&read_channels).bind(&read_messages).execute(&mut *tx).await?;
        }
    }

    for (index, op) in batch.iter().enumerate() {
        let payload = match op {
            PersistOp::React { channel_id, message_id, user_id, emoji, add, .. } => {
                let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM messages WHERE channel_id = $1 AND id = $2")
                    .bind(channel_id).bind(message_id).fetch_optional(&mut *tx).await?;
                if exists.is_none() {
                    results[index].outcome = Err("no such message");
                    None
                } else if *add {
                    let (distinct, have): (i64, bool) = sqlx::query_as(
                        "SELECT count(DISTINCT emoji), bool_or(emoji = $3) IS TRUE FROM reactions WHERE channel_id = $1 AND message_id = $2",
                    ).bind(channel_id).bind(message_id).bind(emoji).fetch_one(&mut *tx).await?;
                    if !have && distinct as usize >= hopon_shared::MAX_REACTIONS_PER_MESSAGE {
                        results[index].outcome = Err("too many different reactions on this message");
                        None
                    } else {
                        let changed = sqlx::query("INSERT INTO reactions (channel_id, message_id, emoji, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
                            .bind(channel_id).bind(message_id).bind(emoji).bind(user_id).execute(&mut *tx).await?.rows_affected() == 1;
                        results[index].outcome = Ok(changed);
                        changed.then(|| DurablePayload::Reaction { channel_id: *channel_id, message_id: *message_id, emoji: emoji.clone(), user_id: *user_id, add: true })
                    }
                } else {
                    let changed = sqlx::query("DELETE FROM reactions WHERE channel_id = $1 AND message_id = $2 AND emoji = $3 AND user_id = $4")
                        .bind(channel_id).bind(message_id).bind(emoji).bind(user_id).execute(&mut *tx).await?.rows_affected() == 1;
                    results[index].outcome = Ok(changed);
                    changed.then(|| DurablePayload::Reaction { channel_id: *channel_id, message_id: *message_id, emoji: emoji.clone(), user_id: *user_id, add: false })
                }
            }
            PersistOp::Edit { channel_id, id, author_id, content, edited_at, .. } => {
                let changed = sqlx::query("UPDATE messages SET content = $4, edited_at = $5 WHERE channel_id = $1 AND id = $2 AND author_id = $3")
                    .bind(channel_id).bind(id).bind(author_id).bind(content).bind(edited_at).execute(&mut *tx).await?.rows_affected() == 1;
                results[index].outcome = Ok(changed);
                changed.then(|| DurablePayload::Edited { channel_id: *channel_id, id: *id, content: content.clone(), edited_at: *edited_at })
            }
            PersistOp::Delete { channel_id, id, author_id, .. } => {
                let gone = sqlx::query("DELETE FROM messages WHERE channel_id = $1 AND id = $2 AND ($3::bigint IS NULL OR author_id = $3)")
                    .bind(channel_id).bind(id).bind(author_id).execute(&mut *tx).await?.rows_affected() == 1;
                if gone {
                    sqlx::query("DELETE FROM reactions WHERE channel_id = $1 AND message_id = $2").bind(channel_id).bind(id).execute(&mut *tx).await?;
                }
                results[index].outcome = Ok(gone);
                gone.then(|| DurablePayload::Deleted { channel_id: *channel_id, id: *id })
            }
            PersistOp::PurgeChannels(ids) => {
                sqlx::query("DELETE FROM messages WHERE channel_id = ANY($1)").bind(ids).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM reactions WHERE channel_id = ANY($1)").bind(ids).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM channel_reads WHERE channel_id = ANY($1)").bind(ids).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM durable_events WHERE channel_id = ANY($1)").bind(ids).execute(&mut *tx).await?;
                None
            }
            PersistOp::Insert { .. } | PersistOp::Flush(_) => None,
        };
        if let Some(payload) = payload {
            let channel_id = match op {
                PersistOp::React { channel_id, .. } | PersistOp::Edit { channel_id, .. } | PersistOp::Delete { channel_id, .. } => *channel_id,
                _ => unreachable!(),
            };
            let json = serde_json::to_string(&payload)?;
            let cursor: Id = sqlx::query_scalar("INSERT INTO durable_events (channel_id, payload) VALUES ($1, $2::jsonb) RETURNING cursor")
                .bind(channel_id).bind(json).fetch_one(&mut *tx).await?;
            results[index].cursor = Some(cursor);
        }
    }
    tx.commit().await?;
    st.metrics.batch_rows.lock().record_us(batch.len() as i64 * 1000);
    Ok(results)
}
fn publish_event(st: &State, channel_id: Id, cursor: Id, payload: DurablePayload) {
    if let Some(chan) = st.chans.get(&channel_id) {
        if let Some(guild) = st.guilds.get(&chan.server_id) {
            guild.publish(Bytes::from(encode(&ServerFrame {
                req: 0,
                msg: S2C::ChannelEvent(DurableEvent { cursor, payload }),
            })));
        }
    }
}

fn finish(st: &State, ops: impl Iterator<Item = PersistOp>, results: Option<Vec<WriteResult>>) {
    let t = now_us();
    let mut hist = st.metrics.persist.lock();
    for (i, op) in ops.enumerate() {
        let write = results.as_ref().and_then(|r| r.get(i)).copied();
        let ok = write.map(|r| r.outcome);
        match op {
            PersistOp::Insert { channel_id, id, t_enqueue, ack, durable_event, .. } => {
                hist.record_us(t - t_enqueue);
                let actual_id = write.and_then(|r| r.message_id).unwrap_or(id);
                let msg = match ok {
                    Some(Ok(true)) => S2C::Ack { channel_id, nonce: 0, id: actual_id, t_server_recv: 0, t_persisted: t },
                    None => S2C::Error { code: ErrorCode::Internal, message: "message could not be saved".into() },
                    _ => S2C::Error { code: ErrorCode::Internal, message: "message could not be saved".into() },
                };
                if matches!(ok, Some(Ok(true))) {
                    if write.map(|r| r.inserted).unwrap_or(false) {
                        if let Some(chan) = st.chans.get(&channel_id) {
                            chan.last_id.fetch_max(actual_id, Ordering::Relaxed);
                        }
                    }
                    if let Some(message) = durable_event {
                        let mut message = message;
                        message.id = actual_id;
                        if let Some(cursor) = write.and_then(|r| r.cursor) {
                            publish_event(st, channel_id, cursor, DurablePayload::Message(message.clone()));
                        } else if !write.map(|r| r.inserted).unwrap_or(false) {
                            // A concurrent retry may have won the unique nonce race.
                            if let Some(ack) = ack.as_ref() {
                                let _ = ack.conn.try_send(Out::Frame(Bytes::from(encode(&ServerFrame {
                                    req: 0,
                                    msg: S2C::Message(message.clone()),
                                }))));
                            }
                        }
                        if let Some(ack) = ack.as_ref().filter(|ack| ack.nonce != 0) {
                            st.nonces.insert((message.author_id, ack.nonce), (message, t));
                        }
                    }
                }
                if let Some(ack) = ack {
                    let msg = match msg {
                        S2C::Ack { channel_id, id, t_persisted, .. } => S2C::Ack { channel_id, nonce: ack.nonce, id, t_server_recv: ack.t_server_recv, t_persisted },
                        m => m,
                    };
                    let _ = ack.conn.try_send(Out::Frame(Bytes::from(encode(&ServerFrame { req: ack.req, msg }))));
                }
            }
            PersistOp::Edit { channel_id, id, content, edited_at, reply, .. } => {
                if matches!(ok, Some(Ok(true))) {
                    if let Some(cursor) = write.and_then(|r| r.cursor) {
                        publish_event(st, channel_id, cursor, DurablePayload::Edited { channel_id, id, content, edited_at });
                    }
                }
                let _ = reply.send(matches!(ok, Some(Ok(true))));
            }
            PersistOp::Delete { channel_id, id, reply, .. } => {
                if matches!(ok, Some(Ok(true))) {
                    if let Some(cursor) = write.and_then(|r| r.cursor) {
                        publish_event(st, channel_id, cursor, DurablePayload::Deleted { channel_id, id });
                    }
                }
                let _ = reply.send(matches!(ok, Some(Ok(true))));
            }
            PersistOp::React { channel_id, message_id, user_id, emoji, add, reply } => {
                if matches!(ok, Some(Ok(true))) {
                    if let Some(cursor) = write.and_then(|r| r.cursor) {
                        publish_event(st, channel_id, cursor, DurablePayload::Reaction { channel_id, message_id, emoji, user_id, add });
                    }
                }
                let _ = reply.send(ok.unwrap_or(Err("could not be saved")));
            }
            PersistOp::PurgeChannels(_) => {}
            PersistOp::Flush(done) => {
                let _ = done.send(());
            }
        }
    }
}
