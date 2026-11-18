using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using HopOn.Native;
using Microsoft.UI.Xaml;

namespace HopOn.App;

public abstract partial class Observable : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }

    protected void Raise(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

public sealed partial class ServerVm : Observable
{
    string name = "";
    public required string Id { get; init; }
    public string Name { get => name; set { Set(ref name, value); Raise(nameof(Initials)); } }
    public string Initials => string.Concat(Name.Split(' ', StringSplitOptions.RemoveEmptyEntries).Take(2).Select(w => char.ToUpperInvariant(w[0])));
    public List<Channel> Channels { get; set; } = [];
    public HashSet<string> MemberIds { get; } = [];
    /// <summary>channel id → last read message id.</summary>
    public Dictionary<string, string> Reads { get; set; } = [];
}

/// <summary>A friend or a pending request (Friends view).</summary>
public sealed partial class FriendVm : Observable
{
    string state = "";
    string name = "";
    public required string UserId { get; init; }
    public required string Username { get; init; }
    public string Name { get => name; set => Set(ref name, value); }
    /// <summary>"friends" | "incoming" | "outgoing".</summary>
    public string State { get => state; set { Set(ref state, value); Raise(nameof(Detail)); Raise(nameof(AcceptVisibility)); Raise(nameof(RemoveLabel)); } }
    public string Detail => State switch { "incoming" => "Wants to be friends", "outgoing" => "Request sent", _ => "@" + Username };
    public Visibility AcceptVisibility => State == "incoming" ? Visibility.Visible : Visibility.Collapsed;
    public string RemoveLabel => State switch { "incoming" => "Decline", "outgoing" => "Cancel", _ => "Remove" };
    /// <summary>(friend, "open" | "accept" | "remove"): set by the store.</summary>
    public static Action<FriendVm, string>? Act { get; set; }
    public void Open() => Act?.Invoke(this, "open");
    public void Accept() => Act?.Invoke(this, "accept");
    public void Remove() => Act?.Invoke(this, "remove");
}

/// <summary>A row of the people column.</summary>
public sealed partial class MemberVm : Observable
{
    /// <summary>(user id, name): owner removes a member; set by the window.</summary>
    public static Action<string, string>? KickAction { get; set; }
    public Visibility KickVisibility => ChannelVm.OwnerTools && Id != MessageVm.MeId ? Visibility.Visible : Visibility.Collapsed;
    public void Kick() => KickAction?.Invoke(Id, Name);
    public void ShowProfile(object sender, Microsoft.UI.Xaml.Input.TappedRoutedEventArgs e)
    {
        if (sender is FrameworkElement fe) MessageVm.ShowProfileAction?.Invoke(Id, fe);
    }
    Microsoft.UI.Xaml.Media.ImageSource? avatar;
    public Microsoft.UI.Xaml.Media.ImageSource? Avatar { get => avatar; set => Set(ref avatar, value); }
    string name = "";
    bool online;
    string detail = "";
    public required string Id { get; init; }
    public string Name { get => name; set { Set(ref name, value); Raise(nameof(Initial)); } }
    public string Initial => name.Length > 0 ? name[..1].ToUpperInvariant() : "";
    public bool Online { get => online; set { Set(ref online, value); Raise(nameof(DotBrush)); Raise(nameof(RowOpacity)); } }
    /// <summary>"Playing X", or the custom status.</summary>
    public string Detail { get => detail; set { Set(ref detail, value); Raise(nameof(DetailVisibility)); } }
    public Visibility DetailVisibility => Detail.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
    public double RowOpacity => Online ? 1.0 : 0.5;
    public double RowOpacityDim => Online ? 1.0 : 0.45;
    /// <summary>A small square: cream when online, nothing when not (the row dims instead).</summary>
    public Microsoft.UI.Xaml.Media.Brush DotBrush => new Microsoft.UI.Xaml.Media.SolidColorBrush(
        Online ? Microsoft.UI.ColorHelper.FromArgb(255, 0xED, 0xED, 0xEE) : Microsoft.UI.Colors.Transparent);
}

public sealed partial class ChannelVm : Observable
{
    string name = "";
    string topic = "";
    bool unread;
    public required string Id { get; init; }
    public required bool Voice { get; init; }
    public string Name { get => name; set { Set(ref name, value); Raise(nameof(Label)); } }
    public string Topic { get => topic; set => Set(ref topic, value); }
    public string Label => (Voice ? "🔊 " : "# ") + Name;
    /// <summary>(channel, "rename" | "topic" | "delete"): set by the window.</summary>
    public static Action<ChannelVm, string>? Act { get; set; }
    public static bool OwnerTools { get; set; }
    public Visibility OwnerVisibility => OwnerTools ? Visibility.Visible : Visibility.Collapsed;
    public void Rename() => Act?.Invoke(this, "rename");
    public void EditTopic() => Act?.Invoke(this, "topic");
    public void Remove() => Act?.Invoke(this, "delete");
    string participants = "";
    /// <summary>Voice rooms: who's in it ("● " marks who's speaking).</summary>
    public string Participants { get => participants; set { Set(ref participants, value); Raise(nameof(ParticipantsVisibility)); } }
    public Visibility ParticipantsVisibility => Participants.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
    public bool Unread { get => unread; set { Set(ref unread, value); Raise(nameof(LabelOpacity)); } }
    public double LabelOpacity => Unread ? 1.0 : 0.72;
}

/// <summary>An attachment under a message: images inline, other files as links.</summary>
public sealed partial class AttachmentVm : Observable
{
    /// <summary>"http(s)://host" of the chat server (set by the store).</summary>
    public static string HttpBase { get; set; } = "";
    public required Attachment A { get; init; }
    public bool IsImage => Media.IsImage(A);
    public Uri? Uri => Uri.TryCreate(Media.Url(HttpBase, A), UriKind.Absolute, out var u) ? u : null;
    public double BoxWidth => Media.FitBox(A.Width, A.Height).W;
    public double BoxHeight => Media.FitBox(A.Width, A.Height).H;
    public Visibility ImageVisibility => IsImage ? Visibility.Visible : Visibility.Collapsed;
    public Visibility FileVisibility => IsImage ? Visibility.Collapsed : Visibility.Visible;
    public string FileLabel => $"📎 {A.Name} ({Media.FormatSize(A.Size)})";
    /// <summary>File kind badge (PDF, ZIP...) and "1.2 MB · Download", like the web's file row.</summary>
    public string Ext => System.IO.Path.GetExtension(A.Name).TrimStart('.') is { Length: > 0 and <= 4 } e ? e.ToUpperInvariant() : "FILE";
    public string SizeText => $"{Media.FormatSize(A.Size)} · Download";
    /// <summary>Decoded at display size: a 4000 px photo doesn't cost 64 MB of RAM.</summary>
    public Microsoft.UI.Xaml.Media.Imaging.BitmapImage? Image
    {
        get
        {
            if (!IsImage || Uri is null) return null;
            return new Microsoft.UI.Xaml.Media.Imaging.BitmapImage { UriSource = Uri, DecodePixelWidth = (int)BoxWidth * 2, DecodePixelType = Microsoft.UI.Xaml.Media.Imaging.DecodePixelType.Logical };
        }
    }
}

/// <summary>A file chosen for the next message (uploading → ready or failed).</summary>
public sealed partial class PendingFileVm : Observable
{
    Attachment? att;
    string? error;
    public required string Name { get; init; }
    public Attachment? Att { get => att; set { Set(ref att, value); Raise(nameof(Label)); } }
    public string? Error { get => error; set { Set(ref error, value); Raise(nameof(Label)); } }
    public string Label => Error is not null ? $"⚠ {Name}: {Error}" : Att is null ? $"⏳ {Name}" : $"📎 {Name}";
    public static Action<PendingFileVm>? RemoveAction { get; set; }
    public void Remove() => RemoveAction?.Invoke(this);
}

/// <summary>One reaction under a message: "👍 2"; click toggles yours.</summary>
public sealed partial class ReactionVm : Observable
{
    int count;
    bool mine;
    public required MessageVm Message { get; init; }
    public required string Emoji { get; init; }
    public int Count { get => count; set { Set(ref count, value); Raise(nameof(Label)); } }
    public bool Mine { get => mine; set { Set(ref mine, value); Raise(nameof(ChipOpacity)); Raise(nameof(ChipBrush)); Raise(nameof(ChipBorder)); } }
    // .chip / .chip.mine
    static readonly Microsoft.UI.Xaml.Media.SolidColorBrush MineFill = new(Microsoft.UI.ColorHelper.FromArgb(18, 255, 255, 255));
    static readonly Microsoft.UI.Xaml.Media.SolidColorBrush MineEdge = new(Microsoft.UI.ColorHelper.FromArgb(31, 255, 255, 255));
    public Microsoft.UI.Xaml.Media.Brush ChipBrush => Mine ? MineFill : Ui.Brush("Cream10");
    public Microsoft.UI.Xaml.Media.Brush ChipBorder => Mine ? MineEdge : Ui.Brush("Transparent");
    public string Label => $"{Emoji} {Count}";
    public double ChipOpacity => Mine ? 1.0 : 0.7;
    public void Toggle() => MessageVm.ToggleReaction?.Invoke(Message, Emoji, !Mine);
}

/// <summary>A poll option: votes are the 1️⃣–5️⃣ reactions.</summary>
public sealed partial class PollOptionVm : Observable
{
    int votes;
    double pct;
    bool mine;
    public required MessageVm Message { get; init; }
    public required int Index { get; init; }
    public required string Text { get; init; }
    public int Votes { get => votes; set { Set(ref votes, value); Raise(nameof(VotesText)); } }
    public double Pct { get => pct; set { Set(ref pct, value); Raise(nameof(BarWidth)); Raise(nameof(RestWidth)); Raise(nameof(PctText)); } }
    public bool Mine { get => mine; set { Set(ref mine, value); Raise(nameof(VotesText)); Raise(nameof(BarBrush)); Raise(nameof(CheckFill)); Raise(nameof(CheckStroke)); Raise(nameof(LabelBrush)); } }
    public string VotesText => (Mine ? "✓ " : "") + (Votes == 1 ? "1 vote" : $"{Votes} votes");
    // .poll-opt: a bar filled by its share (lead brighter), a check square, "%" and the count.
    public bool Lead { get => lead; set { Set(ref lead, value); Raise(nameof(BarBrush)); } }
    bool lead;
    public string Voters { get => voters; set => Set(ref voters, value); }
    string voters = "No votes yet";
    public GridLength BarWidth => new(Math.Max(0.0001, Pct), GridUnitType.Star);
    public GridLength RestWidth => new(Math.Max(0.0001, 100 - Pct), GridUnitType.Star);
    public string PctText => $"{Math.Round(Pct)}%";
    public Microsoft.UI.Xaml.Media.Brush BarBrush => Ui.Brush(Mine ? "Cream10" : Lead ? "Cream20" : "Cream10");
    public Microsoft.UI.Xaml.Media.Brush CheckFill => Mine ? Ui.Brush("White") : Ui.Brush("Transparent");
    public Microsoft.UI.Xaml.Media.Brush CheckStroke => Mine ? Ui.Brush("White") : Ui.Brush("Cream35");
    public Microsoft.UI.Xaml.Media.Brush LabelBrush => Ui.Brush(Mine ? "Cream" : "Cream80");
    public void Toggle() => MessageVm.ToggleReaction?.Invoke(Message, Polls.Emoji[Index], !Mine);
}

public sealed partial class MessageVm : Observable, IMessageItem
{
    /// <summary>Your user id (for "mine" on reactions and votes).</summary>
    public static string? MeId { get; set; }
    /// <summary>(message, emoji, add): set by the store.</summary>
    public static Action<MessageVm, string, bool>? ToggleReaction { get; set; }
    /// <summary>(message, "reply" | "edit" | "delete"): set by the store.</summary>
    public static Action<MessageVm, string>? Act { get; set; }

    public bool IsMine => MeId is not null && AuthorId == MeId;
    public Visibility MineVisibility => IsMine ? Visibility.Visible : Visibility.Collapsed;
    /// <summary>Your own message, or you own the server.</summary>
    public bool CanDelete { get; init; }
    public Visibility DeleteVisibility => CanDelete ? Visibility.Visible : Visibility.Collapsed;
    public void Reply() => Act?.Invoke(this, "reply");

    /// <summary>(message, row, args): one shared context menu, set by the window.</summary>
    public static Action<MessageVm, UIElement, Microsoft.UI.Xaml.Input.ContextRequestedEventArgs>? ContextMenuAction { get; set; }
    public void OnContextRequested(UIElement sender, Microsoft.UI.Xaml.Input.ContextRequestedEventArgs e) => ContextMenuAction?.Invoke(this, sender, e);

    /// <summary>(user id, anchor element): set by the window.</summary>
    public static Action<string, FrameworkElement>? ShowProfileAction { get; set; }
    public void ShowProfile(object sender, Microsoft.UI.Xaml.Input.TappedRoutedEventArgs e)
    {
        if (sender is FrameworkElement fe) ShowProfileAction?.Invoke(AuthorId, fe);
    }

    /// <summary>The React submenu's emoji (fixed set: menu items bind to methods, AOT-safe).</summary>
    public static readonly string[] Quick = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"];
    bool Has(string e) => MeId is not null && reactions.Any(r => r.Emoji == e && r.Users.Contains(MeId));
    void QuickReact(int i) => ToggleReaction?.Invoke(this, Quick[i], !Has(Quick[i]));
    public void QuickReactAt(int i) => QuickReact(i);
    public void React0() => QuickReact(0);
    public void React1() => QuickReact(1);
    public void React2() => QuickReact(2);
    public void React3() => QuickReact(3);
    public void React4() => QuickReact(4);
    public void React5() => QuickReact(5);
    public void React6() => QuickReact(6);
    public void React7() => QuickReact(7);
    public void BeginEdit() => Act?.Invoke(this, "edit");
    public void Delete() => Act?.Invoke(this, "delete");

    // ---------- hover actions (Reply · React · Save · Edit · Delete) and inline edit ----------

    bool hovered, editing, saved;
    string editText = "";
    /// <summary>The pointer is over the row (actions show; row lights up).</summary>
    public bool Hovered { get => hovered; set { Set(ref hovered, value); Raise(nameof(ActionsVisibility)); Raise(nameof(RowBrush)); } }
    public bool IsEditing { get => editing; set { Set(ref editing, value); Raise(nameof(ActionsVisibility)); Raise(nameof(NotEditingVisibility)); } }
    public string EditText { get => editText; set => Set(ref editText, value); }
    public bool Saved { get => saved; set { Set(ref saved, value); Raise(nameof(SaveLabel)); } }
    public string SaveLabel => Saved ? "Saved" : "Save";
    /// <summary>Real (sent) messages only: pending copies get no actions.</summary>
    public Visibility ActionsVisibility => Hovered && !IsEditing && !MessageMerge.IsPending(Id) ? Visibility.Visible : Visibility.Collapsed;
    public Visibility NotEditingVisibility => IsEditing ? Visibility.Collapsed : Visibility.Visible;
    public Visibility EditVisibility => IsMine && !MessageMerge.IsPending(Id) ? Visibility.Visible : Visibility.Collapsed;
    static readonly Microsoft.UI.Xaml.Media.SolidColorBrush HoverBrush = new(Microsoft.UI.ColorHelper.FromArgb(6, 255, 255, 255));
    static readonly Microsoft.UI.Xaml.Media.SolidColorBrush NoBrush = new(Microsoft.UI.Colors.Transparent);
    public Microsoft.UI.Xaml.Media.Brush RowBrush => Hovered || IsEditing ? HoverBrush : NoBrush;
    public void OnEnter(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e) => Hovered = true;
    public void OnExit(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e) { if (!pickerOpen) Hovered = false; }
    bool pickerOpen;
    /// <summary>(message, anchor): open the emoji picker for a reaction (set by the window).</summary>
    public static Action<MessageVm, FrameworkElement>? ReactAction { get; set; }
    public void ReactClick(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement fe) return;
        pickerOpen = true;
        ReactAction?.Invoke(this, fe);
    }
    /// <summary>The reaction picker closed.</summary>
    public void PickerClosed() { pickerOpen = false; Hovered = false; }
    public bool HasMine(string emoji) => Has(emoji);
    public void SaveClick() => Act?.Invoke(this, "save");
    public void OnEditKey(object sender, Microsoft.UI.Xaml.Input.KeyRoutedEventArgs e)
    {
        if (sender is not Microsoft.UI.Xaml.Controls.TextBox box) return;
        if (e.Key == Windows.System.VirtualKey.Escape) { e.Handled = true; Act?.Invoke(this, "cancel-edit"); }
        else if (e.Key == Windows.System.VirtualKey.Enter && !Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down))
        {
            e.Handled = true;
            EditText = box.Text;
            Act?.Invoke(this, "save-edit");
        }
    }
    public void OnEditLoaded(object sender, RoutedEventArgs e)
    {
        if (sender is not Microsoft.UI.Xaml.Controls.TextBox box) return;
        box.Focus(FocusState.Programmatic);
        box.SelectionStart = box.Text.Length;
    }

    string? replyTo;
    string replyPreview = "";
    public string? ReplyTo => replyTo;
    /// <summary>"↪ name: first line" of the message this replies to (set by the store).</summary>
    public string ReplyPreview { get => replyPreview; set { Set(ref replyPreview, value); Raise(nameof(ReplyVisibility)); Raise(nameof(HasReply)); } }
    public bool HasReply => ReplyPreview.Length > 0;
    public Visibility ReplyVisibility => ReplyPreview.Length == 0 ? Visibility.Collapsed : Visibility.Visible;

    List<Reaction> reactions = [];
    public ObservableCollection<ReactionVm> Chips { get; } = [];
    public Poll? Poll { get; private set; }
    string pollFoot = "0 votes";
    public string PollFoot { get => pollFoot; private set => Set(ref pollFoot, value); }
    /// <summary>User id → name (set by the store), for poll voter lists.</summary>
    public static Func<string, string>? NameOf { get; set; }
    public ObservableCollection<PollOptionVm> PollOptions { get; } = [];
    public Visibility PollVisibility => Poll is null ? Visibility.Collapsed : Visibility.Visible;
    public Visibility BodyVisibility => Poll is null && Content.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    public Visibility ChipsVisibility => Chips.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
    public bool HasChips => Chips.Count > 0;
    public bool IsPoll => Poll is not null;

    /// <summary>Raw reaction lists (mutable: reaction events apply here, then Rebuild).</summary>
    public List<Reaction> RawReactions => reactions;

    void SetContentDerived(string text, List<Reaction> rs)
    {
        reactions = rs.Select(r => new Reaction { Emoji = r.Emoji, Users = [.. r.Users] }).ToList();
        var poll = Polls.Decode(text);
        if (poll != Poll)
        {
            Poll = poll;
            PollOptions.Clear();
            if (poll is not null)
                for (var i = 0; i < poll.Options.Count; i++)
                    PollOptions.Add(new PollOptionVm { Message = this, Index = i, Text = poll.Options[i] });
            Raise(nameof(Poll));
            Raise(nameof(PollVisibility));
            Raise(nameof(IsPoll));
            Raise(nameof(BodyVisibility));
        }
        RebuildReactions();
    }

    /// <summary>Sync chips and poll votes from <see cref="RawReactions"/>.</summary>
    public void RebuildReactions()
    {
        var shown = reactions.Where(r => Poll is null || !Polls.Emoji.Take(Poll.Options.Count).Contains(r.Emoji)).ToList();
        for (var i = Chips.Count - 1; i >= 0; i--)
            if (!shown.Any(r => r.Emoji == Chips[i].Emoji)) Chips.RemoveAt(i);
        foreach (var r in shown)
        {
            var chip = Chips.FirstOrDefault(c => c.Emoji == r.Emoji);
            if (chip is null) Chips.Add(chip = new ReactionVm { Message = this, Emoji = r.Emoji });
            chip.Count = r.Users.Count;
            chip.Mine = MeId is not null && r.Users.Contains(MeId);
        }
        if (Poll is not null)
        {
            var votes = PollOptions.Select(o => reactions.FirstOrDefault(r => r.Emoji == Polls.Emoji[o.Index])?.Users ?? []).ToList();
            var total = votes.Sum(v => v.Count);
            var max = votes.Count == 0 ? 0 : votes.Max(v => v.Count);
            for (var i = 0; i < PollOptions.Count; i++)
            {
                PollOptions[i].Votes = votes[i].Count;
                PollOptions[i].Pct = total == 0 ? 0 : 100.0 * votes[i].Count / total;
                PollOptions[i].Mine = MeId is not null && votes[i].Contains(MeId);
                PollOptions[i].Lead = total > 0 && votes[i].Count == max;
                PollOptions[i].Voters = votes[i].Count == 0 ? "No votes yet" : string.Join(", ", votes[i].Select(u => NameOf?.Invoke(u) ?? u));
            }
            var voters = votes.SelectMany(v => v).Distinct().Count();
            PollFoot = voters == 1 ? "1 vote" : $"{voters} votes";
        }
        Raise(nameof(ChipsVisibility));
        Raise(nameof(HasChips));
    }

    string id;
    string content;
    string author;
    byte state;
    bool header = true;
    long? editedAt;

    public MessageVm(Msg m, string author)
    {
        id = m.Id;
        Nonce = m.Nonce;
        AuthorId = m.AuthorId;
        content = m.Content;
        this.author = author;
        state = m.State;
        Ts = m.Ts;
        editedAt = m.EditedAt;
        Attachments = m.Attachments;
        replyTo = m.ReplyTo;
        SetContentDerived(m.Content, m.Reactions);
        SyncMedia();
    }

    public string Id { get => id; private set => Set(ref id, value); }
    public string Nonce { get; }
    public string AuthorId { get; }
    public ulong Ts { get; }
    public List<Attachment> Attachments { get; private set; }
    public ObservableCollection<AttachmentVm> Media { get; } = [];
    public Visibility MediaVisibility => Media.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
    public bool HasMedia => Media.Count > 0;
    void SyncMedia()
    {
        if (Media.Select(a => a.A.Id).SequenceEqual(Attachments.Select(a => a.Id))) return;
        Media.Clear();
        foreach (var a in Attachments) Media.Add(new AttachmentVm { A = a });
        Raise(nameof(MediaVisibility));
        Raise(nameof(HasMedia));
    }
    public string Content { get => content; private set { Set(ref content, value); Raise(nameof(Body)); Raise(nameof(BodyVisibility)); } }
    public string Author { get => author; set { Set(ref author, value); Raise(nameof(AuthorCaps)); Raise(nameof(Initial)); } }
    public string AuthorCaps => author.ToUpperInvariant();
    public string Initial => author.Length > 0 ? author[..1].ToUpperInvariant() : "";
    Microsoft.UI.Xaml.Media.Brush? authorBrush;
    /// <summary>The author's profile colour (white when none), set by the store.</summary>
    public Microsoft.UI.Xaml.Media.Brush? AuthorBrush { get => authorBrush; set => Set(ref authorBrush, value); }
    public byte State { get => state; private set { Set(ref state, value); Raise(nameof(Opacity)); Raise(nameof(StateText)); Raise(nameof(FootVisibility)); } }
    public bool Header { get => header; set { Set(ref header, value); Raise(nameof(HeaderVisibility)); Raise(nameof(RowPadding)); } }

    /// <summary>The text (attachments render below it).</summary>
    public string Body => Content;
    public string Time => DateTimeOffset.FromUnixTimeMilliseconds((long)Ts).ToLocalTime().ToString("t");
    public string Edited => editedAt is null ? "" : "(edited)";
    public double Opacity => State == 0 ? 0.55 : 1.0;
    public string StateText => State == 3 ? "Not sent" : "";
    /// <summary>The "(edited) · Not sent" line takes no room when empty.</summary>
    public Visibility FootVisibility => editedAt is null && State != 3 ? Visibility.Collapsed : Visibility.Visible;
    public Visibility HeaderVisibility => Header ? Visibility.Visible : Visibility.Collapsed;
    Microsoft.UI.Xaml.Media.ImageSource? avatar;
    /// <summary>Profile picture (null: initials).</summary>
    public Microsoft.UI.Xaml.Media.ImageSource? Avatar { get => avatar; set => Set(ref avatar, value); }
    string dayText = "";
    bool newHere;
    /// <summary>Day separator above this message ("" = none).</summary>
    public string DayText { get => dayText; set { Set(ref dayText, value); Raise(nameof(DayVisibility)); Raise(nameof(HasDay)); Raise(nameof(DayCaps)); } }
    public string DayCaps => DayText.ToUpperInvariant();
    public Visibility DayVisibility => DayText.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
    public bool HasDay => DayText.Length > 0;
    /// <summary>The "new messages" divider sits above this message.</summary>
    public bool NewHere { get => newHere; set { Set(ref newHere, value); Raise(nameof(NewVisibility)); } }
    public Visibility NewVisibility => NewHere ? Visibility.Visible : Visibility.Collapsed;
    /// <summary>Indented by the avatar column; the header pulls back over it.</summary>
    public Thickness RowPadding => new(0, Header ? 20 : 3, 0, 3);

    public void Update(Msg m, byte newState)
    {
        Id = m.Id;
        Content = m.Content;
        Attachments = m.Attachments;
        editedAt = m.EditedAt;
        Raise(nameof(Edited));
        Raise(nameof(FootVisibility));
        Raise(nameof(Body));
        SetContentDerived(m.Content, m.Reactions);
        SyncMedia();
        State = newState;
    }

    public void SetState(string newId, byte newState)
    {
        Id = newId;
        State = newState;
    }

    public void Edit(string newContent, long at)
    {
        Content = newContent;
        SetContentDerived(newContent, reactions);
        editedAt = at;
        Raise(nameof(Edited));
        Raise(nameof(FootVisibility));
    }

    public void Failed() => State = 3;
}
