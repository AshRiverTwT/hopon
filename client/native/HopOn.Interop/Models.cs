// Typed views of the core's JSON (client/core/src/ui.rs is the source of truth;
// client/ui/src/types.ts mirrors it for the webview). IDs are decimal strings:
// they are 63-bit, and strings keep one representation across both shells.
//
// Checked against client/native/fixtures/events.json (one sample of every
// event, generated from Rust) by HopOn.Interop.Tests: unknown members are
// rejected there and every member here is `required`, so a field added or
// removed on either side fails the test.

using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HopOn.Native;

public sealed record User
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    /// <summary>0 = no avatar; otherwise fetch with avatar(id, v).</summary>
    public required uint AvatarV { get; init; }
    /// <summary>Profile colour: palette index (0 = none).</summary>
    public required byte Accent { get; init; }
}

/// <summary>Presence mode ("online" | "idle" | "dnd" | "invisible") and custom status.</summary>
public sealed record Status
{
    public required string Mode { get; init; }
    public required string Emoji { get; init; }
    public required string Text { get; init; }
    /// <summary>Unix ms the custom part clears (0 = never).</summary>
    public required long Until { get; init; }
}

public sealed record Profile
{
    public required User User { get; init; }
    public required string Username { get; init; }
    public required string Bio { get; init; }
    public required uint BannerV { get; init; }
    public required long CreatedAt { get; init; }
    public required long JoinedAt { get; init; }
}

public sealed record Channel
{
    public required string Id { get; init; }
    public required string ServerId { get; init; }
    public required string Name { get; init; }
    public required bool Voice { get; init; }
    public required string Topic { get; init; }
    public required string LastId { get; init; }
}

public sealed record Server
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string OwnerId { get; init; }
    public required List<Channel> Channels { get; init; }
    public required List<string> MemberIds { get; init; }
    public required uint MemberCount { get; init; }
    /// <summary>channel id → last read message id.</summary>
    public required Dictionary<string, string> Reads { get; init; }
    public required List<string> Online { get; init; }
    /// <summary>user → game they're playing.</summary>
    public required Dictionary<string, string> Activities { get; init; }
    /// <summary>user → status, for online members who aren't plain "online".</summary>
    public required Dictionary<string, Status> Statuses { get; init; }
    /// <summary>A direct message with this person (hidden from the server list).</summary>
    public required string? DmWith { get; init; }
}

public sealed record Friend
{
    public required User User { get; init; }
    public required string Username { get; init; }
    /// <summary>"friends" | "incoming" | "outgoing".</summary>
    public required string State { get; init; }
    public required string? DmServer { get; init; }
}

public sealed record Reaction
{
    public required string Emoji { get; init; }
    public required List<string> Users { get; init; }
}

/// <summary>A file or GIF. Empty <see cref="Url"/>: served by the chat server at /files/{id}.</summary>
public sealed record Attachment
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Mime { get; init; }
    public required ulong Size { get; init; }
    public required uint Width { get; init; }
    public required uint Height { get; init; }
    public required string Url { get; init; }
    public required string Preview { get; init; }
}

public sealed record Gif
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Preview { get; init; }
    public required uint Width { get; init; }
    public required uint Height { get; init; }
}

public sealed record Msg
{
    /// <summary>Server ID, or "p&lt;nonce&gt;" while pending.</summary>
    public required string Id { get; init; }
    public required string ChannelId { get; init; }
    public required string AuthorId { get; init; }
    public required string Content { get; init; }
    public required long? EditedAt { get; init; }
    /// <summary>Unix ms.</summary>
    public required ulong Ts { get; init; }
    public required string Nonce { get; init; }
    /// <summary>0 pending, 1 delivered, 2 durable, 3 failed.</summary>
    public required byte State { get; init; }
    public required string? ReplyTo { get; init; }
    public required List<Reaction> Reactions { get; init; }
    public required List<Attachment> Attachments { get; init; }
}

public sealed record Presence
{
    public required string UserId { get; init; }
    public required string? ChannelId { get; init; }
    public required bool Muted { get; init; }
    public required bool Deafened { get; init; }
}

public sealed record MediaPresence
{
    public required string ChannelId { get; init; }
    public required string UserId { get; init; }
    /// <summary>"screen" | "camera".</summary>
    public required string Source { get; init; }
    public required bool Active { get; init; }
}

