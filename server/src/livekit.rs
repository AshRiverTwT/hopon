//! Minimal LiveKit RoomService client (Twirp over HTTP): used to end a voice
//! room when its channel is deleted and to drop a kicked member from a call.
//! Best effort: failures are logged, never block the chat action.

use crate::state::State;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::json;
use std::sync::Arc;

fn http_base(url: &str) -> String {
    if let Some(r) = url.strip_prefix("wss://") {
        format!("https://{r}")
    } else if let Some(r) = url.strip_prefix("ws://") {
        format!("http://{r}")
    } else {
        url.to_owned()
    }
    .trim_end_matches('/')
    .to_owned()
}

fn admin_token(st: &State, room: &str) -> String {
    let now = hopon_shared::time::now_us() / 1_000_000;
    let claims = json!({
        "iss": st.cfg.livekit_key, "sub": "hopon-server", "nbf": now - 5, "exp": now + 60,
        "video": { "room": room, "roomAdmin": true, "roomCreate": true }
    });
    encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(st.cfg.livekit_secret.as_bytes())).expect("jwt")
}

async fn call(st: &State, method: &str, room: &str, body: serde_json::Value) -> anyhow::Result<()> {
    let url = format!("{}/twirp/livekit.RoomService/{method}", http_base(&st.cfg.livekit_url));
    let r = st
        .http
        .post(url)
        .bearer_auth(admin_token(st, room))
        .json(&body)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await?;
    // 404: room already gone / participant not in it.
    if !r.status().is_success() && r.status().as_u16() != 404 {
        anyhow::bail!("{method}: HTTP {}", r.status());
    }
    Ok(())
}

pub fn delete_room(st: Arc<State>, room: String) {
    tokio::spawn(async move {
        if let Err(e) = call(&st, "DeleteRoom", &room, json!({ "room": room })).await {
            tracing::warn!("livekit delete room {room}: {e:#}");
        }
    });
}

pub fn remove_participant(st: Arc<State>, room: String, identity: String) {
    tokio::spawn(async move {
        if let Err(e) = call(&st, "RemoveParticipant", &room, json!({ "room": room, "identity": identity })).await {
            tracing::warn!("livekit remove {identity} from {room}: {e:#}");
        }
    });
}
