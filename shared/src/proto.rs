//! Wire protocol. One WebSocket per client, binary frames, MessagePack
//! (structs encoded as arrays, so field names never hit the wire).
//!
//! Every client frame carries a `req` id; replies echo it. Unsolicited
//! events use `req = 0`.

use serde::{Deserialize, Serialize};

pub type Id = i64;

/// Bumped on every wire-incompatible change. Sent as `?v=` on the WebSocket
/// URL; the server answers HTTP 426 to any other version before any
/// MessagePack is exchanged, so old and new builds fail loudly, not silently.
pub const PROTOCOL_VERSION: u32 = 10;

/// Append the protocol version to a chat URL (`ws://host:port/ws`).
pub fn versioned_url(url: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}v={PROTOCOL_VERSION}")
}

pub const MAX_MESSAGE_CHARS: usize = 4000;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const HISTORY_PAGE_MAX: u16 = 100;
/// Avatars are small square images (the client uploads 128 px WebP).
pub const MAX_AVATAR_BYTES: usize = 48 * 1024;
pub const MAX_PREFS_BYTES: usize = 16 * 1024;
/// Attachments per message.
pub const MAX_ATTACHMENTS: usize = 10;
/// Author id of messages written by the server itself (welcomes).
pub const SYSTEM_USER: Id = 0;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Text,
    Voice,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct UserInfo {
    pub id: Id,
    pub name: String,
    /// Avatar version; 0 = no avatar. Clients fetch with `GetAvatar` and
    /// cache by (id, version).
    pub avatar_v: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ChannelInfo {
    pub id: Id,
    pub server_id: Id,
    pub name: String,
    pub kind: ChannelKind,
    /// Short description shown under the channel title (may be empty).
    pub topic: String,
    /// Newest message id at snapshot time (0 = empty). Clients track it live.
    pub last_id: Id,
}

pub const MAX_NAME_CHARS: usize = 64;
pub const MAX_TOPIC_CHARS: usize = 256;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemovedReason {
    Deleted,
    Kicked,
    Left,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    pub id: Id,
    pub name: String,
    pub owner_id: Id,
    pub channels: Vec<ChannelInfo>,
    pub members: Vec<UserInfo>,
    /// Client-side normalized member relation; populated as member pages load.
    pub member_ids: Vec<Id>,
    /// Total membership count; `members` is only a small initial page now.
    pub member_count: u32,
    /// Your read markers in this server (channel, last read message id).
    pub reads: Vec<(Id, Id)>,
    /// Members currently connected.
    pub online: Vec<Id>,
    /// What members are playing right now (user, game name).
    pub activities: Vec<(Id, String)>,
}

/// Longest game name accepted for an activity.
pub const MAX_ACTIVITY_CHARS: usize = 48;

/// Latency stamps (Unix µs). Client stamps are in the sender's clock, server
/// stamps in the server's clock. Receivers add their own receive/render stamps.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Trace {
    /// User pressed Enter.
    pub t_input: i64,
    /// Frame handed to the socket.
    pub t_client_send: i64,
    /// Server decoded the frame.
    pub t_server_recv: i64,
    /// Server handed the fan-out frame to the broadcast.
    pub t_server_send: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub id: Id,
    pub channel_id: Id,
    pub author_id: Id,
    pub content: String,
    /// Unix ms of last edit.
    pub edited_at: Option<i64>,
    /// Sender's local nonce (0 when loaded from history). Lets the sender
    /// reconcile its optimistic copy the moment the fan-out arrives.
    pub nonce: u64,
    pub trace: Option<Trace>,
    /// The message this one replies to.
    pub reply_to: Option<Id>,
    /// Aggregated reactions (history pages; live messages start empty).
    pub reactions: Vec<Reaction>,
    pub attachments: Vec<Attachment>,
}

/// Durable channel changes stored in PostgreSQL and replayed after reconnect.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DurablePayload {
    Message(Message),
    Edited { channel_id: Id, id: Id, content: String, edited_at: i64 },
    Deleted { channel_id: Id, id: Id },
    Reaction { channel_id: Id, message_id: Id, emoji: String, user_id: Id, add: bool },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DurableEvent {
    pub cursor: i64,
    pub payload: DurablePayload,
}

