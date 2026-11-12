//! Types pushed to the webview. IDs are 63-bit, beyond JS's 2^53 safe range,
//! so they cross the IPC boundary as decimal strings.

use hopon_shared::{Attachment, ChannelInfo, ChannelKind, Id, Message, ServerInfo, UserInfo, VoicePresence};
use serde::Serialize;

pub fn sid(id: Id) -> String {
    id.to_string()
}
pub fn pid(s: &str) -> Result<Id, String> {
    s.parse().map_err(|_| format!("bad id {s}"))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiUser {
    pub id: String,
    pub name: String,
    /// 0 = no avatar; otherwise fetch with `avatar(id, v)`.
    pub avatar_v: u32,
}
impl From<&UserInfo> for UiUser {
    fn from(u: &UserInfo) -> Self {
        Self { id: sid(u.id), name: u.name.clone(), avatar_v: u.avatar_v }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiChannel {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub voice: bool,
    pub topic: String,
    pub last_id: String,
}
impl From<&ChannelInfo> for UiChannel {
    fn from(c: &ChannelInfo) -> Self {
        Self { id: sid(c.id), server_id: sid(c.server_id), name: c.name.clone(), voice: c.kind == ChannelKind::Voice, topic: c.topic.clone(), last_id: sid(c.last_id) }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiServer {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub channels: Vec<UiChannel>,
    pub members: Vec<UiUser>,
    /// channel id → last read message id.
    pub reads: std::collections::HashMap<String, String>,
    pub online: Vec<String>,
    /// user → game they're playing.
    pub activities: std::collections::HashMap<String, String>,
}
impl From<&ServerInfo> for UiServer {
    fn from(s: &ServerInfo) -> Self {
        Self {
            id: sid(s.id),
            name: s.name.clone(),
            owner_id: sid(s.owner_id),
            channels: s.channels.iter().map(Into::into).collect(),
            members: s.members.iter().map(Into::into).collect(),
            reads: s.reads.iter().map(|(c, r)| (sid(*c), sid(*r))).collect(),
            online: s.online.iter().map(|u| sid(*u)).collect(),
            activities: s.activities.iter().map(|(u, g)| (sid(*u), g.clone())).collect(),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiMsg {
    /// Server ID, or `p<nonce>` while pending.
    pub id: String,
    pub channel_id: String,
    pub author_id: String,
    pub content: String,
    pub edited_at: Option<i64>,
    /// Unix ms (from the ID, or local time while pending).
    pub ts: u64,
    pub nonce: String,
    /// 0 = pending (local echo), 1 = delivered (fanned out), 2 = durable, 3 = failed.
    pub state: u8,
    pub reply_to: Option<String>,
    pub reactions: Vec<UiReaction>,
    /// `url` empty = served by the chat server at /files/{id} (the UI
    /// resolves it against the server address).
    pub attachments: Vec<Attachment>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiReaction {
    pub emoji: String,
    pub users: Vec<String>,
}

impl UiMsg {
    pub fn from_msg(m: &Message, state: u8) -> Self {
        Self {
            id: sid(m.id),
            channel_id: sid(m.channel_id),
            author_id: sid(m.author_id),
            content: m.content.clone(),
            edited_at: m.edited_at,
            ts: hopon_shared::ids::id_unix_ms(m.id),
            nonce: if m.nonce == 0 { String::new() } else { m.nonce.to_string() },
            state,
            reply_to: m.reply_to.map(sid),
            reactions: m.reactions.iter().map(|r| UiReaction { emoji: r.emoji.clone(), users: r.users.iter().map(|u| sid(*u)).collect() }).collect(),
            attachments: m.attachments.clone(),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiPresence {
    pub user_id: String,
    pub channel_id: Option<String>,
    pub muted: bool,
    pub deafened: bool,
}
impl From<&VoicePresence> for UiPresence {
    fn from(v: &VoicePresence) -> Self {
        Self { user_id: sid(v.user_id), channel_id: Some(sid(v.channel_id)), muted: v.muted, deafened: v.deafened }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UiEvent {
    /// `state`: "connecting" | "online" | "offline" | "incompatible".
    Conn { state: &'static str, rtt_ms: Option<f64> },
    /// Full session snapshot (also sent with `user: None` when logged out).
    Session { user: Option<UiUser>, servers: Vec<UiServer>, voice: Vec<UiPresence> },
    Server { server: UiServer },
    ChannelCreated { channel: UiChannel },
    MemberJoined { server_id: String, user: UiUser },
    UserUpdated { user: UiUser },
    /// "deleted" | "kicked" | "left".
    ServerRemoved { server_id: String, reason: &'static str },
    ChannelDeleted { server_id: String, channel_id: String },
    ReadUpdated { channel_id: String, last_read: String },
    Reaction { channel_id: String, message_id: String, emoji: String, user_id: String, add: bool },
    Typing { channel_id: String, user_id: String },
    /// Account preferences (JSON object), on login and when another device saves.
    Prefs { json: String },
    /// A message in this channel mentions you.
    Mentioned { channel_id: String },
    UserPresence { user_id: String, online: bool },
    /// A member started/stopped playing ("" = stopped).
    Activity { user_id: String, game: String },
    /// New or updated messages (merge by `id`, replacing pending by `nonce`).
    Messages { channel_id: String, msgs: Vec<UiMsg> },
    MsgState { channel_id: String, nonce: String, id: String, state: u8 },
    Edited { channel_id: String, id: String, content: String, edited_at: i64 },
    Deleted { channel_id: String, id: String },
    Presence { server_id: String, presence: UiPresence },
    /// Voice connection status for the local user.
    Voice { channel_id: Option<String>, state: &'static str, muted: bool, deafened: bool, detail: Option<String> },
    /// Users currently speaking in the joined voice channel.
    Speaking { user_ids: Vec<String> },
    /// A notification was clicked: show this channel.
    OpenChannel { channel_id: String },
    #[allow(dead_code)]
    Error { message: String },
}
