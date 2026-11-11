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

pub fn grant(key: &str, secret: &str, user_id: i64, name: &str, channel_id: i64) -> String {
    let now = hopon_shared::time::now_us() / 1_000_000;
    let c = Claims {
        iss: key.to_owned(),
        sub: user_id.to_string(),
        name: name.to_owned(),
        nbf: now - 5,
        exp: now + 10 * 60,
        video: VideoGrant {
            room: room_name(channel_id),
            room_join: true,
            can_publish: true,
            can_subscribe: true,
            can_publish_data: false,
        },
    };
    encode(&Header::new(Algorithm::HS256), &c, &EncodingKey::from_secret(secret.as_bytes())).expect("jwt")
}
