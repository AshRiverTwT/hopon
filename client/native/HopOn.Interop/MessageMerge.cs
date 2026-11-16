// The open channel's message list, merged in place (C# port of
// client/ui/src/merge.ts; same rules, same tests in HopOn.Interop.Tests).
//
// The list is sorted by ID ascending, with pending local copies (id
// "p<nonce>") at the end. In place matters: the UI list is virtualized, and
// replacing the collection would reset scroll position and re-create rows.

using System;
using System.Collections.Generic;

namespace HopOn.Native;

/// <summary>A row of the message list (the UI's view model implements it).</summary>
public interface IMessageItem
{
    string Id { get; }
    string Nonce { get; }
    byte State { get; }
    /// <summary>Take the server's copy (content, id, edits, reactions...); <paramref name="state"/> is already the max.</summary>
    void Update(Msg m, byte state);
    /// <summary>Delivery state changed; <paramref name="id"/> is the server id once assigned.</summary>
    void SetState(string id, byte state);
}

public static class MessageMerge
{
    /// <summary>Compare decimal ID strings numerically without parsing.</summary>
    public static int CmpId(string a, string b) =>
        a.Length != b.Length ? a.Length - b.Length : string.CompareOrdinal(a, b);

    public static bool IsPending(string id) => id.StartsWith('p');

    /// <summary>Count of confirmed (non-pending) items: they come first.</summary>
    static int Confirmed<T>(IList<T> list) where T : IMessageItem
    {
        var n = list.Count;
        while (n > 0 && IsPending(list[n - 1].Id)) n--;
        return n;
    }

    /// <summary>Index of the confirmed message with this id, or ~insertionPoint.</summary>
    static int Find<T>(IList<T> list, int confirmed, string id) where T : IMessageItem
    {
        int lo = 0, hi = confirmed - 1;
        while (lo <= hi)
        {
            var mid = (lo + hi) >> 1;
            var c = CmpId(list[mid].Id, id);
            if (c == 0) return mid;
            if (c < 0) lo = mid + 1; else hi = mid - 1;
        }
        return ~lo;
    }

    /// <summary>Index of a message by id (confirmed or pending), or -1.</summary>
    public static int IndexOf<T>(IList<T> list, string id) where T : IMessageItem
    {
        if (IsPending(id))
        {
            for (var i = list.Count - 1; i >= 0 && IsPending(list[i].Id); i--)
                if (list[i].Id == id) return i;
            return -1;
        }
        var f = Find(list, Confirmed(list), id);
        return f >= 0 ? f : -1;
    }

    static int PendingWithNonce<T>(IList<T> list, string nonce) where T : IMessageItem
    {
        if (nonce.Length == 0) return -1;
        for (var i = list.Count - 1; i >= 0 && IsPending(list[i].Id); i--)
            if (list[i].Nonce == nonce) return i;
        return -1;
    }

    /// <summary>
    /// Merge incoming messages into <paramref name="list"/>. Returns the keys that
    /// changed (for paint instrumentation: perf_painted).
    /// </summary>
    public static List<string> Merge<T>(IList<T> list, IReadOnlyList<Msg> incoming, Func<Msg, T> create) where T : IMessageItem
    {
        var changed = new List<string>(incoming.Count);
        foreach (var m in incoming)
        {
            if (IsPending(m.Id))
            {
                if (PendingWithNonce(list, m.Nonce) < 0) list.Add(create(m));
                changed.Add(m.Id);
                continue;
            }
            var confirmed = Confirmed(list);
            var pi = PendingWithNonce(list, m.Nonce);
            var f = Find(list, confirmed, m.Id);
            if (f >= 0)
            {
                // Keep the higher delivery state (the durable ack may have come first).
                list[f].Update(m, Math.Max(m.State, list[f].State));
                if (pi >= 0) list.RemoveAt(pi);
            }
            else
            {
                var at = ~f;
                if (pi >= 0 && at == confirmed && pi == confirmed)
                {
                    // Our own message confirmed where its pending copy already sits:
                    // update the row instead of removing and re-adding it.
                    list[pi].Update(m, Math.Max(m.State, list[pi].State));
                }
                else
                {
                    if (pi >= 0) list.RemoveAt(pi);
                    list.Insert(at, create(m));
                }
            }
            changed.Add(m.Id);
        }
        return changed;
    }

    /// <summary>
    /// A send's delivery state changed (msgState event). A pending copy takes its
    /// server id once the server has assigned one. Returns false if no row matched.
    /// </summary>
    public static bool ApplyState<T>(IList<T> list, string nonce, string id, byte state) where T : IMessageItem
    {
        var pi = PendingWithNonce(list, nonce);
        if (pi >= 0)
        {
            var item = list[pi];
            var newState = Math.Max(state, item.State);
            if (string.IsNullOrEmpty(id) || IsPending(id))
            {
                item.SetState(item.Id, newState);
                return true;
            }
            var confirmed = Confirmed(list);
            var f = Find(list, confirmed, id);
            if (f >= 0)
            {
                // The server copy already arrived: drop the pending one.
                list.RemoveAt(pi);
                return true;
            }
            item.SetState(id, newState);
            if (~f != pi)
            {
                // Only if others landed after it: move into the sorted part.
                list.RemoveAt(pi);
                list.Insert(~f, item);
            }
            return true;
        }
        var i = IndexOf(list, id);
        if (i < 0) return false;
        if (state > list[i].State) list[i].SetState(id, state);
        return true;
    }

    /// <summary>Drop from the top so the list never holds more than <paramref name="cap"/>.</summary>
    public static void TrimTop<T>(IList<T> list, int cap)
    {
        while (list.Count > cap) list.RemoveAt(0);
    }

    /// <summary>Group header shown when the author changes or 7 minutes pass.</summary>
    public static bool ShowsHeader(string? prevAuthor, ulong prevTs, string author, ulong ts) =>
        prevAuthor is null || prevAuthor != author || ts - prevTs > 7 * 60_000;
}
