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
}

/// <summary>A row of the people column.</summary>
public sealed partial class MemberVm : Observable
{
    string name = "";
    bool online;
    string detail = "";
    public required string Id { get; init; }
    public string Name { get => name; set => Set(ref name, value); }
    public bool Online { get => online; set { Set(ref online, value); Raise(nameof(DotBrush)); Raise(nameof(RowOpacity)); } }
    /// <summary>"Playing X", or the custom status.</summary>
    public string Detail { get => detail; set { Set(ref detail, value); Raise(nameof(DetailVisibility)); } }
    public Visibility DetailVisibility => Detail.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
    public double RowOpacity => Online ? 1.0 : 0.5;
    public Microsoft.UI.Xaml.Media.Brush DotBrush => new Microsoft.UI.Xaml.Media.SolidColorBrush(
        Online ? Microsoft.UI.ColorHelper.FromArgb(255, 59, 165, 93) : Microsoft.UI.ColorHelper.FromArgb(255, 116, 127, 141));
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
    public bool Unread { get => unread; set { Set(ref unread, value); Raise(nameof(LabelOpacity)); } }
    public double LabelOpacity => Unread ? 1.0 : 0.72;
}

/// <summary>One reaction under a message: "👍 2"; click toggles yours.</summary>
public sealed partial class ReactionVm : Observable
{
    int count;
    bool mine;
    public required MessageVm Message { get; init; }
    public required string Emoji { get; init; }
    public int Count { get => count; set { Set(ref count, value); Raise(nameof(Label)); } }
    public bool Mine { get => mine; set { Set(ref mine, value); Raise(nameof(ChipOpacity)); } }
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
    public double Pct { get => pct; set => Set(ref pct, value); }
    public bool Mine { get => mine; set { Set(ref mine, value); Raise(nameof(VotesText)); } }
    public string VotesText => (Mine ? "✓ " : "") + (Votes == 1 ? "1 vote" : $"{Votes} votes");
    public void Toggle() => MessageVm.ToggleReaction?.Invoke(Message, Polls.Emoji[Index], !Mine);
}

public sealed partial class MessageVm : Observable, IMessageItem
{
    /// <summary>Your user id (for "mine" on reactions and votes).</summary>
    public static string? MeId { get; set; }
    /// <summary>(message, emoji, add): set by the store.</summary>
    public static Action<MessageVm, string, bool>? ToggleReaction { get; set; }

    List<Reaction> reactions = [];
    public ObservableCollection<ReactionVm> Chips { get; } = [];
    public Poll? Poll { get; private set; }
    public ObservableCollection<PollOptionVm> PollOptions { get; } = [];
    public Visibility PollVisibility => Poll is null ? Visibility.Collapsed : Visibility.Visible;
    public Visibility BodyVisibility => Poll is null ? Visibility.Visible : Visibility.Collapsed;
    public Visibility ChipsVisibility => Chips.Count == 0 ? Visibility.Collapsed : Visibility.Visible;

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
            for (var i = 0; i < PollOptions.Count; i++)
            {
                PollOptions[i].Votes = votes[i].Count;
                PollOptions[i].Pct = total == 0 ? 0 : 100.0 * votes[i].Count / total;
                PollOptions[i].Mine = MeId is not null && votes[i].Contains(MeId);
            }
        }
        Raise(nameof(ChipsVisibility));
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
        SetContentDerived(m.Content, m.Reactions);
    }

    public string Id { get => id; private set => Set(ref id, value); }
    public string Nonce { get; }
    public string AuthorId { get; }
    public ulong Ts { get; }
    public List<Attachment> Attachments { get; private set; }
    public string Content { get => content; private set { Set(ref content, value); Raise(nameof(Body)); } }
    public string Author { get => author; set => Set(ref author, value); }
    public byte State { get => state; private set { Set(ref state, value); Raise(nameof(Opacity)); Raise(nameof(StateText)); } }
    public bool Header { get => header; set { Set(ref header, value); Raise(nameof(HeaderVisibility)); Raise(nameof(RowPadding)); } }

    /// <summary>Content plus attachment names (rich rendering comes later).</summary>
    public string Body => Attachments.Count == 0 ? Content
        : string.Join("\n", new[] { Content }.Concat(Attachments.Select(a => $"📎 {a.Name}")).Where(s => s.Length > 0));
    public string Time => DateTimeOffset.FromUnixTimeMilliseconds((long)Ts).ToLocalTime().ToString("t");
    public string Edited => editedAt is null ? "" : "(edited)";
    public double Opacity => State == 0 ? 0.55 : 1.0;
    public string StateText => State == 3 ? "Not sent" : "";
    public Visibility HeaderVisibility => Header ? Visibility.Visible : Visibility.Collapsed;
    public Thickness RowPadding => Header ? new Thickness(0, 10, 0, 0) : new Thickness(0);

    public void Update(Msg m, byte newState)
    {
        Id = m.Id;
        Content = m.Content;
        Attachments = m.Attachments;
        editedAt = m.EditedAt;
        Raise(nameof(Edited));
        Raise(nameof(Body));
        SetContentDerived(m.Content, m.Reactions);
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
    }

    public void Failed() => State = 3;
}
