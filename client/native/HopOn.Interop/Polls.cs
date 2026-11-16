// Polls are ordinary messages: "\u001fhopon-poll:" + JSON {question, options}.
// Votes are reactions 1️⃣–5️⃣ (one per option), so they sync like reactions.
// Port of client/ui/src/polls.ts.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace HopOn.Native;

public sealed record Poll(string Question, IReadOnlyList<string> Options);

public static class Polls
{
    const string Prefix = "\u001fhopon-poll:";
    public static readonly string[] Emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

    public static string Encode(Poll p) =>
        Prefix + new JsonObject { ["question"] = p.Question, ["options"] = new JsonArray(p.Options.Select(o => (JsonNode)o).ToArray()) }.ToJsonString();

    /// <summary>The poll in a message, or null if it isn't a (valid) poll: then it renders as text.</summary>
    public static Poll? Decode(string content)
    {
        if (!content.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        try
        {
            using var doc = JsonDocument.Parse(content.AsMemory(Prefix.Length));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("question", out var q) || q.ValueKind != JsonValueKind.String) return null;
            if (!root.TryGetProperty("options", out var o) || o.ValueKind != JsonValueKind.Array) return null;
            var n = o.GetArrayLength();
            if (n < 2 || n > 5 || o.EnumerateArray().Any(x => x.ValueKind != JsonValueKind.String)) return null;
            return new Poll(q.GetString()!, o.EnumerateArray().Select(x => x.GetString()!).ToList());
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

public static class Reactions
{
    /// <summary>Apply a reaction event (same rules as the webview store). Returns true if anything changed.</summary>
    public static bool Apply(List<Reaction> list, string emoji, string userId, bool add)
    {
        var i = list.FindIndex(r => r.Emoji == emoji);
        if (add)
        {
            if (i < 0) { list.Add(new Reaction { Emoji = emoji, Users = [userId] }); return true; }
            if (list[i].Users.Contains(userId)) return false;
            list[i].Users.Add(userId);
            return true;
        }
        if (i < 0 || !list[i].Users.Remove(userId)) return false;
        if (list[i].Users.Count == 0) list.RemoveAt(i);
        return true;
    }
}
