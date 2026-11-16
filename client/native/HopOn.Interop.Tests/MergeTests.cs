// Port of client/ui/test/merge.test.mjs, plus the in-place cases the native
// list depends on.

using System.Collections.ObjectModel;
using System.Diagnostics;
using HopOn.Native;

sealed class Item(Msg m) : IMessageItem
{
    public string Id { get; private set; } = m.Id;
    public string Nonce { get; } = m.Nonce;
    public byte State { get; private set; } = m.State;
    public string Content { get; private set; } = m.Content;
    public int Updates;
    public void Update(Msg x, byte state) { Id = x.Id; Content = x.Content; State = state; Updates++; }
    public void SetState(string id, byte state) { Id = id; State = state; Updates++; }
}

static class MergeTests
{
    static Msg M(string id, string nonce = "", byte state = 2, string? content = null, ulong ts = 0, string author = "a") => new()
    {
        Id = id, ChannelId = "1", AuthorId = author, Content = content ?? id, EditedAt = null, Ts = ts, Nonce = nonce,
        State = state, ReplyTo = null, Reactions = [], Attachments = [],
    };

    static List<string> Ids(IEnumerable<Item> l) => l.Select(x => x.Id).ToList();

    public static void Run(Action<bool, string> check)
    {
        var list = new ObservableCollection<Item>();
        MessageMerge.Merge(list, [M("10"), M("12")], m => new Item(m));
        MessageMerge.Merge(list, [M("11"), M("12", content: "x"), M("9")], m => new Item(m));
        check(Ids(list).SequenceEqual(["9", "10", "11", "12"]), "append, insert, dedupe: order");
        check(list[3].Content == "x", "dedupe updates content");
        check(MessageMerge.IndexOf(list, "11") == 2 && MessageMerge.IndexOf(list, "13") == -1, "IndexOf");

        list = [];
        MessageMerge.Merge(list, [M("100"), M("99"), M("1000")], m => new Item(m));
        check(Ids(list).SequenceEqual(["99", "100", "1000"]), "numeric ordering of decimal ids of different length");

        list = [];
        MessageMerge.Merge(list, [M("5")], m => new Item(m));
        MessageMerge.Merge(list, [M("p77", nonce: "77", state: 0)], m => new Item(m));
        check(Ids(list).SequenceEqual(["5", "p77"]), "pending sits at the end");
        var pendingRow = list[1];
        MessageMerge.Merge(list, [M("6"), M("8", nonce: "77", state: 1)], m => new Item(m));
        check(Ids(list).SequenceEqual(["5", "6", "8"]), "pending replaced by server copy with the same nonce");

        list = [];
        MessageMerge.Merge(list, [M("5"), M("p77", nonce: "77", state: 0)], m => new Item(m));
        pendingRow = list[1];
        MessageMerge.Merge(list, [M("8", nonce: "77", state: 1)], m => new Item(m));
        check(ReferenceEquals(list[1], pendingRow) && list[1].Id == "8", "confirmed in place: the pending row object is reused");

        list = [];
        MessageMerge.Merge(list, [M("8", state: 2)], m => new Item(m));
        MessageMerge.Merge(list, [M("8", state: 1)], m => new Item(m));
        check(list[0].State == 2, "state never goes backwards");

        // msgState: pending → server id and durable, in place.
        list = [];
        MessageMerge.Merge(list, [M("5"), M("p9", nonce: "9", state: 0)], m => new Item(m));
        var row = list[1];
        check(MessageMerge.ApplyState(list, "9", "6", 1), "msgState matched by nonce");
        check(ReferenceEquals(list[1], row) && row.Id == "6" && row.State == 1, "msgState gives the pending row its id");
        MessageMerge.ApplyState(list, "9", "6", 2);
        check(row.State == 2, "msgState: durable");
        MessageMerge.ApplyState(list, "9", "6", 1);
        check(row.State == 2, "msgState never goes backwards");
        // Server copy then a late msgState: no duplicate.
        MessageMerge.Merge(list, [M("p10", nonce: "10", state: 0)], m => new Item(m));
        MessageMerge.Merge(list, [M("7", nonce: "10", state: 1)], m => new Item(m));
        MessageMerge.ApplyState(list, "10", "7", 2);
        check(Ids(list).SequenceEqual(["5", "6", "7"]) && list[2].State == 2, "late msgState after the server copy");
        // msgState arriving after someone else's later message: re-sorted.
        MessageMerge.Merge(list, [M("p11", nonce: "11", state: 0)], m => new Item(m));
        MessageMerge.Merge(list, [M("9")], m => new Item(m));
        MessageMerge.ApplyState(list, "11", "8", 2);
        check(Ids(list).SequenceEqual(["5", "6", "7", "8", "9"]), "msgState re-sorts when others landed first");
        check(!MessageMerge.ApplyState(list, "404", "404", 2), "msgState with no match");

        check(MessageMerge.ShowsHeader(null, 0, "a", 0), "header: first");
        check(!MessageMerge.ShowsHeader("a", 0, "a", 1000), "header: same author soon after");
        check(MessageMerge.ShowsHeader("a", 0, "a", 10 * 60_000), "header: 7 minutes later");
        check(MessageMerge.ShowsHeader("a", 0, "b", 1000), "header: other author");

        var inv = System.Globalization.CultureInfo.InvariantCulture;
        var today = new DateOnly(2026, 11, 16);
        check(MessageMerge.DayLabel(today, today) == "Today" && MessageMerge.DayLabel(today.AddDays(-1), today) == "Yesterday", "day labels: today, yesterday");
        check(MessageMerge.DayLabel(new DateOnly(2026, 3, 2), today, inv) == "Monday, 2 March", "day label this year");
        check(MessageMerge.DayLabel(new DateOnly(2025, 3, 2), today, inv) == "Sunday, 2 March 2025", "day label other year");
        check(MessageMerge.Day(1763251200000, TimeZoneInfo.Utc) == new DateOnly(2025, 11, 16), "Unix ms → local day");
        var fl = new ObservableCollection<Item>();
        MessageMerge.Merge(fl, [M("5", author: "a"), M("6", author: "me"), M("7", author: "b"), M("p9", nonce: "9", state: 0)], m => new Item(m));
        var authors = new Dictionary<string, string> { ["5"] = "a", ["6"] = "me", ["7"] = "b", ["p9"] = "me" };
        check(MessageMerge.FirstNew(fl, "5", "me", x => authors[x.Id]) == "7", "first new skips your own messages");
        check(MessageMerge.FirstNew(fl, "7", "me", x => authors[x.Id]) is null, "nothing new after the last message");
        check(MessageMerge.FirstNew(fl, null, "me", x => authors[x.Id]) is null, "no read marker: no divider");

        var big = new ObservableCollection<Item>();
        MessageMerge.Merge(big, Enumerable.Range(1, 5000).Select(i => M((i * 2).ToString())).ToList(), m => new Item(m));
        var sw = Stopwatch.StartNew();
        for (var i = 0; i < 200; i++) MessageMerge.Merge(big, [M((10001 + i * 2).ToString()), M((i * 2 + 1).ToString())], m => new Item(m));
        check(big.Count == 5400 && sw.ElapsedMilliseconds < 500, $"merging into 5000 messages is fast ({sw.ElapsedMilliseconds} ms for 400)");
        MessageMerge.TrimTop(big, 300);
        check(big.Count == 300 && big[^1].Id == "10399", "TrimTop keeps the newest");
    }
}
