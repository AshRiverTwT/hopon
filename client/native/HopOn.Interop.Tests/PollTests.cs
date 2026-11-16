using HopOn.Native;

static class PollTests
{
    public static void Run(Action<bool, string> check)
    {
        var p = new Poll("Which game?", ["Chess", "Wordle"]);
        var d = Polls.Decode(Polls.Encode(p));
        check(d is not null && d.Question == p.Question && d.Options.SequenceEqual(p.Options), "polls round-trip as ordinary message text");
        check(Polls.Decode("hello") is null, "plain text is not a poll");
        check(Polls.Decode("\u001fhopon-poll:{bad json") is null, "bad JSON renders as text");
        check(Polls.Decode(Polls.Encode(new Poll("One choice", ["Only"]))) is null, "one option is not a poll");
        check(Polls.Decode(Polls.Encode(new Poll("Six", ["1", "2", "3", "4", "5", "6"]))) is null, "six options is not a poll");
        check(Polls.Decode("\u001fhopon-poll:{\"question\":1,\"options\":[\"a\",\"b\"]}") is null, "question must be a string");
        check(Polls.Decode("\u001fhopon-poll:{\"question\":\"q\",\"options\":[\"a\",2]}") is null, "options must be strings");
        // The webview's encoding (JSON.stringify) decodes here.
        check(Polls.Decode("\u001fhopon-poll:{\"question\":\"Pizza or tacos?\",\"options\":[\"Pizza\",\"Tacos\"]}")?.Options.Count == 2, "decodes the webview's polls");

        var rs = new List<Reaction>();
        check(Reactions.Apply(rs, "👍", "1", true) && rs.Count == 1, "reaction added");
        check(!Reactions.Apply(rs, "👍", "1", true) && rs[0].Users.Count == 1, "same user twice: no change");
        Reactions.Apply(rs, "👍", "2", true);
        check(Reactions.Apply(rs, "👍", "1", false) && rs[0].Users.SequenceEqual(["2"]), "reaction removed");
        Reactions.Apply(rs, "👍", "2", false);
        check(rs.Count == 0, "last user removed: the reaction goes");
        check(!Reactions.Apply(rs, "🔥", "1", false), "removing a missing reaction: no change");
    }
}
