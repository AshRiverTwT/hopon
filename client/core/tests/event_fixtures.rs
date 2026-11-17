//! One sample of every `UiEvent`, serialized as the UI receives it, in
//! `client/native/fixtures/events.json`. The C# models are checked against
//! that file with unknown members disallowed (client/native/HopOn.Interop.Tests),
//! so the two sides can't drift apart silently.
//!
//! Regenerate after changing an event: `UPDATE_FIXTURES=1 cargo test -p hopon-core --test event_fixtures`.

use hopon_core::ui::*;
use hopon_shared::Attachment;
use std::collections::HashMap;

fn user(id: &str) -> UiUser {
    UiUser { id: id.into(), name: format!("user {id}"), avatar_v: 3, accent: 2 }
}
fn status() -> UiStatus {
    UiStatus { mode: "dnd", emoji: "🎮".into(), text: "ranked".into(), until: 1_800_000_000_000 }
}
fn channel() -> UiChannel {
    UiChannel { id: "20".into(), server_id: "10".into(), name: "general".into(), voice: false, topic: "hi".into(), last_id: "99".into() }
}
fn server() -> UiServer {
    UiServer {
        id: "10".into(),
        name: "test".into(),
        owner_id: "1".into(),
        channels: vec![channel(), UiChannel { voice: true, id: "21".into(), name: "voice".into(), ..channel() }],
        member_ids: vec!["1".into(), "2".into()],
        member_count: 2,
        reads: HashMap::from([("20".into(), "98".into())]),
        online: vec!["1".into()],
        activities: HashMap::from([("1".into(), "VALORANT".into())]),
        statuses: HashMap::from([("1".into(), status())]),
        dm_with: Some("2".into()),
    }
}
fn friend() -> UiFriend {
    UiFriend { user: user("2"), username: "bob".into(), state: "friends", dm_server: Some("11".into()) }
}
fn presence() -> UiPresence {
    UiPresence { user_id: "1".into(), channel_id: Some("21".into()), muted: true, deafened: false }
}
fn media() -> UiMedia {
    UiMedia { channel_id: "21".into(), user_id: "1".into(), source: "screen", active: true }
}
fn msg() -> UiMsg {
    UiMsg {
        id: "99".into(),
        channel_id: "20".into(),
        author_id: "1".into(),
        content: "hello **world**".into(),
        edited_at: Some(1_700_000_000_000),
        ts: 1_700_000_000_000,
        nonce: "12345".into(),
        state: 2,
        reply_to: Some("98".into()),
        reactions: vec![UiReaction { emoji: "👍".into(), users: vec!["2".into()] }],
        attachments: vec![Attachment {
            id: "f1".into(),
            name: "cat.png".into(),
            mime: "image/png".into(),
            size: 1234,
            width: 64,
            height: 48,
            url: String::new(),
            preview: String::new(),
        }],
    }
}

