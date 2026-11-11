//! Server administration: rename, channel edits, deletes, kick, leave.
//! Every action is authorised here against the database's `owner_id`.
//!
//! Teardown order matters:
//! * Channel delete: DB row first (so it can't be reloaded), then mark the
//!   in-memory `Chan` deleted under its order lock (no more fan-out), then
//!   purge messages through the ordered persist queue (after any inserts
//!   already queued), then notify members and end the voice room.
//! * Kick / leave / server delete: drop membership, clear voice presence and
//!   the SFU participant, then make every affected connection unsubscribe.

use crate::livekit;
use crate::persist::PersistOp;
use crate::state::{kind_to_i16, Out, State};
use crate::voice;
use bytes::Bytes;
use hopon_shared::*;
use std::sync::atomic::Ordering;
use std::sync::Arc;

pub type R = Result<S2C, (ErrorCode, String)>;

fn frame(msg: S2C) -> Bytes {
    Bytes::from(encode(&ServerFrame { req: 0, msg }))
}

fn internal<E: std::fmt::Display>(e: E) -> (ErrorCode, String) {
    tracing::error!("internal: {e}");
    (ErrorCode::Internal, "internal error".into())
}

fn forbidden(what: &str) -> (ErrorCode, String) {
    (ErrorCode::Forbidden, format!("only the server owner can {what}"))
}

fn clean_name(n: &str, what: &str) -> Result<String, (ErrorCode, String)> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > MAX_NAME_CHARS {
        return Err((ErrorCode::BadRequest, format!("{what} must be 1-{MAX_NAME_CHARS} characters")));
    }
    Ok(n.to_owned())
}

async fn require_owner(st: &State, server_id: Id, uid: Id, what: &str) -> Result<(), (ErrorCode, String)> {
    match st.owner_of(server_id).await {
        Some(o) if o == uid => Ok(()),
        Some(_) => Err(forbidden(what)),
        None => Err((ErrorCode::NotFound, "no such server".into())),
    }
}

/// Remove `user` from `server`: membership, voice (chat presence + SFU), and
/// every connection's subscription. Tells the user why, and the rest who left.
async fn remove_member(st: &Arc<State>, server_id: Id, user: Id, reason: RemovedReason) -> Result<(), (ErrorCode, String)> {
    sqlx::query("DELETE FROM members WHERE server_id = $1 AND user_id = $2")
        .bind(server_id)
        .bind(user)
        .execute(&st.db)
        .await
        .map_err(internal)?;
    let guild = st.guild(server_id).await.map_err(internal)?;
    guild.members.write().remove(&user);
    if let Some(ch) = st.clear_voice(user, server_id, None, Some(&guild)) {
        livekit::remove_participant(st.clone(), voice::room_name(ch), user.to_string());
    }
    let notice = frame(S2C::ServerRemoved { server_id, reason });
    st.to_user(user, || Out::Frame(notice.clone()));
    st.to_user(user, || Out::Unsubscribe(server_id));
    guild.publish(frame(S2C::MemberLeft { server_id, user_id: user, reason }));
    Ok(())
}