/// A file or GIF attached to a message.
///
/// Uploaded files: `url` is empty and the file is served by the chat server at
/// `/files/{id}`. GIFs: `url` is the provider's media URL (set by the server
/// from its own search results, never taken from a client).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// Pixel size for images, video and GIFs (0 if unknown); lets clients
    /// reserve the box before the media loads.
    pub width: u32,
    pub height: u32,
    pub url: String,
    /// Small preview (GIFs: a still or small animation). May be empty.
    pub preview: String,
}

/// One GIF search result.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Gif {
    /// Opaque id to send back in `Send.gifs`.
    pub id: String,
    pub title: String,
    /// Small animated preview for the picker.
    pub preview: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Reaction {
    pub emoji: String,
    pub users: Vec<Id>,
}

/// Distinct reactions per message.
pub const MAX_REACTIONS_PER_MESSAGE: usize = 20;
pub const MAX_EMOJI_BYTES: usize = 32;

/// A reaction must be a short symbol: no whitespace, no control characters,
/// no ASCII letters or digits (so it can't be used as a text channel).
pub fn valid_emoji(e: &str) -> bool {
    !e.is_empty()
        && e.len() <= MAX_EMOJI_BYTES
        && e.chars()
            .all(|c| !c.is_whitespace() && !c.is_control() && !c.is_ascii_alphanumeric())
}

/// Mention token for a user inside message content.
pub fn mention_token(user: Id) -> String {
    format!("<@{user}>")
}