fn samples() -> Vec<UiEvent> {
    let all = vec![
        UiEvent::Conn { state: "online", rtt_ms: Some(1.5) },
        UiEvent::Session {
            user: Some(user("1")),
            servers: vec![server()],
            users: vec![user("1"), user("2")],
            voice: vec![presence()],
            media: vec![media()],
            username: "alice".into(),
            friends: vec![friend()],
            status: status(),
            auth_pending: false,
        },
        UiEvent::Friend { friend: friend() },
        UiEvent::FriendRemoved { user_id: "2".into() },
        UiEvent::Server { server: server() },
        UiEvent::ChannelCreated { channel: channel() },
        UiEvent::MemberJoined { server_id: "10".into(), user: user("3") },
        UiEvent::MemberPage {
            server_id: "10".into(),
            offset: 0,
            users: vec![user("1")],
            online: vec!["1".into()],
            activities: HashMap::from([("1".into(), "Dota 2".into())]),
            statuses: HashMap::from([("1".into(), status())]),
        },
        UiEvent::MemberSearch { server_id: "10".into(), users: vec![user("2")] },
        UiEvent::UserUpdated { user: user("2") },
        UiEvent::ServerRemoved { server_id: "10".into(), reason: "kicked" },
        UiEvent::ChannelDeleted { server_id: "10".into(), channel_id: "20".into() },
        UiEvent::ReadUpdated { channel_id: "20".into(), last_read: "99".into() },
        UiEvent::ChannelActivity { channel_id: "20".into(), last_id: "99".into() },
        UiEvent::Reaction { channel_id: "20".into(), message_id: "99".into(), emoji: "🔥".into(), user_id: "2".into(), add: true },
        UiEvent::Typing { channel_id: "20".into(), user_id: "2".into() },
        UiEvent::Prefs { json: "{\"sounds\":true}".into() },
        UiEvent::Mentioned { channel_id: "20".into() },
        UiEvent::IncomingMessage { channel_id: "20".into(), msg: msg() },
        UiEvent::UserPresence { user_id: "2".into(), online: true },
        UiEvent::Status { user_id: "2".into(), status: status() },
        UiEvent::Activity { user_id: "2".into(), game: "Fortnite".into() },
        UiEvent::Messages { channel_id: "20".into(), msgs: vec![msg(), UiMsg { edited_at: None, reply_to: None, ..msg() }] },
        UiEvent::MsgState { channel_id: "20".into(), nonce: "12345".into(), id: "99".into(), state: 2 },
        UiEvent::Edited { channel_id: "20".into(), id: "99".into(), content: "edited".into(), edited_at: 1_700_000_000_001 },
        UiEvent::Deleted { channel_id: "20".into(), id: "99".into() },
        UiEvent::Presence { server_id: "10".into(), presence: UiPresence { channel_id: None, ..presence() } },
        UiEvent::MediaPresence { media: media() },
        UiEvent::Voice { channel_id: Some("21".into()), state: "connected", muted: false, deafened: false, detail: None },
        UiEvent::Speaking { user_ids: vec!["1".into(), "2".into()] },
        UiEvent::Screen {
            state: hopon_core::ui::ScreenState {
                channel_id: Some("21".into()),
                sharing: true,
                watching: vec!["2".into()],
                live: vec!["2".into()],
                viewers: [("2".to_owned(), vec!["1".to_owned(), "3".to_owned()])].into_iter().collect(),
                detail: None,
            },
        },
        UiEvent::OpenChannel { channel_id: "20".into() },
        UiEvent::Error { message: "something failed".into() },
    ];
    // Exhaustive (no wildcard): a new event kind fails to compile here until
    // it gets a sample above and a C# model.
    for ev in &all {
        match ev {
            UiEvent::Conn { .. } | UiEvent::Session { .. } | UiEvent::Friend { .. } | UiEvent::FriendRemoved { .. }
            | UiEvent::Server { .. } | UiEvent::ChannelCreated { .. } | UiEvent::MemberJoined { .. }
            | UiEvent::MemberPage { .. } | UiEvent::MemberSearch { .. } | UiEvent::UserUpdated { .. }
            | UiEvent::ServerRemoved { .. } | UiEvent::ChannelDeleted { .. } | UiEvent::ReadUpdated { .. }
            | UiEvent::ChannelActivity { .. } | UiEvent::Reaction { .. } | UiEvent::Typing { .. }
            | UiEvent::Prefs { .. } | UiEvent::Mentioned { .. } | UiEvent::IncomingMessage { .. }
            | UiEvent::UserPresence { .. } | UiEvent::Status { .. } | UiEvent::Activity { .. }
            | UiEvent::Messages { .. } | UiEvent::MsgState { .. } | UiEvent::Edited { .. } | UiEvent::Deleted { .. }
            | UiEvent::Presence { .. } | UiEvent::MediaPresence { .. } | UiEvent::Voice { .. }
            | UiEvent::Speaking { .. } | UiEvent::Screen { .. } | UiEvent::OpenChannel { .. } | UiEvent::Error { .. } => {}
        }
    }
    all
}

#[test]
fn every_event_has_a_current_fixture() {
    let events = samples();
    let kinds: std::collections::HashSet<_> =
        events.iter().map(|e| serde_json::to_value(e).unwrap()["t"].as_str().unwrap().to_owned()).collect();
    assert_eq!(kinds.len(), events.len(), "one sample per kind");
    // Serialized directly (not via Value), so field order is the wire's: "t" first.
    let text = serde_json::to_string_pretty(&events).unwrap() + "\n";
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../native/fixtures/events.json");
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(path, &text).unwrap();
    }
    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert!(on_disk == text, "client/native/fixtures/events.json is stale: rerun with UPDATE_FIXTURES=1");
}
