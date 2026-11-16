using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Dispatching;

namespace HopOn.App;

public enum View { Splash, Login, Shell }

/// <summary>
/// App state, on the UI thread. Core events are queued from worker threads
/// and applied in one batch per dispatcher turn (like the webview's per-frame
/// flush), then the changed message keys are stamped as painted.
/// </summary>
public sealed partial class Store
{
    const int OpenCap = 300;

    readonly DispatcherQueue ui;
    readonly HopOnCore core;
    readonly ConcurrentQueue<UiEvent> queue = new();
    int scheduled;

    readonly Dictionary<string, User> users = [];
    readonly Dictionary<string, ServerVm> serverById = [];

    public ObservableCollection<ServerVm> Servers { get; } = [];
    public ObservableCollection<ChannelVm> Channels { get; } = [];
    public ObservableCollection<MessageVm> Messages { get; } = [];

    public View View { get; private set; } = View.Splash;
    public User? Me { get; private set; }
    public string ConnState { get; private set; } = "connecting";
    public ServerVm? OpenServer { get; private set; }
    public ChannelVm? OpenChannel { get; private set; }

    /// <summary>The view, server list, channel list or header changed.</summary>
    public event Action? Changed;
    /// <summary>A message to show briefly.</summary>
    public event Action<string>? Toast;
    /// <summary>Messages were added at the end (scroll to it if the user is at the bottom).</summary>
    public event Action? Appended;
    /// <summary>Keys of messages changed in this batch (for perf_painted).</summary>
    public event Action<List<string>>? Painted;

    public Store(DispatcherQueue ui, HopOnCore core)
    {
        this.ui = ui;
        this.core = core;
    }

    /// <summary>From any thread.</summary>
    public void Enqueue(UiEvent e)
    {
        queue.Enqueue(e);
        if (Interlocked.Exchange(ref scheduled, 1) == 0) ui.TryEnqueue(DispatcherQueuePriority.High, Flush);
    }

    void Flush()
    {
        Interlocked.Exchange(ref scheduled, 0);
        var painted = new List<string>();
        var changed = false;
        var appended = false;
        while (queue.TryDequeue(out var e)) Apply(e, painted, ref changed, ref appended);
        if (changed) Changed?.Invoke();
        if (appended) Appended?.Invoke();
        if (painted.Count > 0) Painted?.Invoke(painted);
    }

    string NameOf(string userId) =>
        userId == "0" ? "HopOn" : users.TryGetValue(userId, out var u) ? u.Name : "…";

    MessageVm Row(Msg m) => new(m, NameOf(m.AuthorId));