/// User ids mentioned in `content` (`<@id>` tokens).
pub fn mentions(content: &str) -> Vec<Id> {
    let mut out = vec![];
    let mut rest = content;
    while let Some(i) = rest.find("<@") {
        rest = &rest[i + 2..];
        if let Some(j) = rest.find('>') {
            if let Ok(id) = rest[..j].parse::<Id>() {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
            rest = &rest[j + 1..];
        } else {
            break;
        }
    }
    out
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct VoicePresence {
    pub channel_id: Id,
    pub user_id: Id,
    pub muted: bool,
    pub deafened: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum C2S {
    Signup {
        username: String,
        password: String,
    },
    Login {
        username: String,
        password: String,
    },
    /// Authenticate with a still-valid access token.
    Resume {
        access_token: String,
    },
    /// Exchange a refresh token for new tokens.
    Refresh {
        refresh_token: String,
    },
    /// Revokes this device's refresh token.
    Logout {
        refresh_token: String,
    },
    Ping {
        t_client: i64,
    },
    /// `content` may be empty when there are attachments or GIFs. `files` are
    /// ids returned by `POST /files`; `gifs` are ids from `Gifs` results.
    Send {
        channel_id: Id,
        content: String,
        nonce: u64,
        /// Outbox resend that may already be saved by a previous process.
        retry: bool,
        t_input: i64,
        t_client_send: i64,
        reply_to: Option<Id>,
        files: Vec<String>,
        gifs: Vec<String>,
    },
    /// GIF search; an empty query returns trending GIFs.
    GifSearch {
        query: String,
    },
    /// A fresh access token for HTTP calls (file uploads).
    AccessToken,
    /// "I'm playing <game>" (empty = nothing). Shown to people who share a server.
    SetActivity {
        game: String,
    },
    /// Add (`add = true`) or remove your reaction. Idempotent.
    React {
        channel_id: Id,
        message_id: Id,
        emoji: String,
        add: bool,
    },
    Edit {
        channel_id: Id,
        message_id: Id,
        content: String,
    },
    Delete {
        channel_id: Id,
        message_id: Id,
    },
    /// Newest-first page of messages older than `before` (or the latest).
    History {
        channel_id: Id,
        before: Option<Id>,
        limit: u16,
    },
    /// Replay durable channel changes after the last cursor received.
    Replay {
        channel_id: Id,
        after_cursor: i64,
        limit: u16,
    },
    /// Membership is fetched on demand in bounded pages.
    Members {
        server_id: Id,
        offset: u32,
        limit: u16,
    },
    /// Prefix search for mention autocomplete.
    MemberSearch {
        server_id: Id,
        query: String,
        limit: u16,
    },
    /// Resolve a sender's display data when their roster page has not loaded.
    UserLookup {
        server_id: Id,
        user_id: Id,
    },
    CreateServer {
        name: String,
    },
    CreateChannel {
        server_id: Id,
        name: String,
        kind: ChannelKind,
    },
    CreateInvite {
        server_id: Id,
    },
    JoinInvite {
        code: String,
    },
    /// Ask for a media grant. Does not join on its own: the client joins the
    /// SFU and then sends `VoiceState`.
    VoiceGrant {
        channel_id: Id,
    },
    VoiceState {
        channel_id: Option<Id>,
        muted: bool,
        deafened: bool,
    },
    /// Token for the screen-share connection (identity "<user>:screen") in the
    /// voice room you're in. Answered with `VoiceGrant`.
    ScreenGrant {
        channel_id: Id,
    },
    /// Advertise whether the current voice participant is sharing a screen.
    ScreenShare { active: bool },
    /// PNG, JPEG or WebP, at most `MAX_AVATAR_BYTES`. Empty removes it.
    SetAvatar {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    GetAvatar {
        user_id: Id,
    },
    /// Replace your saved preferences (a JSON object, at most MAX_PREFS_BYTES).
    SavePrefs {
        json: String,
    },
    /// "I'm typing in this channel" (ephemeral; send at most every 3 s).
    Typing {
        channel_id: Id,
    },
    /// Everything up to and including `message_id` has been seen. Markers
    /// only move forward.
    MarkRead {
        channel_id: Id,
        message_id: Id,
    },
    // ----- server administration (owner only unless noted) -----
    RenameServer {
        server_id: Id,
        name: String,
    },
    DeleteServer {
        server_id: Id,
    },
    /// `None` leaves a field unchanged.
    UpdateChannel {
        channel_id: Id,
        name: Option<String>,
        topic: Option<String>,
    },
    DeleteChannel {
        channel_id: Id,
    },
    Kick {
        server_id: Id,
        user_id: Id,
    },
    RevokeInvites {
        server_id: Id,
    },
    /// Any member except the owner.
    LeaveServer {
        server_id: Id,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ClientFrame {
    pub req: u32,
    pub msg: C2S,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    RateLimited,
    Internal,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum S2C {
    Authed {
        user: UserInfo,
        access_token: String,
        /// Empty when unchanged (e.g. after `Resume`).
        refresh_token: String,
        servers: Vec<ServerInfo>,
        voice: Vec<VoicePresence>,
        /// Your saved preferences (JSON object; opaque to the server).
        prefs: String,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
    Pong {
        t_client: i64,
        t_server: i64,
    },
    /// Sent to the author once the message is durable.
    Ack {
        channel_id: Id,
        nonce: u64,
        id: Id,
        t_server_recv: i64,
        t_persisted: i64,
    },
    Message(Message),
    Edited {
        channel_id: Id,
        id: Id,
        content: String,
        edited_at: i64,
    },
    Deleted {
        channel_id: Id,
        id: Id,
    },
    History {
        channel_id: Id,
        messages: Vec<Message>,
        more: bool,
        /// Highest durable event cursor included in the snapshot boundary.
        latest_cursor: i64,
    },
    /// A live durable channel event. The cursor is scoped to its channel.
    ChannelEvent(DurableEvent),
    Replay {
        channel_id: Id,
        events: Vec<DurableEvent>,
        latest_cursor: i64,
        more: bool,
        snapshot_required: bool,
    },
    Members {
        server_id: Id,
        offset: u32,
        members: Vec<UserInfo>,
        online: Vec<Id>,
        activities: Vec<(Id, String)>,
    },
    MemberSearch {
        server_id: Id,
        members: Vec<UserInfo>,
    },
    UserLookup(UserInfo),
    ServerJoined(ServerInfo),
    ChannelCreated(ChannelInfo),
    MemberJoined {
        server_id: Id,
        user: UserInfo,
    },
    Invite {
        server_id: Id,
        code: String,
    },
    VoiceGrant {
        channel_id: Id,
        url: String,
        token: String,
    },
    /// `channel_id = None` means the user left voice.
    VoicePresence {
        server_id: Id,
        user_id: Id,
        channel_id: Option<Id>,
        muted: bool,
        deafened: bool,
    },
    ScreenPresence { server_id: Id, channel_id: Id, user_id: Id, active: bool },
    LoggedOut,
    Ok,
    /// A user's profile changed (e.g. new avatar); sent to all their servers.
    UserUpdated(UserInfo),
    Reaction {
        channel_id: Id,
        message_id: Id,
        emoji: String,
        user_id: Id,
        add: bool,
    },
    /// Your preferences changed on another device.
    PrefsUpdated {
        json: String,
    },
    /// A user message delivered before its database commit. The durable
    /// channel event follows on success; a deletion retracts a failed write.
    LiveMessage(Message),
    /// Someone is typing (show for ~6 s unless refreshed).
    Typing {
        channel_id: Id,
        user_id: Id,
    },
    /// Your read marker moved (from another of your devices).
    ReadUpdated {
        channel_id: Id,
        last_read: Id,
    },
    UserPresence {
        user_id: Id,
        online: bool,
    },
    ServerUpdated {
        server_id: Id,
        name: String,
    },
    /// You are no longer in this server (sent to the affected user, or to
    /// everyone when it was deleted).
    ServerRemoved {
        server_id: Id,
        reason: RemovedReason,
    },
    ChannelUpdated(ChannelInfo),
    ChannelDeleted {
        server_id: Id,
        channel_id: Id,
    },
    MemberLeft {
        server_id: Id,
        user_id: Id,
        reason: RemovedReason,
    },
    AccessToken {
        token: String,
    },
    /// A member started/stopped playing (`game` empty = stopped).
    Activity {
        user_id: Id,
        game: String,
    },
    /// GIF search results. `enabled = false`: this server has no GIF provider.
    Gifs {
        enabled: bool,
        results: Vec<Gif>,
    },
    Avatar {
        user_id: Id,
        avatar_v: u32,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
}

/// Image type by magic bytes; only these are accepted as avatars.
pub fn image_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ServerFrame {
    pub req: u32,
    pub msg: S2C,
}

#[derive(Debug)]
pub struct DecodeError(pub String);

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for DecodeError {}

#[inline]
pub fn encode<T: Serialize>(v: &T) -> Vec<u8> {
    // Infallible for our types (no maps with non-string keys, no unsized).
    rmp_serde::to_vec(v).expect("msgpack encode")
}

#[inline]
pub fn encode_into<T: Serialize>(buf: &mut Vec<u8>, v: &T) {
    buf.clear();
    rmp_serde::encode::write(buf, v).expect("msgpack encode");
}

#[inline]
pub fn decode<'a, T: Deserialize<'a>>(b: &'a [u8]) -> Result<T, DecodeError> {
    if b.len() > MAX_FRAME_BYTES {
        return Err(DecodeError("frame too large".into()));
    }
    rmp_serde::from_slice(b).map_err(|e| DecodeError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emoji_and_mentions() {
        assert!(valid_emoji("🏳️‍🌈"), "zwj sequence");
        assert!(valid_emoji("👍"));
        assert!(
            !valid_emoji("ab")
                && !valid_emoji("")
                && !valid_emoji("👍 👍")
                && !valid_emoji(&"🔥".repeat(20))
        );
        assert_eq!(
            mentions("hi <@12> and <@34> and <@12> <@x> <@5"),
            vec![12, 34]
        );
        assert_eq!(mention_token(7), "<@7>");
    }

    #[test]
    fn roundtrip_and_size() {
        let f = ServerFrame {
            req: 0,
            msg: S2C::Message(Message {
                id: 123456789012345,
                channel_id: 987654321,
                author_id: 42,
                content: "hello".into(),
                edited_at: None,
                nonce: 7,
                trace: Some(Trace {
                    t_input: 1,
                    t_client_send: 2,
                    t_server_recv: 3,
                    t_server_send: 4,
                }),
                reply_to: None,
                reactions: vec![],
                attachments: vec![],
            }),
        };
        let b = encode(&f);
        let back: ServerFrame = decode(&b).unwrap();
        assert_eq!(back, f);
        // Compact: a short chat message with full trace fits in well under 100 bytes.
        assert!(b.len() < 100, "{} bytes", b.len());

        let c = ClientFrame {
            req: 9,
            msg: C2S::Ping { t_client: 5 },
        };
        assert_eq!(decode::<ClientFrame>(&encode(&c)).unwrap(), c);

        let durable = ServerFrame {
            req: 0,
            msg: S2C::ChannelEvent(DurableEvent {
                cursor: 12,
                payload: DurablePayload::Deleted { channel_id: 4, id: 9 },
            }),
        };
        assert_eq!(decode::<ServerFrame>(&encode(&durable)).unwrap(), durable);
    }
}
