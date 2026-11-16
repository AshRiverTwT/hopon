// Who gets told about a message, and how (port of client/ui/src/notify.ts):
// an in-app banner while you're looking at HopOn, a Windows notification
// while it's in the background or tray. Each channel notifies for all
// messages, only @mentions, or nothing (synced prefs).

using System;
using System.Collections.Generic;
using System.Text.Json;

namespace HopOn.Native;

public enum NotifyKind { None, Banner, System }

public sealed record NotifyPrefs(bool SystemNotify, bool AppNotify, bool Sound, IReadOnlyDictionary<string, string> ChannelLevels)
{
    public static readonly NotifyPrefs Default = new(true, true, true, new Dictionary<string, string>());

    /// <summary>From the synced prefs JSON (prefs event); missing keys keep the defaults.</summary>
    public static NotifyPrefs FromJson(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            bool B(string k, bool d) => r.TryGetProperty(k, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : d;
            var levels = new Dictionary<string, string>();
            if (r.TryGetProperty("channelNotify", out var cn) && cn.ValueKind == JsonValueKind.Object)
                foreach (var p in cn.EnumerateObject())
                    if (p.Value.GetString() is "all" or "mentions" or "none") levels[p.Name] = p.Value.GetString()!;
            return new NotifyPrefs(B("systemNotify", true), B("appNotify", true), B("notifySound", true), levels);
        }
        catch (JsonException)
        {
            return Default;
        }
    }

    public string Level(string channelId) => ChannelLevels.TryGetValue(channelId, out var l) ? l : "all";
}

public sealed class Notifier
{
    /// <summary>Older than this is history (reconnect backfill), not news.</summary>
    public const long FreshMs = 60_000;
    readonly HashSet<string> seen = [];
    readonly Queue<string> order = new();

    /// <param name="looking">HopOn is focused and visible.</param>
    /// <param name="quiet">Do not disturb.</param>
    public (NotifyKind Kind, bool Mention) Decide(Msg m, string channelId, string? me, string? openChannel, bool looking, bool quiet, NotifyPrefs prefs, long nowMs)
    {
        if (me is null || quiet) return (NotifyKind.None, false);
        var level = prefs.Level(channelId);
        if (level == "none") return (NotifyKind.None, false);
        if (MessageMerge.IsPending(m.Id) || m.AuthorId == me || m.AuthorId == "0") return (NotifyKind.None, false);
        if (nowMs - (long)m.Ts > FreshMs || !seen.Add(m.Id)) return (NotifyKind.None, false);
        order.Enqueue(m.Id);
        if (order.Count > 500) seen.Remove(order.Dequeue());
        var mention = Rich.MentionsUser(m.Content, me);
        if (level == "mentions" && !mention) return (NotifyKind.None, mention);
        if (looking && channelId == openChannel) return (NotifyKind.None, mention);
        if (looking) return (prefs.AppNotify ? NotifyKind.Banner : NotifyKind.None, mention);
        return (prefs.SystemNotify ? NotifyKind.System : NotifyKind.None, mention);
    }
}