    void Apply(UiEvent e, List<string> painted, ref bool changed, ref bool appended)
    {
        switch (e)
        {
            case ConnEvent c:
                ConnState = c.State;
                changed = true;
                break;
            case SessionEvent s:
                ApplySession(s);
                changed = true;
                break;
            case ServerEvent s:
                UpsertServer(s.Server);
                changed = true;
                break;
            case ChannelCreatedEvent c:
                if (serverById.TryGetValue(c.Channel.ServerId, out var sv))
                {
                    sv.Channels.Add(c.Channel);
                    if (OpenServer == sv) Channels.Add(ChannelRow(c.Channel));
                }
                break;
            case ChannelDeletedEvent c:
                if (serverById.TryGetValue(c.ServerId, out var sd))
                {
                    sd.Channels.RemoveAll(x => x.Id == c.ChannelId);
                    if (OpenServer == sd)
                    {
                        var row = Channels.FirstOrDefault(x => x.Id == c.ChannelId);
                        if (row is not null) Channels.Remove(row);
                    }
                    if (OpenChannel?.Id == c.ChannelId) _ = SelectServer(sd);
                }
                break;
            case ServerRemovedEvent r:
                if (serverById.Remove(r.ServerId, out var gone))
                {
                    Servers.Remove(gone);
                    if (OpenServer == gone) _ = SelectServer(Servers.FirstOrDefault());
                    Toast?.Invoke(r.Reason == "kicked" ? $"You were removed from {gone.Name}" : r.Reason == "deleted" ? $"{gone.Name} was deleted" : $"You left {gone.Name}");
                }
                changed = true;
                break;
            case UserUpdatedEvent u:
                users[u.User.Id] = u.User;
                RefreshAuthors(u.User.Id);
                break;
            case MemberJoinedEvent m:
                users[m.User.Id] = m.User;
                break;
            case MemberPageEvent p:
                foreach (var u in p.Users) users[u.Id] = u;
                break;
            case ChannelActivityEvent a:
                if (a.ChannelId != OpenChannel?.Id)
                {
                    var row = Channels.FirstOrDefault(x => x.Id == a.ChannelId);
                    if (row is not null) row.Unread = true;
                }
                break;
            case MessagesEvent m when m.ChannelId == OpenChannel?.Id:
            {
                var before = Messages.Count > 0 ? Messages[^1] : null;
                painted.AddRange(MessageMerge.Merge(Messages, m.Msgs, Row));
                MessageMerge.TrimTop(Messages, OpenCap);
                RefreshHeaders();
                appended |= Messages.Count > 0 && Messages[^1] != before;
                break;
            }
            case MsgStateEvent s when s.ChannelId == OpenChannel?.Id:
                MessageMerge.ApplyState(Messages, s.Nonce, s.Id, s.State);
                break;
            case EditedEvent ed when ed.ChannelId == OpenChannel?.Id:
            {
                var i = MessageMerge.IndexOf(Messages, ed.Id);
                if (i >= 0) Messages[i].Edit(ed.Content, ed.EditedAt);
                painted.Add(ed.Id);
                break;
            }
            case DeletedEvent d when d.ChannelId == OpenChannel?.Id:
            {
                var i = MessageMerge.IndexOf(Messages, d.Id);
                if (i >= 0) { Messages.RemoveAt(i); RefreshHeaders(); }
                break;
            }
            case OpenChannelEvent o:
                _ = OpenChannelById(o.ChannelId);
                break;
            case ErrorEvent err:
                Toast?.Invoke(err.Message);
                break;
            default:
                // Reactions, presence, voice, typing, friends...: later phases.
                break;
        }
    }

    void ApplySession(SessionEvent s)
    {
        foreach (var u in s.Users) users[u.Id] = u;
        if (s.User is not null) users[s.User.Id] = s.User;
        Me = s.User;
        View = s.User is not null ? View.Shell : s.AuthPending ? View.Splash : View.Login;
        if (s.User is null)
        {
            Servers.Clear();
            serverById.Clear();
            Channels.Clear();
            Messages.Clear();
            OpenServer = null;
            OpenChannel = null;
            return;
        }
        var keep = new HashSet<string>();
        foreach (var sv in s.Servers.Where(x => x.DmWith is null))
        {
            UpsertServer(sv);
            keep.Add(sv.Id);
        }
        foreach (var gone in Servers.Where(x => !keep.Contains(x.Id)).ToList())
        {
            Servers.Remove(gone);
            serverById.Remove(gone.Id);
        }
        if (OpenServer is null || !serverById.ContainsKey(OpenServer.Id)) _ = SelectServer(Servers.FirstOrDefault());
    }

    void UpsertServer(Server s)
    {
        if (s.DmWith is not null) return;
        if (!serverById.TryGetValue(s.Id, out var vm))
        {
            vm = new ServerVm { Id = s.Id };
            serverById[s.Id] = vm;
            Servers.Add(vm);
        }
        vm.Name = s.Name;
        vm.Channels = s.Channels;
        if (OpenServer == vm) SyncChannels(vm, s);
        else if (OpenServer is null && View == View.Shell) _ = SelectServer(vm);
    }

    ChannelVm ChannelRow(Channel c) => new() { Id = c.Id, Voice = c.Voice, Name = c.Name, Topic = c.Topic };

    void SyncChannels(ServerVm vm, Server? s = null)
    {
        Channels.Clear();
        foreach (var c in vm.Channels)
        {
            var row = ChannelRow(c);
            if (s is not null && s.Reads.TryGetValue(c.Id, out var read) && MessageMerge.CmpId(c.LastId, read) > 0) row.Unread = true;
            Channels.Add(row);
        }
        if (OpenChannel is not null) OpenChannel = Channels.FirstOrDefault(x => x.Id == OpenChannel.Id) ?? OpenChannel;
    }

    void RefreshHeaders()
    {
        for (var i = 0; i < Messages.Count; i++)
        {
            var prev = i > 0 ? Messages[i - 1] : null;
            var m = Messages[i];
            m.Header = MessageMerge.ShowsHeader(prev?.AuthorId, prev?.Ts ?? 0, m.AuthorId, m.Ts);
        }
    }

