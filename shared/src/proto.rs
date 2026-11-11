//! Wire protocol. One WebSocket per client, binary frames, MessagePack
//! (structs encoded as arrays, so field names never hit the wire).
//!
//! Every client frame carries a `req` id; replies echo it. Unsolicited
//! events use `req = 0`.

use serde::{Deserialize, Serialize};

pub type Id = i64;

pub const MAX_MESSAGE_CHARS: usize = 4000;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const HISTORY_PAGE_MAX: u16 = 100;
/// Avatars are small square images (the client uploads 128 px WebP).
pub const MAX_AVATAR_BYTES: usize = 48 * 1024;

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
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    pub id: Id,
    pub name: String,
    pub owner_id: Id,
    pub channels: Vec<ChannelInfo>,
    pub members: Vec<UserInfo>,
}

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
    Signup { username: String, password: String },
    Login { username: String, password: String },
    /// Authenticate with a still-valid access token.
    Resume { access_token: String },
    /// Exchange a refresh token for new tokens.
    Refresh { refresh_token: String },
    /// Revokes this device's refresh token.
    Logout { refresh_token: String },
    Ping { t_client: i64 },
    Send { channel_id: Id, content: String, nonce: u64, t_input: i64, t_client_send: i64 },
    Edit { channel_id: Id, message_id: Id, content: String },
    Delete { channel_id: Id, message_id: Id },
    /// Newest-first page of messages older than `before` (or the latest).
    History { channel_id: Id, before: Option<Id>, limit: u16 },
    CreateServer { name: String },
    CreateChannel { server_id: Id, name: String, kind: ChannelKind },
    CreateInvite { server_id: Id },
    JoinInvite { code: String },
    /// Ask for a media grant. Does not join on its own: the client joins the
    /// SFU and then sends `VoiceState`.
    VoiceGrant { channel_id: Id },
    VoiceState { channel_id: Option<Id>, muted: bool, deafened: bool },
    /// PNG, JPEG or WebP, at most `MAX_AVATAR_BYTES`. Empty removes it.
    SetAvatar {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    GetAvatar { user_id: Id },
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
    },
    Error { code: ErrorCode, message: String },
    Pong { t_client: i64, t_server: i64 },
    /// Sent to the author once the message is durable.
    Ack { channel_id: Id, nonce: u64, id: Id, t_server_recv: i64, t_persisted: i64 },
    Message(Message),
    Edited { channel_id: Id, id: Id, content: String, edited_at: i64 },
    Deleted { channel_id: Id, id: Id },
    History { channel_id: Id, messages: Vec<Message>, more: bool },
    ServerJoined(ServerInfo),
    ChannelCreated(ChannelInfo),
    MemberJoined { server_id: Id, user: UserInfo },
    Invite { server_id: Id, code: String },
    VoiceGrant { channel_id: Id, url: String, token: String },
    /// `channel_id = None` means the user left voice.
    VoicePresence { server_id: Id, user_id: Id, channel_id: Option<Id>, muted: bool, deafened: bool },
    LoggedOut,
    Ok,
    /// A user's profile changed (e.g. new avatar); sent to all their servers.
    UserUpdated(UserInfo),
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
                trace: Some(Trace { t_input: 1, t_client_send: 2, t_server_recv: 3, t_server_send: 4 }),
            }),
        };
        let b = encode(&f);
        let back: ServerFrame = decode(&b).unwrap();
        assert_eq!(back, f);
        // Compact: a short chat message with full trace fits in well under 100 bytes.
        assert!(b.len() < 100, "{} bytes", b.len());

        let c = ClientFrame { req: 9, msg: C2S::Ping { t_client: 5 } };
        assert_eq!(decode::<ClientFrame>(&encode(&c)).unwrap(), c);
    }
}
