// The C# rich-text port must match client/ui/src/rich.ts exactly on the
// corpus it generated (client/ui/test/rich-corpus.mjs).

using System.Text.Json;
using System.Text.Json.Nodes;
using HopOn.Native;

static class RichTests
{
    static JsonNode ToJson(RichNode n) => n switch
    {
        RichText t => new JsonObject { ["t"] = "text", ["v"] = t.V },
        RichCode c => new JsonObject { ["t"] = "code", ["v"] = c.V },
        RichPre p => new JsonObject { ["t"] = "pre", ["v"] = p.V },
        RichStyled s => new JsonObject { ["t"] = s.Kind.ToString(), ["c"] = new JsonArray(s.C.Select(ToJson).ToArray()) },
        RichLink l => new JsonObject { ["t"] = "link", ["href"] = l.Href, ["v"] = l.V },
        RichMention m => new JsonObject { ["t"] = "mention", ["id"] = m.Id },
        _ => throw new InvalidOperationException(),
    };

    public static void Run(Action<bool, string> check)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "fixtures", "rich.json");
        using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = doc.RootElement;

        int total = 0, bad = 0;
        foreach (var c in root.GetProperty("parse").EnumerateArray())
        {
            total++;
            var input = c.GetProperty("input").GetString()!;
            var mine = JsonSerializer.SerializeToElement(new JsonArray(Rich.Parse(input).Select(ToJson).ToArray()), HopOnJsonTest.Default.JsonNode);
            if (!JsonElement.DeepEquals(mine, c.GetProperty("nodes")))
            {
                if (++bad <= 5) Console.WriteLine($"  parse mismatch for {JsonSerializer.Serialize(input, HopOnJsonTest.Default.String)}:\n    js: {c.GetProperty("nodes").GetRawText()}\n    c#: {mine.GetRawText()}");
            }
        }
        check(bad == 0, $"Rich.Parse matches rich.ts on {total} inputs ({bad} differ)");

        var enc = root.GetProperty("encodeMentions");
        var members = enc.GetProperty("members").EnumerateArray().Select(m => (m.GetProperty("id").GetString()!, m.GetProperty("name").GetString()!)).ToList();
        bad = 0;
        foreach (var c in enc.GetProperty("cases").EnumerateArray())
        {
            var got = Rich.EncodeMentions(c.GetProperty("input").GetString()!, members);
            if (got != c.GetProperty("output").GetString())
            {
                bad++;
                Console.WriteLine($"  encode mismatch: {c.GetProperty("input")}\n    js: {c.GetProperty("output")}\n    c#: {got}");
            }
        }
        check(bad == 0, "EncodeMentions matches rich.ts");

        var dec = root.GetProperty("decodeMentions");
        var names = dec.GetProperty("names").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!);
        bad = 0;
        foreach (var c in dec.GetProperty("cases").EnumerateArray())
        {
            var got = Rich.DecodeMentions(c.GetProperty("input").GetString()!, id => names.GetValueOrDefault(id, "unknown"));
            if (got != c.GetProperty("output").GetString()) { bad++; Console.WriteLine($"  decode mismatch: {c.GetProperty("input")} -> {got}"); }
        }
        check(bad == 0, "DecodeMentions matches rich.ts");
        check(Rich.MentionsUser("hi <@3>", "3") && !Rich.MentionsUser("hi <@3>", "4"), "MentionsUser");
    }
}

[System.Text.Json.Serialization.JsonSerializable(typeof(JsonNode))]
[System.Text.Json.Serialization.JsonSerializable(typeof(string))]
partial class HopOnJsonTest : System.Text.Json.Serialization.JsonSerializerContext;