// ---------- events ----------

[JsonPolymorphic(TypeDiscriminatorPropertyName = "t")]
[JsonDerivedType(typeof(ConnEvent), "conn")]
[JsonDerivedType(typeof(SessionEvent), "session")]
[JsonDerivedType(typeof(FriendEvent), "friend")]
[JsonDerivedType(typeof(FriendRemovedEvent), "friendRemoved")]
[JsonDerivedType(typeof(ServerEvent), "server")]
[JsonDerivedType(typeof(ChannelCreatedEvent), "channelCreated")]
[JsonDerivedType(typeof(MemberJoinedEvent), "memberJoined")]
[JsonDerivedType(typeof(MemberPageEvent), "memberPage")]
[JsonDerivedType(typeof(MemberSearchEvent), "memberSearch")]
[JsonDerivedType(typeof(UserUpdatedEvent), "userUpdated")]
[JsonDerivedType(typeof(ServerRemovedEvent), "serverRemoved")]
[JsonDerivedType(typeof(ChannelDeletedEvent), "channelDeleted")]
[JsonDerivedType(typeof(ReadUpdatedEvent), "readUpdated")]
[JsonDerivedType(typeof(ChannelActivityEvent), "channelActivity")]
[JsonDerivedType(typeof(ReactionEvent), "reaction")]
[JsonDerivedType(typeof(TypingEvent), "typing")]
[JsonDerivedType(typeof(PrefsEvent), "prefs")]
[JsonDerivedType(typeof(MentionedEvent), "mentioned")]
[JsonDerivedType(typeof(IncomingMessageEvent), "incomingMessage")]
[JsonDerivedType(typeof(UserPresenceEvent), "userPresence")]
[JsonDerivedType(typeof(StatusEvent), "status")]
[JsonDerivedType(typeof(ActivityEvent), "activity")]
[JsonDerivedType(typeof(MessagesEvent), "messages")]
[JsonDerivedType(typeof(MsgStateEvent), "msgState")]
[JsonDerivedType(typeof(EditedEvent), "edited")]
[JsonDerivedType(typeof(DeletedEvent), "deleted")]
[JsonDerivedType(typeof(PresenceEvent), "presence")]
[JsonDerivedType(typeof(MediaPresenceEvent), "mediaPresence")]
[JsonDerivedType(typeof(VoiceEvent), "voice")]
[JsonDerivedType(typeof(SpeakingEvent), "speaking")]
[JsonDerivedType(typeof(OpenChannelEvent), "openChannel")]
[JsonDerivedType(typeof(ErrorEvent), "error")]
public abstract record UiEvent;

/// <summary>State: "connecting" | "online" | "offline" | "incompatible".</summary>
public sealed record ConnEvent : UiEvent
{
    public required string State { get; init; }
    public required double? RttMs { get; init; }
}

public sealed record SessionEvent : UiEvent
{
    public required User? User { get; init; }
    public required List<Server> Servers { get; init; }
    public required List<User> Users { get; init; }
    public required List<Presence> Voice { get; init; }
    public required List<MediaPresence> Media { get; init; }
    /// <summary>Your unique login name.</summary>
    public required string Username { get; init; }
    public required List<Friend> Friends { get; init; }
    public required Status Status { get; init; }
    /// <summary>Still trying the saved sign-in: show the splash, not the login screen.</summary>
    public required bool AuthPending { get; init; }
}

public sealed record FriendEvent : UiEvent { public required Friend Friend { get; init; } }
public sealed record FriendRemovedEvent : UiEvent { public required string UserId { get; init; } }
public sealed record ServerEvent : UiEvent { public required Server Server { get; init; } }
public sealed record ChannelCreatedEvent : UiEvent { public required Channel Channel { get; init; } }

public sealed record MemberJoinedEvent : UiEvent
{
    public required string ServerId { get; init; }
    public required User User { get; init; }
}

public sealed record MemberPageEvent : UiEvent
{
    public required string ServerId { get; init; }
    public required uint Offset { get; init; }
    public required List<User> Users { get; init; }
    public required List<string> Online { get; init; }
    public required Dictionary<string, string> Activities { get; init; }
    public required Dictionary<string, Status> Statuses { get; init; }
}

public sealed record MemberSearchEvent : UiEvent
{
    public required string ServerId { get; init; }
    public required List<User> Users { get; init; }
}

