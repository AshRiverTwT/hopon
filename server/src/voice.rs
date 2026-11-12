//! LiveKit join grants. Minted locally (HS256 with the LiveKit API secret),
//! so asking for a grant costs no network round trip to the SFU.

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGrant {
    room: String,
    room_join: bool,
    can_publish: bool,
    can_subscribe: bool,
    can_publish_data: bool,
    /// What this participant may publish (microphone for voice, screen for
    /// screen share), so a voice token can't stream video and vice versa.
    can_publish_sources: Vec<&'static str>,
    /// Screen connections set an attribute naming the streams they watch
    /// (viewer counts); voice connections can't change their own metadata.
    can_update_own_metadata: bool,
}

#[derive(Serialize)]
struct Claims {
    iss: String,
    sub: String,
    name: String,
    nbf: i64,
    exp: i64,
    video: VideoGrant,
}

pub fn room_name(channel_id: i64) -> String {
    format!("ch_{channel_id}")
}

/// LiveKit identity of a user's screen-share connection (separate from voice).
pub fn screen_identity(user_id: i64) -> String {
    format!("{user_id}:screen")
}

pub fn grant(key: &str, secret: &str, user_id: i64, name: &str, channel_id: i64) -> String {
    mint(key, secret, user_id.to_string(), name, channel_id, vec!["microphone"], false)
}

/// Screen share: publish screen video (+ its audio) and watch others'.
pub fn screen_grant(key: &str, secret: &str, user_id: i64, name: &str, channel_id: i64) -> String {
    mint(key, secret, screen_identity(user_id), name, channel_id, vec!["screen_share", "screen_share_audio"], true)
}

fn mint(key: &str, secret: &str, identity: String, name: &str, channel_id: i64, sources: Vec<&'static str>, metadata: bool) -> String {
    let now = hopon_shared::time::now_us() / 1_000_000;
    let c = Claims {
        iss: key.to_owned(),
        sub: identity,
        name: name.to_owned(),
        nbf: now - 5,
        exp: now + 10 * 60,
        video: VideoGrant {
            room: room_name(channel_id),
            room_join: true,
            can_publish: true,
            can_subscribe: true,
            can_publish_data: false,
            can_publish_sources: sources,
            can_update_own_metadata: metadata,
        },
    };
    encode(&Header::new(Algorithm::HS256), &c, &EncodingKey::from_secret(secret.as_bytes())).expect("jwt")
}