pub async fn handle(st: &Arc<State>, uid: Id, msg: C2S) -> R {
    match msg {
        C2S::RenameServer { server_id, name } => {
            require_owner(st, server_id, uid, "rename the server").await?;
            let name = clean_name(&name, "server name")?;
            sqlx::query("UPDATE servers SET name = $2 WHERE id = $1").bind(server_id).bind(&name).execute(&st.db).await.map_err(internal)?;
            st.guild(server_id).await.map_err(internal)?.publish(frame(S2C::ServerUpdated { server_id, name }));
            Ok(S2C::Ok)
        }
        C2S::UpdateChannel { channel_id, name, topic } => {
            let row: Option<(i64, String, i16, String)> = sqlx::query_as("SELECT server_id, name, kind, topic FROM channels WHERE id = $1")
                .bind(channel_id)
                .fetch_optional(&st.db)
                .await
                .map_err(internal)?;
            let (server_id, old_name, kind, old_topic) = row.ok_or((ErrorCode::NotFound, "no such channel".into()))?;
            require_owner(st, server_id, uid, "edit channels").await?;
            let name = match name {
                Some(n) => clean_name(&n, "channel name")?,
                None => old_name,
            };
            let topic = match topic {
                Some(t) => {
                    let t = t.trim().to_owned();
                    if t.chars().count() > MAX_TOPIC_CHARS {
                        return Err((ErrorCode::BadRequest, format!("topic must be at most {MAX_TOPIC_CHARS} characters")));
                    }
                    t
                }
                None => old_topic,
            };
            sqlx::query("UPDATE channels SET name = $2, topic = $3 WHERE id = $1")
                .bind(channel_id)
                .bind(&name)
                .bind(&topic)
                .execute(&st.db)
                .await
                .map_err(internal)?;
            let info = ChannelInfo { id: channel_id, server_id, name, kind: crate::state::kind_from_i16(kind), topic };
            st.guild(server_id).await.map_err(internal)?.publish(frame(S2C::ChannelUpdated(info)));
            Ok(S2C::Ok)
        }
        C2S::DeleteChannel { channel_id } => {
            let row: Option<(i64, i16)> = sqlx::query_as("SELECT server_id, kind FROM channels WHERE id = $1")
                .bind(channel_id)
                .fetch_optional(&st.db)
                .await
                .map_err(internal)?;
            let (server_id, kind) = row.ok_or((ErrorCode::NotFound, "no such channel".into()))?;
            require_owner(st, server_id, uid, "delete channels").await?;
            sqlx::query("DELETE FROM channels WHERE id = $1").bind(channel_id).execute(&st.db).await.map_err(internal)?;
            if let Some((_, chan)) = st.chans.remove(&channel_id) {
                let _order = chan.order.lock();
                chan.deleted.store(true, Ordering::Relaxed);
            }
            st.persist.send(PersistOp::PurgeChannels(vec![channel_id])).await.map_err(internal)?;
            let guild = st.guild(server_id).await.map_err(internal)?;
            if kind == kind_to_i16(ChannelKind::Voice) {
                let in_room: Vec<Id> = st.voice.lock().iter().filter(|(_, e)| e.channel_id == channel_id).map(|(u, _)| *u).collect();
                for u in in_room {
                    st.clear_voice(u, server_id, Some(channel_id), Some(&guild));
                }
                livekit::delete_room(st.clone(), voice::room_name(channel_id));
            }
            guild.publish(frame(S2C::ChannelDeleted { server_id, channel_id }));
            Ok(S2C::Ok)
        }
        C2S::DeleteServer { server_id } => {
            require_owner(st, server_id, uid, "delete the server").await?;
            let chans: Vec<(i64, i16)> = sqlx::query_as("SELECT id, kind FROM channels WHERE server_id = $1")
                .bind(server_id)
                .fetch_all(&st.db)
                .await
                .map_err(internal)?;
            let members: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM members WHERE server_id = $1")
                .bind(server_id)
                .fetch_all(&st.db)
                .await
                .map_err(internal)?;
            // Cascades to channels, members and invites.
            sqlx::query("DELETE FROM servers WHERE id = $1").bind(server_id).execute(&st.db).await.map_err(internal)?;
            for (cid, _) in &chans {
                if let Some((_, chan)) = st.chans.remove(cid) {
                    let _order = chan.order.lock();
                    chan.deleted.store(true, Ordering::Relaxed);
                }
            }
            st.persist.send(PersistOp::PurgeChannels(chans.iter().map(|c| c.0).collect())).await.map_err(internal)?;
            for (cid, kind) in &chans {
                if *kind == kind_to_i16(ChannelKind::Voice) {
                    livekit::delete_room(st.clone(), voice::room_name(*cid));
                }
            }
            let guild = st.guild(server_id).await.map_err(internal)?;
            for (u,) in &members {
                st.clear_voice(*u, server_id, None, None);
            }
            // Notice and unsubscribe go through each connection's own ordered
            // queue (a broadcast could be dropped by the unsubscribe racing it).
            let _ = guild;
            let notice = frame(S2C::ServerRemoved { server_id, reason: RemovedReason::Deleted });
            for (u,) in &members {
                st.to_user(*u, || Out::Frame(notice.clone()));
                st.to_user(*u, || Out::Unsubscribe(server_id));
            }
            st.guilds.remove(&server_id);
            Ok(S2C::Ok)
        }
        C2S::Kick { server_id, user_id } => {
            require_owner(st, server_id, uid, "remove members").await?;
            if user_id == uid {
                return Err((ErrorCode::BadRequest, "you can't remove yourself; delete the server instead".into()));
            }
            if !st.guild(server_id).await.map_err(internal)?.is_member(user_id) {
                return Err((ErrorCode::NotFound, "not a member".into()));
            }
            remove_member(st, server_id, user_id, RemovedReason::Kicked).await?;
            Ok(S2C::Ok)
        }
        C2S::LeaveServer { server_id } => {
            match st.owner_of(server_id).await {
                Some(o) if o == uid => return Err((ErrorCode::BadRequest, "the owner can't leave; delete the server instead".into())),
                None => return Err((ErrorCode::NotFound, "no such server".into())),
                _ => {}
            }
            if !st.guild(server_id).await.map_err(internal)?.is_member(uid) {
                return Err((ErrorCode::NotFound, "not a member".into()));
            }
            remove_member(st, server_id, uid, RemovedReason::Left).await?;
            Ok(S2C::Ok)
        }
        C2S::RevokeInvites { server_id } => {
            require_owner(st, server_id, uid, "revoke invites").await?;
            sqlx::query("DELETE FROM invites WHERE server_id = $1").bind(server_id).execute(&st.db).await.map_err(internal)?;
            Ok(S2C::Ok)
        }
        _ => Err((ErrorCode::BadRequest, "not an admin request".into())),
    }
}