public sealed record UserUpdatedEvent : UiEvent { public required User User { get; init; } }

/// <summary>Reason: "deleted" | "kicked" | "left".</summary>
public sealed record ServerRemovedEvent : UiEvent
{
    public required string ServerId { get; init; }
    public required string Reason { get; init; }
}

public sealed record ChannelDeletedEvent : UiEvent
{
    public required string ServerId { get; init; }
    public required string ChannelId { get; init; }
}

public sealed record ReadUpdatedEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required string LastRead { get; init; }
}

public sealed record ChannelActivityEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required string LastId { get; init; }
}

public sealed record ReactionEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required string MessageId { get; init; }
    public required string Emoji { get; init; }
    public required string UserId { get; init; }
    public required bool Add { get; init; }
}

public sealed record TypingEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required string UserId { get; init; }
}

/// <summary>Your synced preferences (an opaque JSON document the UI owns).</summary>
public sealed record PrefsEvent : UiEvent { public required string Json { get; init; } }
public sealed record MentionedEvent : UiEvent { public required string ChannelId { get; init; } }

/// <summary>A message for a channel that isn't open (notifications).</summary>
public sealed record IncomingMessageEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required Msg Msg { get; init; }
}

public sealed record UserPresenceEvent : UiEvent
{
    public required string UserId { get; init; }
    public required bool Online { get; init; }
}

public sealed record StatusEvent : UiEvent
{
    public required string UserId { get; init; }
    public required Status Status { get; init; }
}

public sealed record ActivityEvent : UiEvent
{
    public required string UserId { get; init; }
    public required string Game { get; init; }
}

/// <summary>New or updated messages for a channel (merge by id / nonce).</summary>
public sealed record MessagesEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required List<Msg> Msgs { get; init; }
}

public sealed record MsgStateEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required string Nonce { get; init; }
    public required string Id { get; init; }
    public required byte State { get; init; }
}

public sealed record EditedEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required string Id { get; init; }
    public required string Content { get; init; }
    public required long EditedAt { get; init; }
}

public sealed record DeletedEvent : UiEvent
{
    public required string ChannelId { get; init; }
    public required string Id { get; init; }
}

public sealed record PresenceEvent : UiEvent
{
    public required string ServerId { get; init; }
    public required Presence Presence { get; init; }
}

public sealed record MediaPresenceEvent : UiEvent { public required MediaPresence Media { get; init; } }

/// <summary>Your voice connection.</summary>
public sealed record VoiceEvent : UiEvent
{
    public required string? ChannelId { get; init; }
    public required string State { get; init; }
    public required bool Muted { get; init; }
    public required bool Deafened { get; init; }
    public required string? Detail { get; init; }
}

public sealed record SpeakingEvent : UiEvent { public required List<string> UserIds { get; init; } }

/// <summary>Open this channel (a notification was clicked).</summary>
public sealed record OpenChannelEvent : UiEvent { public required string ChannelId { get; init; } }

/// <summary>A message to show the user (errors, and some confirmations).</summary>
public sealed record ErrorEvent : UiEvent { public required string Message { get; init; } }

// ---------- command results ----------

public sealed record Config
{
    public required string Url { get; init; }
    public required bool TestOpenGames { get; init; }
}

public sealed record Page
{
    public required List<Msg> Msgs { get; init; }
    public required bool More { get; init; }
}

public sealed record GifResults
{
    public required bool Enabled { get; init; }
    public required List<Gif> Results { get; init; }
}

/// <summary>AOT-safe (source-generated) serialization for every model.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    AllowOutOfOrderMetadataProperties = true)]
[JsonSerializable(typeof(UiEvent))]
[JsonSerializable(typeof(List<UiEvent>))]
[JsonSerializable(typeof(List<Msg>))]
[JsonSerializable(typeof(List<User>))]
[JsonSerializable(typeof(Profile))]
[JsonSerializable(typeof(Attachment))]
[JsonSerializable(typeof(Config))]
[JsonSerializable(typeof(Page))]
[JsonSerializable(typeof(GifResults))]
public sealed partial class HopOnJson : JsonSerializerContext
{
    /// <summary>Parse one event (as delivered to a Subscribe handler).</summary>
    public static UiEvent? Event(JsonElement e) => e.Deserialize(Default.UiEvent);
}
