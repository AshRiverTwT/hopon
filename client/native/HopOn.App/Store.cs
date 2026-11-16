using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.Text.Json;
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
    public ObservableCollection<MemberVm> Members { get; } = [];
    /// <summary>Files chosen for the next message (uploaded as soon as they're picked).</summary>
    public ObservableCollection<PendingFileVm> PendingFiles { get; } = [];
    const int MaxFiles = 10;

    // Presence of people we can see (the core reports it for the open server's visible members).
    readonly HashSet<string> online = [];
    readonly Dictionary<string, string> activities = [];
    readonly Dictionary<string, Status> statuses = [];
    bool membersDirty;

    // Voice: who is in which room (user → presence), who's speaking, and your own connection.
    readonly Dictionary<string, Presence> voice = [];
    HashSet<string> speaking = [];
    bool voiceDirty;
    public VoiceEvent? MyVoice { get; private set; }

    public View View { get; private set; } = View.Splash;
    public User? Me { get; private set; }
    public string ConnState { get; private set; } = "connecting";
    public ServerVm? OpenServer { get; private set; }
    public ChannelVm? OpenChannel { get; private set; }
    /// <summary>The user is at the newest message (set by the window from the scroll position).</summary>
    public bool AtBottom { get; set; } = true;
    /// <summary>Older history exists above the first loaded message.</summary>
    public bool HasOlder { get; private set; }
    bool loadingOlder;

    /// <summary>The view, server list, channel list or header changed.</summary>
    public event Action? Changed;
    /// <summary>A message to show briefly.</summary>
    public event Action<string>? Toast;
    /// <summary>Messages were added at the end (scroll to it if the user is at the bottom).</summary>
    public event Action? Appended;
    /// <summary>The message being replied to / edited (composer banner).</summary>
    public MessageVm? Replying { get; private set; }
    public MessageVm? Editing { get; private set; }
    public event Action? ComposerModeChanged;
    public void CancelComposerMode() { Replying = null; Editing = null; ComposerModeChanged?.Invoke(); }

    /// <summary>(kind, title, body, channelId): show a banner or a Windows notification.</summary>
    public event Action<NotifyKind, string, string, string>? Notify;
    readonly Notifier notifier = new();
    NotifyPrefs notifyPrefs = NotifyPrefs.Default;
    /// <summary>The window is focused and visible (set by the window).</summary>
    public bool Looking { get; set; } = true;
    public Status? MyStatus { get; private set; }

    /// <summary>The "… is typing" line changed.</summary>
    public event Action<string>? TypingChanged;
    /// <summary>Keys of messages changed in this batch (for perf_painted).</summary>
    public event Action<List<string>>? Painted;

    public Store(DispatcherQueue ui, HopOnCore core)
    {
        this.ui = ui;
        this.core = core;
        RichView.NameOf = NameOf;
        PendingFileVm.RemoveAction = f => PendingFiles.Remove(f);
        MessageVm.ToggleReaction = (m, emoji, add) => _ = React(m, emoji, add);
        MessageVm.Act = (m, what) =>
        {
            switch (what)
            {
                case "reply": Replying = m; Editing = null; ComposerModeChanged?.Invoke(); break;
                case "edit" when m.IsMine && !MessageMerge.IsPending(m.Id): Editing = m; Replying = null; ComposerModeChanged?.Invoke(); break;
                case "delete" when m.IsMine && !MessageMerge.IsPending(m.Id): _ = DeleteMessage(m); break;
            }
        };
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
        if (membersDirty) RebuildMembers();
        if (voiceDirty) RefreshVoiceRows();
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
                membersDirty = true;
                break;
            case MemberJoinedEvent m:
                users[m.User.Id] = m.User;
                if (serverById.TryGetValue(m.ServerId, out var js)) js.MemberIds.Add(m.User.Id);
                membersDirty = true;
                break;
            case MemberPageEvent p:
                foreach (var u in p.Users) users[u.Id] = u;
                if (serverById.TryGetValue(p.ServerId, out var ps))
                    foreach (var u in p.Users) ps.MemberIds.Add(u.Id);
                foreach (var u in p.Users)
                {
                    if (p.Online.Contains(u.Id)) online.Add(u.Id); else online.Remove(u.Id);
                }
                foreach (var (k, v) in p.Activities) activities[k] = v;
                foreach (var (k, v) in p.Statuses) statuses[k] = v;
                membersDirty = true;
                break;
            case UserPresenceEvent up:
                if (up.Online) online.Add(up.UserId);
                else { online.Remove(up.UserId); statuses.Remove(up.UserId); activities.Remove(up.UserId); }
                membersDirty = true;
                break;
            case ActivityEvent act:
                if (act.Game.Length > 0) activities[act.UserId] = act.Game; else activities.Remove(act.UserId);
                membersDirty = true;
                break;
            case StatusEvent st:
                if (st.UserId == Me?.Id) MyStatus = st.Status;
                if (st.Status.Mode == "online" && st.Status.Text.Length == 0 && st.Status.Emoji.Length == 0) statuses.Remove(st.UserId);
                else statuses[st.UserId] = st.Status;
                membersDirty = true;
                break;
            case ChannelActivityEvent a:
                if (a.ChannelId != OpenChannel?.Id)
                {
                    var row = Channels.FirstOrDefault(x => x.Id == a.ChannelId);
                    if (row is not null) row.Unread = true;
                }
                break;
            case PrefsEvent pe:
                notifyPrefs = NotifyPrefs.FromJson(pe.Json);
                break;
            case IncomingMessageEvent im:
            {
                var (kind, _) = notifier.Decide(im.Msg, im.ChannelId, Me?.Id, OpenChannel?.Id, Looking,
                    quiet: MyStatus?.Mode == "dnd", notifyPrefs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (kind == NotifyKind.None) break;
                var inServer = Servers.FirstOrDefault(x => x.Channels.Any(c => c.Id == im.ChannelId));
                var ch = inServer?.Channels.First(c => c.Id == im.ChannelId);
                var where = ch is null ? "Direct message" : "#" + ch.Name;
                var author = NameOf(im.Msg.AuthorId);
                var title = kind == NotifyKind.System ? string.Join(" · ", new[] { author, where, inServer?.Name ?? "" }.Where(x => x.Length > 0)) : $"{author} · {where}";
                var body = Preview(new MessageVm(im.Msg, author));
                if (body.Length == 0 && im.Msg.Attachments.Count > 0) body = im.Msg.Attachments.Count == 1 ? "sent a file" : $"sent {im.Msg.Attachments.Count} files";
                Notify?.Invoke(kind, title, body, im.ChannelId);
                break;
            }
            case TypingEvent t when t.ChannelId == OpenChannel?.Id && t.UserId != Me?.Id:
                NoteTyping(t.UserId, true);
                break;
            case MessagesEvent m when m.ChannelId == OpenChannel?.Id:
            {
                // A message from someone ends their "typing".
                foreach (var msg in m.Msgs) NoteTyping(msg.AuthorId, false);
                var before = Messages.Count > 0 ? Messages[^1] : null;
                painted.AddRange(MessageMerge.Merge(Messages, m.Msgs, Row));
                // Bounded while following the conversation; scrolled-up history stays.
                if (AtBottom && Messages.Count > OpenCap)
                {
                    MessageMerge.TrimTop(Messages, OpenCap);
                    HasOlder = true;
                }
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
            case ReactionEvent r when r.ChannelId == OpenChannel?.Id:
            {
                var i = MessageMerge.IndexOf(Messages, r.MessageId);
                if (i >= 0 && Reactions.Apply(Messages[i].RawReactions, r.Emoji, r.UserId, r.Add)) Messages[i].RebuildReactions();
                break;
            }
            case PresenceEvent pr:
                if (pr.Presence.ChannelId is null) voice.Remove(pr.Presence.UserId);
                else voice[pr.Presence.UserId] = pr.Presence;
                voiceDirty = true;
                break;
            case SpeakingEvent sp:
                speaking = [.. sp.UserIds];
                voiceDirty = true;
                break;
            case VoiceEvent v:
                MyVoice = v;
                if (v.State == "idle") speaking.Clear();
                if (v.Detail is { Length: > 0 } detail) Toast?.Invoke(detail);
                voiceDirty = true;
                changed = true;
                _ = Try(core.CallAsync("ui_set_context", Context()));
                break;
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
        voice.Clear();
        foreach (var p in s.Voice) if (p.ChannelId is not null) voice[p.UserId] = p;
        voiceDirty = true;
        foreach (var u in s.Users) users[u.Id] = u;
        if (s.User is not null) users[s.User.Id] = s.User;
        Me = s.User;
        MessageVm.MeId = s.User?.Id;
        MyStatus = s.Status;
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
        foreach (var id in s.MemberIds) vm.MemberIds.Add(id);
        online.UnionWith(s.Online);
        foreach (var (k, v) in s.Activities) activities[k] = v;
        foreach (var (k, v) in s.Statuses) statuses[k] = v;
        membersDirty = true;
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
        RefreshVoiceRows();
    }

    public string Preview(MessageVm m)
    {
        var poll = Polls.Decode(m.Content);
        var text = poll is not null ? "Poll: " + poll.Question : Rich.DecodeMentions(m.Content, NameOf);
        text = string.Join(" ", text.Split((char[])['\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (text.Length == 0 && m.Attachments.Count > 0) text = "📎 " + m.Attachments[0].Name;
        return text.Length > 90 ? text[..89] + "…" : text;
    }

    void RefreshHeaders()
    {
        foreach (var m in Messages)
        {
            if (m.ReplyTo is null) { m.ReplyPreview = ""; continue; }
            var i = MessageMerge.IndexOf(Messages, m.ReplyTo);
            m.ReplyPreview = i >= 0 ? $"↪ {Messages[i].Author}: {Preview(Messages[i])}" : "↪ an earlier message";
        }
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

    // ---------- voice ----------

    JsonObject Context() => new()
    {
        ["serverId"] = OpenServer?.Id,
        ["joinedVoice"] = MyVoice is { State: not "idle" } v ? v.ChannelId : null,
        ["viewedVoice"] = null,
    };

    void RefreshVoiceRows()
    {
        voiceDirty = false;
        foreach (var row in Channels)
        {
            if (!row.Voice) continue;
            var names = voice.Values.Where(p => p.ChannelId == row.Id)
                .Select(p => (speaking.Contains(p.UserId) ? "● " : "") + NameOf(p.UserId) + (p.Deafened ? " (deafened)" : p.Muted ? " (muted)" : ""))
                .OrderBy(n => n, StringComparer.CurrentCultureIgnoreCase);
            row.Participants = string.Join("\n", names);
        }
    }

    public async Task JoinVoice(ChannelVm row)
    {
        if (!row.Voice) return;
        try { await core.CallAsync("voice_join", new JsonObject { ["channelId"] = row.Id }); }
        catch (HopOnException e) { Toast?.Invoke(e.Message); }
    }

    public async Task LeaveVoice()
    {
        try { await core.CallAsync("voice_leave"); }
        catch (HopOnException e) { Toast?.Invoke(e.Message); }
    }

    public async Task SetMuted(bool muted)
    {
        try { await core.CallAsync("voice_mute", new JsonObject { ["muted"] = muted }); }
        catch (HopOnException e) { Toast?.Invoke(e.Message); }
    }

    public async Task SetDeafened(bool deafened)
    {
        try { await core.CallAsync("voice_deafen", new JsonObject { ["deafened"] = deafened }); }
        catch (HopOnException e) { Toast?.Invoke(e.Message); }
    }

    // ---------- people column ----------

    const int VisibleMembers = 200;
    string lastVisible = "";

    void RebuildMembers()
    {
        membersDirty = false;
        var sv = OpenServer;
        var rows = sv is null ? [] : sv.MemberIds
            .Where(users.ContainsKey)
            .Select(id => (Id: id, Name: NameOf(id), Online: online.Contains(id) && statuses.GetValueOrDefault(id)?.Mode != "invisible"))
            .OrderByDescending(r => r.Online)
            .ThenBy(r => r.Name, StringComparer.CurrentCultureIgnoreCase)
            .Take(VisibleMembers)
            .ToList();
        // Update in place where possible (no flicker, rows keep their containers).
        for (var i = 0; i < rows.Count; i++)
        {
            var r = rows[i];
            MemberVm vm;
            if (i < Members.Count && Members[i].Id == r.Id) vm = Members[i];
            else
            {
                var at = -1;
                for (var j = i + 1; j < Members.Count; j++) if (Members[j].Id == r.Id) { at = j; break; }
                if (at >= 0) { vm = Members[at]; Members.Move(at, i); }
                else { vm = new MemberVm { Id = r.Id }; Members.Insert(i, vm); }
            }
            vm.Name = r.Name;
            vm.Online = r.Online;
            vm.Detail = activities.TryGetValue(r.Id, out var game) ? $"Playing {game}"
                : statuses.TryGetValue(r.Id, out var st) && st.Text.Length > 0 ? (st.Emoji + " " + st.Text).Trim()
                : "";
        }
        while (Members.Count > rows.Count) Members.RemoveAt(Members.Count - 1);
        // Tell the core whose presence to keep us posted on.
        var ids = string.Join(",", rows.Select(r => r.Id));
        if (ids != lastVisible && sv is not null)
        {
            lastVisible = ids;
            _ = Try(core.CallAsync("ui_set_visible_members", new JsonObject { ["userIds"] = new JsonArray(rows.Select(r => (JsonNode)r.Id).ToArray()) }));
        }
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
        RebuildMembers();
        Changed?.Invoke();
        _ = Try(core.CallAsync("ui_set_context", Context()));
        _ = Try(core.CallAsync("load_members", new JsonObject { ["serverId"] = vm.Id, ["offset"] = 0 }));
        _ = Try(core.CallAsync("games_server", new JsonObject { ["serverId"] = vm.Id }));
        var first = Channels.FirstOrDefault(c => !c.Voice);
        if (first is not null) await OpenChannelRow(first);
    }

    public async Task OpenChannelById(string channelId)
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
        typers.Clear();
        TypingChanged?.Invoke("");
        Replying = null;
        Editing = null;
        ComposerModeChanged?.Invoke();
        Messages.Clear();
        AtBottom = true;
        HasOlder = true;
        Changed?.Invoke();
        try
        {
            var msgs = await core.CallAsync("open_channel", HopOnJson.Default.ListMsg, new JsonObject { ["channelId"] = row.Id });
            if (OpenChannel != row) return; // switched away meanwhile
            var painted = MessageMerge.Merge(Messages, msgs, Row);
            MessageMerge.TrimTop(Messages, OpenCap);
            // The core keeps up to 300 recent messages per channel; fewer means
            // a short channel or a partial cache: load_older finds out.
            HasOlder = msgs.Count > 0;
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

    /// <summary>Add or remove your reaction (and poll vote): shown at once, sent to the server.</summary>
    async Task React(MessageVm m, string emoji, bool add)
    {
        if (Me is null || OpenChannel is null || MessageMerge.IsPending(m.Id)) return;
        if (Reactions.Apply(m.RawReactions, emoji, Me.Id, add)) m.RebuildReactions();
        try
        {
            await core.CallAsync("react", new JsonObject { ["channelId"] = OpenChannel.Id, ["messageId"] = m.Id, ["emoji"] = emoji, ["add"] = add });
        }
        catch (HopOnException e)
        {
            if (Reactions.Apply(m.RawReactions, emoji, Me.Id, !add)) m.RebuildReactions();
            Toast?.Invoke(e.Message);
        }
    }

    /// <summary>Scrolled near the top: fetch the page before the first message.</summary>
    public async Task LoadOlder()
    {
        var row = OpenChannel;
        if (row is null || loadingOlder || !HasOlder) return;
        var first = Messages.FirstOrDefault(m => !MessageMerge.IsPending(m.Id));
        if (first is null) return;
        loadingOlder = true;
        try
        {
            var page = await core.CallAsync("load_older", HopOnJson.Default.Page, new JsonObject { ["channelId"] = row.Id, ["before"] = first.Id });
            if (OpenChannel != row) return;
            MessageMerge.Merge(Messages, page.Msgs, Row);
            HasOlder = page.More;
            RefreshHeaders();
        }
        catch (HopOnException e)
        {
            Toast?.Invoke(e.Message);
        }
        finally
        {
            loadingOlder = false;
        }
    }

    async Task DeleteMessage(MessageVm m)
    {
        if (OpenChannel is null) return;
        try { await core.CallAsync("delete_message", new JsonObject { ["channelId"] = OpenChannel.Id, ["id"] = m.Id }); }
        catch (HopOnException e) { Toast?.Invoke(e.Message); }
    }

    async Task SaveEdit(MessageVm m, string text)
    {
        if (OpenChannel is null) return;
        if (text == m.Content) return;
        try { await core.CallAsync("edit_message", new JsonObject { ["channelId"] = OpenChannel.Id, ["id"] = m.Id, ["content"] = text }); }
        catch (HopOnException e) { Toast?.Invoke(e.Message); }
    }

    /// <summary>Upload a picked file right away; it's sent with the next message.</summary>
    public async Task AddFile(string name, byte[] data, uint w, uint h)
    {
        if (PendingFiles.Count >= MaxFiles) { Toast?.Invoke($"Up to {MaxFiles} files per message"); return; }
        var f = new PendingFileVm { Name = name };
        PendingFiles.Add(f);
        try
        {
            var att = await core.CallAsync("upload_file", new JsonObject { ["name"] = name, ["w"] = w, ["h"] = h }, data);
            f.Att = att.Deserialize(HopOnJson.Default.Attachment);
        }
        catch (HopOnException e)
        {
            f.Error = e.Message;
        }
    }

    public void Send(string text, double tInputMs)
    {
        text = text.Trim();
        if (PendingFiles.Any(f => f.Att is null && f.Error is null)) { Toast?.Invoke("Still uploading…"); return; }
        var files = PendingFiles.Where(f => f.Att is not null).Select(f => f.Att!).ToList();
        if ((text.Length == 0 && files.Count == 0) || OpenChannel is null || Me is null) return;
        if (Editing is { } editing && text.Length > 0)
        {
            Editing = null;
            ComposerModeChanged?.Invoke();
            _ = SaveEdit(editing, text);
            return;
        }
        var replyTo = Replying is { } r && !MessageMerge.IsPending(r.Id) ? r.Id : null;
        if (Replying is not null) { Replying = null; ComposerModeChanged?.Invoke(); }
        var channelId = OpenChannel.Id;
        var nonce = RandomNonce();
        var pending = new Msg
        {
            Id = "p" + nonce, ChannelId = channelId, AuthorId = Me.Id, Content = text, EditedAt = null,
            Ts = (ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Nonce = nonce, State = 0,
            ReplyTo = replyTo, Reactions = [], Attachments = files,
        };
        PendingFiles.Clear();
        var painted = MessageMerge.Merge(Messages, [pending], Row);
        RefreshHeaders();
        AtBottom = true; // your own message: jump to it
        Appended?.Invoke();
        Painted?.Invoke(painted);
        core.CallAsync("send_message", new JsonObject
        {
            ["channelId"] = channelId, ["content"] = text, ["nonce"] = nonce, ["tInputMs"] = tInputMs,
            ["replyTo"] = replyTo, ["files"] = new JsonArray(files.Select(f => (JsonNode)f.Id).ToArray()), ["gifs"] = new JsonArray(),
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

    // ---------- typing (same rules as the webview: 6 s, timer only while someone types) ----------

    const int TypingMs = 6000;
    readonly Dictionary<string, long> typers = []; // user → expires (TickCount64)
    DispatcherQueueTimer? typingTimer;

    void NoteTyping(string userId, bool on)
    {
        if (on) typers[userId] = Environment.TickCount64 + TypingMs;
        else if (!typers.Remove(userId)) return;
        TypingChanged?.Invoke(TypingLine());
        if (typers.Count > 0 && typingTimer is null)
        {
            typingTimer = ui.CreateTimer();
            typingTimer.Interval = TimeSpan.FromMilliseconds(500);
            typingTimer.Tick += (_, _) => SweepTyping();
            typingTimer.Start();
        }
    }

    void SweepTyping()
    {
        var now = Environment.TickCount64;
        var removed = typers.Where(kv => kv.Value <= now).Select(kv => kv.Key).ToList();
        foreach (var u in removed) typers.Remove(u);
        if (removed.Count > 0) TypingChanged?.Invoke(TypingLine());
        if (typers.Count == 0 && typingTimer is not null)
        {
            typingTimer.Stop();
            typingTimer = null;
        }
    }

    string TypingLine()
    {
        var names = typers.Keys.Select(NameOf).OrderBy(n => n, StringComparer.CurrentCultureIgnoreCase).ToList();
        return names.Count switch
        {
            0 => "",
            1 => $"{names[0]} is typing…",
            2 => $"{names[0]} and {names[1]} are typing…",
            3 => $"{names[0]}, {names[1]} and {names[2]} are typing…",
            _ => "Several people are typing…",
        };
    }

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
