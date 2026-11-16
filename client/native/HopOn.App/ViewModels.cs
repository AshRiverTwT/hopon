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

public sealed partial class MessageVm : Observable, IMessageItem
{
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
        editedAt = at;
        Raise(nameof(Edited));
    }

    public void Failed() => State = 3;
}
