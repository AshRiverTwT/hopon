using HopOn.Native;

static class NotifyTests
{
    static Msg M(string id, string author = "2", string content = "hi", long ts = 1_000_000) => new()
    {
        Id = id, ChannelId = "c", AuthorId = author, Content = content, EditedAt = null, Ts = (ulong)ts, Nonce = "",
        State = 2, ReplyTo = null, Reactions = [], Attachments = [],
    };

    public static void Run(Action<bool, string> check)
    {
        var p = NotifyPrefs.Default;
        const long now = 1_000_500;
        var n = new Notifier();
        check(n.Decide(M("1"), "c", "1", "other", looking: false, quiet: false, p, now).Kind == NotifyKind.System, "background: Windows notification");
        check(n.Decide(M("1"), "c", "1", "other", false, false, p, now).Kind == NotifyKind.None, "the same message only once");
        check(n.Decide(M("2"), "c", "1", "other", looking: true, false, p, now).Kind == NotifyKind.Banner, "looking at another channel: banner");
        check(n.Decide(M("3"), "c", "1", "c", looking: true, false, p, now).Kind == NotifyKind.None, "looking at this channel: nothing");
        check(n.Decide(M("4", author: "1"), "c", "1", "x", false, false, p, now).Kind == NotifyKind.None, "own messages: nothing");
        check(n.Decide(M("5", author: "0"), "c", "1", "x", false, false, p, now).Kind == NotifyKind.None, "server welcomes: nothing");
        check(n.Decide(M("p6"), "c", "1", "x", false, false, p, now).Kind == NotifyKind.None, "pending copies: nothing");
        check(n.Decide(M("7", ts: now - 61_000), "c", "1", "x", false, false, p, now).Kind == NotifyKind.None, "old (backfill) messages: nothing");
        check(n.Decide(M("8"), "c", "1", "x", false, quiet: true, p, now).Kind == NotifyKind.None, "do not disturb: nothing");

        var prefs = NotifyPrefs.FromJson("{\"systemNotify\":false,\"appNotify\":true,\"channelNotify\":{\"m\":\"mentions\",\"z\":\"none\",\"bad\":\"loud\"}}");
        check(!prefs.SystemNotify && prefs.AppNotify && prefs.Sound, "prefs JSON (missing keys keep defaults)");
        check(prefs.Level("m") == "mentions" && prefs.Level("z") == "none" && prefs.Level("bad") == "all" && prefs.Level("other") == "all", "channel levels");
        check(n.Decide(M("9"), "m", "1", "x", true, false, prefs, now).Kind == NotifyKind.None, "mentions-only channel: plain message ignored");
        var r = n.Decide(M("10", content: "hey <@1>"), "m", "1", "x", true, false, prefs, now);
        check(r.Kind == NotifyKind.Banner && r.Mention, "mentions-only channel: a mention gets through");
        check(n.Decide(M("11"), "z", "1", "x", false, false, prefs, now).Kind == NotifyKind.None, "muted channel: nothing");
        check(n.Decide(M("12"), "c", "1", "x", false, false, prefs, now).Kind == NotifyKind.None, "system notifications off");
        check(NotifyPrefs.FromJson("not json") == NotifyPrefs.Default, "bad prefs JSON → defaults");
    }
}
