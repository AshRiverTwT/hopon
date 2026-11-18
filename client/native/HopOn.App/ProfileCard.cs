// Profile card (port of client/ui/src/components/ProfileCard.tsx + .pcard
// styles): opens beside any name or picture you click. Banner (image), the
// picture with its presence mark, the name in Archivo in their colour,
// @username and presence, custom status, what they're playing (or the voice
// room), bio, dates, volume when you share a room, and one row of actions.
// A light-dismiss popup: a click outside or Esc closes it.

using HopOn.Native;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;

namespace HopOn.App;

public static class ProfileCard
{
    const double W = 320;
    static Popup? open;

    static readonly Dictionary<string, string> ModeLabel = new()
    {
        ["online"] = "Online", ["idle"] = "Idle", ["dnd"] = "Do not disturb", ["offline"] = "Offline", ["invisible"] = "Invisible",
    };

    public static async Task Show(FrameworkElement anchor, Store store, string userId, Action editProfile)
    {
        if (open is not null) open.IsOpen = false;
        if (anchor.XamlRoot?.Content is not FrameworkElement root) return;
        var (p, avatar) = await store.LoadProfile(userId);
        if (p is null) return;
        var me = userId == store.Me?.Id;
        var card = Build(store, p, avatar, me, editProfile, () => { if (open is not null) open.IsOpen = false; });

        // Beside the anchor: to its left when it's on the right half, else to its right.
        var r = anchor.TransformToVisual(root).TransformBounds(new Rect(0, 0, anchor.ActualWidth, anchor.ActualHeight));
        var left = r.Left > root.ActualWidth / 2 ? r.Left - W - 12 : r.Right + 12;
        left = Math.Max(8, Math.Min(root.ActualWidth - W - 8, left));
        var top = Math.Max(8, r.Top - 8);
        var popup = new Popup
        {
            Child = card, XamlRoot = anchor.XamlRoot, IsLightDismissEnabled = true,
            HorizontalOffset = left, VerticalOffset = top,
        };
        // Keep it on screen once its height is known.
        card.SizeChanged += (_, _) =>
        {
            var over = popup.VerticalOffset + card.ActualHeight - (root.ActualHeight - 8);
            if (over > 0) popup.VerticalOffset = Math.Max(8, popup.VerticalOffset - over);
        };
        card.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Escape) { popup.IsOpen = false; e.Handled = true; } };
        popup.Closed += (_, _) => { if (open == popup) open = null; };
        open = popup;
        popup.IsOpen = true;
        if (p.BannerV != 0 && await store.BannerOf(userId, p.BannerV) is { } banner && card.Child is StackPanel sp && sp.Children[0] is Image img)
        {
            img.Source = banner;
            img.Visibility = Visibility.Visible;
        }
    }

    static TextBlock Eyebrow(string text) => new()
    {
        Text = text.ToUpperInvariant(), FontFamily = Ui.Font("MonoFont"), FontSize = 10.5, CharacterSpacing = 160, Foreground = Ui.Brush("Cream55"),
    };

    /// <summary>A section: hairline on top, 14 px above and below, 20 px side margins.</summary>
    static StackPanel Section() => new()
    {
        Margin = new Thickness(20, 0, 20, 0), Padding = new Thickness(0, 14, 0, 14), Spacing = 6,
        BorderThickness = new Thickness(0, 1, 0, 0), BorderBrush = Ui.Brush("Cream10"),
    };

    static Border Build(Store store, Profile p, ImageSource? avatar, bool me, Action editProfile, Action close)
    {
        var id = p.User.Id;
        var panel = new StackPanel();
        panel.Children.Add(new Image { Height = 88, Stretch = Stretch.UniformToFill, Visibility = Visibility.Collapsed });

        // head: picture + presence, name, @username · presence
        var head = new Grid { ColumnSpacing = 14, Padding = new Thickness(20, 18, 20, 16) };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var shown = store.PresenceOf(id);
        head.Children.Add(Avatar(p.User.Name, avatar, 52, shown, 13));
        var who = new StackPanel { Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        var name = Ui.Display(22);
        name.Text = p.User.Name.ToUpperInvariant();
        name.TextWrapping = TextWrapping.Wrap;
        name.Foreground = p.User.Accent == 0 ? Ui.Brush("White") : store.AccentBrush(id);
        who.Children.Add(name);
        var sub = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        sub.Children.Add(new TextBlock { Text = "@" + p.Username, FontFamily = Ui.Font("MonoFont"), FontSize = 13, Foreground = Ui.Brush("Cream55") });
        sub.Children.Add(new TextBlock { Text = ModeLabel.GetValueOrDefault(shown, "Offline"), FontFamily = Ui.Font("MonoFont"), FontSize = 13, Foreground = Ui.Brush(shown == "offline" ? "Cream55" : "Cream80") });
        who.Children.Add(sub);
        Grid.SetColumn(who, 1);
        head.Children.Add(who);
        panel.Children.Add(head);

        // status, game or voice room
        var custom = store.CustomOf(id);
        var game = store.GameOf(id);
        var room = store.VoiceRoomOf(id);
        if (custom is not null || game.Length > 0 || room.Length > 0)
        {
            var sec = Section();
            if (custom is not null)
                sec.Children.Add(new TextBlock { Text = $"{custom.Emoji} {custom.Text}".Trim(), FontSize = 15, Foreground = Ui.Brush("Cream"), TextWrapping = TextWrapping.Wrap });
            if (game.Length > 0)
            {
                var g = Eyebrow("Playing " + game);
                g.Foreground = Ui.Brush("Cream");
                g.FontFamily = Ui.Font("MonoSemiFont");
                sec.Children.Add(g);
            }
            else if (room.Length > 0) sec.Children.Add(Eyebrow("In voice · " + room));
            panel.Children.Add(sec);
        }

        if (p.Bio.Length > 0)
        {
            var sec = Section();
            sec.Children.Add(new TextBlock { Text = p.Bio, FontSize = 14, LineHeight = 21, Foreground = Ui.Brush("Cream80"), TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(sec);
        }

        // dates
        {
            var sec = Section();
            sec.Orientation = Orientation.Horizontal;
            sec.Spacing = 28;
            static StackPanel Date(string label, long ms)
            {
                var d = new StackPanel { Spacing = 3 };
                d.Children.Add(Eyebrow(label));
                d.Children.Add(new TextBlock
                {
                    Text = DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("MMM d, yyyy", System.Globalization.CultureInfo.CurrentCulture),
                    FontSize = 14, Foreground = Ui.Brush("Cream80"),
                });
                return d;
            }
            sec.Children.Add(Date("Member since", p.CreatedAt));
            if (p.JoinedAt > 0) sec.Children.Add(Date("Joined", p.JoinedAt));
            panel.Children.Add(sec);
        }

        // volume, when they're in your voice room
        if (store.InMyRoom(id))
        {
            var sec = Section();
            var row = new Grid { ColumnSpacing = 10 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.Children.Add(Eyebrow("Volume"));
            var slider = new Slider { Minimum = 0, Maximum = 200, Value = 100, VerticalAlignment = VerticalAlignment.Center };
            slider.ValueChanged += (_, e) => _ = store.SetVoiceVolume(id, e.NewValue / 100);
            Grid.SetColumn(slider, 1);
            row.Children.Add(slider);
            sec.Children.Add(row);
            panel.Children.Add(sec);
        }

        // actions
        var actions = Section();
        actions.Orientation = Orientation.Horizontal;
        actions.Spacing = 12;
        actions.Padding = new Thickness(0, 14, 0, 18);
        if (me)
        {
            var edit = Ui.Key("EDIT PROFILE");
            edit.Click += (_, _) => { close(); editProfile(); };
            actions.Children.Add(edit);
        }
        else
        {
            var friend = store.FriendOf(id);
            if (friend?.State == "friends")
            {
                var msg = Ui.Key("MESSAGE", solid: true);
                msg.Click += (_, _) => { close(); _ = store.OpenDm(id); };
                actions.Children.Add(msg);
            }
            else if (friend is null)
            {
                var add = Ui.Key("ADD FRIEND");
                add.Click += async (_, _) => { add.IsEnabled = false; await store.AddFriend(p.Username); add.Content = "REQUEST SENT"; };
                actions.Children.Add(add);
            }
            else if (friend.State == "outgoing") actions.Children.Add(new Border { VerticalAlignment = VerticalAlignment.Center, Child = Eyebrow("Request sent") });
            else if (friend.State == "incoming")
            {
                var accept = Ui.Key("ACCEPT", solid: true);
                accept.Click += (_, _) => { close(); _ = store.AcceptFriend(id); };
                actions.Children.Add(accept);
            }
            if (store.IsOwner && store.OpenServer is { } sv && sv.MemberIds.Contains(id))
            {
                var kick = new HyperlinkButton { Content = "Remove", Foreground = Ui.Brush("Cream55"), Padding = new Thickness(0), VerticalAlignment = VerticalAlignment.Center };
                var confirm = false;
                kick.Click += (_, _) =>
                {
                    if (!confirm) { confirm = true; kick.Content = $"Remove from {sv.Name}?"; kick.Foreground = Ui.Brush("White"); return; }
                    close();
                    _ = store.KickMember(id);
                };
                actions.Children.Add(kick);
            }
        }
        if (actions.Children.Count > 0) panel.Children.Add(actions);

        return new Border
        {
            Width = W, Background = Ui.Brush("Ink2"), BorderBrush = Ui.Brush("Line"), BorderThickness = new Thickness(1),
            Child = panel, Shadow = new ThemeShadow(), Translation = new System.Numerics.Vector3(0, 0, 32),
        };
    }

    /// <summary>A square picture (or initial) with the presence mark in its corner (.rail-av + .rail-dot).</summary>
    public static Grid Avatar(string name, ImageSource? image, double size, string presence, double dot)
    {
        var g = new Grid { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center };
        g.Children.Add(new Border
        {
            Background = Ui.Brush("Cream10"),
            Child = new TextBlock
            {
                Text = name.Length > 0 ? name[..1].ToUpperInvariant() : "", FontSize = size * 0.4, Foreground = Ui.Brush("Cream80"),
                FontFamily = Ui.Font("TextSemiFont"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            },
        });
        if (image is not null) g.Children.Add(new Image { Source = image, Stretch = Stretch.UniformToFill });
        if (presence != "offline") g.Children.Add(PresenceDot(presence, dot));
        return g;
    }

    /// <summary>Solid = online, half = idle, a bar = do not disturb, outline = invisible (.rail-dot).</summary>
    public static FrameworkElement PresenceDot(string presence, double size)
    {
        var dot = new Grid
        {
            Width = size, Height = size, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(0, 0, -3, -3),
        };
        var ring = new Border { BorderBrush = Ui.Brush("Ink2"), BorderThickness = new Thickness(size > 10 ? 3 : 2) };
        var fill = new Grid();
        switch (presence)
        {
            case "idle":
                fill.Background = new LinearGradientBrush
                {
                    StartPoint = new Point(0, 0), EndPoint = new Point(1, 1),
                    GradientStops = { new GradientStop { Color = Ui.Brush("Cream").Color, Offset = 0.5 }, new GradientStop { Color = Ui.Brush("Ink").Color, Offset = 0.5 } },
                };
                fill.BorderBrush = Ui.Brush("Cream");
                fill.BorderThickness = new Thickness(1);
                break;
            case "dnd":
                fill.Background = Ui.Brush("White");
                fill.Children.Add(new Rectangle { Height = 1.5, Fill = Ui.Brush("Ink"), Margin = new Thickness(1, 0, 1, 0), VerticalAlignment = VerticalAlignment.Center });
                break;
            case "invisible":
                fill.Background = Ui.Brush("Ink");
                fill.BorderBrush = Ui.Brush("Cream35");
                fill.BorderThickness = new Thickness(2);
                break;
            default:
                fill.Background = Ui.Brush("Cream");
                break;
        }
        ring.Child = fill;
        dot.Children.Add(ring);
        return dot;
    }
}