    void RefreshAuthors(string userId)
    {
        var name = NameOf(userId);
        foreach (var m in Messages)
            if (m.AuthorId == userId) m.Author = name;
    }

    // ---------- user actions ----------

    public async Task SelectServer(ServerVm? vm)
    {
        OpenServer = vm;
        Channels.Clear();
        if (vm is null)
        {
            OpenChannel = null;
            Messages.Clear();
            Changed?.Invoke();
            return;
        }
        SyncChannels(vm);
        Changed?.Invoke();
        _ = Try(core.CallAsync("ui_set_context", new JsonObject { ["serverId"] = vm.Id }));
        _ = Try(core.CallAsync("games_server", new JsonObject { ["serverId"] = vm.Id }));
        var first = Channels.FirstOrDefault(c => !c.Voice);
        if (first is not null) await OpenChannelRow(first);
    }

    async Task OpenChannelById(string channelId)
    {
        var sv = Servers.FirstOrDefault(x => x.Channels.Any(c => c.Id == channelId));
        if (sv is null) return;
        if (OpenServer != sv)
        {
            OpenServer = sv;
            SyncChannels(sv);
        }
        var row = Channels.FirstOrDefault(c => c.Id == channelId);
        if (row is not null) await OpenChannelRow(row);
    }

    public async Task OpenChannelRow(ChannelVm row)
    {
        if (row.Voice) return; // voice rooms: a later phase
        OpenChannel = row;
        row.Unread = false;
        Messages.Clear();
        Changed?.Invoke();
        try
        {
            var msgs = await core.CallAsync("open_channel", HopOnJson.Default.ListMsg, new JsonObject { ["channelId"] = row.Id });
            if (OpenChannel != row) return; // switched away meanwhile
            var painted = MessageMerge.Merge(Messages, msgs, Row);
            MessageMerge.TrimTop(Messages, OpenCap);
            RefreshHeaders();
            Appended?.Invoke();
            Painted?.Invoke(painted);
            var last = Messages.LastOrDefault(m => !MessageMerge.IsPending(m.Id));
            if (last is not null) _ = Try(core.CallAsync("mark_read", new JsonObject { ["channelId"] = row.Id, ["messageId"] = last.Id }));
        }
        catch (HopOnException e)
        {
            Toast?.Invoke(e.Message);
        }
    }

    public void Send(string text, double tInputMs)
    {
        text = text.Trim();
        if (text.Length == 0 || OpenChannel is null || Me is null) return;
        var channelId = OpenChannel.Id;
        var nonce = RandomNonce();
        var pending = new Msg
        {
            Id = "p" + nonce, ChannelId = channelId, AuthorId = Me.Id, Content = text, EditedAt = null,
            Ts = (ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Nonce = nonce, State = 0,
            ReplyTo = null, Reactions = [], Attachments = [],
        };
        var painted = MessageMerge.Merge(Messages, [pending], Row);
        RefreshHeaders();
        Appended?.Invoke();
        Painted?.Invoke(painted);
        core.CallAsync("send_message", new JsonObject
        {
            ["channelId"] = channelId, ["content"] = text, ["nonce"] = nonce, ["tInputMs"] = tInputMs,
            ["replyTo"] = null, ["files"] = new JsonArray(), ["gifs"] = new JsonArray(),
        }).ContinueWith(t =>
        {
            if (!t.IsFaulted) return;
            var message = t.Exception?.InnerException?.Message ?? "send failed";
            ui.TryEnqueue(() =>
            {
                var i = MessageMerge.IndexOf(Messages, "p" + nonce);
                if (i >= 0) Messages[i].Failed();
                Toast?.Invoke(message);
            });
        }, TaskScheduler.Default);
    }

    public void Typing()
    {
        if (OpenChannel is null) return;
        var now = Environment.TickCount64;
        if (now - lastTyping < 3000) return;
        lastTyping = now;
        _ = Try(core.CallAsync("typing", new JsonObject { ["channelId"] = OpenChannel.Id }));
    }
    long lastTyping = -10_000;

    static string RandomNonce()
    {
        // Same range as the webview's (52 bits, non-zero), so either shell's nonces look alike.
        var v = (ulong)Random.Shared.NextInt64(1, 1L << 52);
        return v.ToString();
    }

    static async Task Try(Task t)
    {
        try { await t; }
        catch (HopOnException) { }
    }
}
