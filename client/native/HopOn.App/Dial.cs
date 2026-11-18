// The rotary channel dial (port of client/ui/src/components/Dial.tsx): the
// server's monogram on the left, its channels on an arc around it with the one
// under the cursor in a key, an encoder scale (a tick per channel) that turns
// with it, a readout (01/08 TXT) and a straight rail of the other servers
// through the monogram. Wheel or arrow keys turn it; it settles on (opens) the
// channel under the cursor after a short pause, a click opens at once.
// Wheel inside the scale's arc turns the server rail instead.

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using System.Numerics;
using Windows.Foundation;
using VirtualKey = Windows.System.VirtualKey;

namespace HopOn.App;

public sealed partial class Dial : Grid
{
    const double StepDeg = 11, Radius = 300, ScaleR = Radius - 10, ItemH = 34;
    const int Visible = 6;
    static readonly double[] RailY = [0, 84, 146, 196];
    static readonly double[] RailScale = [1, 0.5, 0.36, 0.28];
    static readonly double[] RailOpacity = [1, 0.55, 0.3, 0.14];

    /// <summary>One position on the dial: a channel, or (owners) "+ Channel" / "+ Voice room".</summary>
    public sealed record Item(ChannelVm? Channel, bool NewVoice);

    public event Action<ChannelVm>? ChannelPicked;
    public event Action<bool>? NewChannel;
    public event Action<ServerVm>? ServerPicked;
    public event Action<FrameworkElement>? MonogramClicked;

    readonly Canvas canvas = new();
    readonly Canvas scale = new();
    readonly Image dots = new() { Stretch = Stretch.None, HorizontalAlignment = HorizontalAlignment.Left, IsHitTestVisible = false };
    readonly Button monogram = new() { Background = null, BorderThickness = new Thickness(0), Padding = new Thickness(0) };
    readonly TextBlock monoText = new() { FontSize = 44 };
    readonly TextBlock readout = new() { FontSize = 11, CharacterSpacing = 140, IsHitTestVisible = false };
    readonly List<Button> itemButtons = [];
    readonly List<Button> railButtons = [];
    readonly DispatcherTimer settle = new() { Interval = TimeSpan.FromMilliseconds(320) };
    readonly DispatcherTimer serverSettle = new() { Interval = TimeSpan.FromMilliseconds(360) };

    List<Item> items = [];
    List<ServerVm> servers = [];
    Func<ChannelVm, (int Count, bool Live, int Mentions)> info = _ => (0, false, 0);
    int pos, spos;
    double wheel, swheel;

    public Dial()
    {
        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent); // takes the wheel everywhere
        IsTabStop = true;
        TabFocusNavigation = KeyboardNavigationMode.Once;
        dots.Source = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(new Uri("ms-appx:///Assets/dots-dial.png"));
        Children.Add(dots);
        scale.RotationTransition = new ScalarTransition { Duration = MoveTime };
        canvas.Children.Add(scale);
        monoText.FontFamily = Ui.Font("DisplayFont");
        monoText.Foreground = Ui.Brush("Cream");
        monoText.TextLineBounds = TextLineBounds.Tight;
        monoText.FontSize = 44;
        monoText.TextTrimming = TextTrimming.None;
        monogram.Content = monoText;
        monogram.Click += (_, _) =>
        {
            if (spos != CurrentServer()) GoServer(spos, true);
            else MonogramClicked?.Invoke(monogram);
        };
        ToolTipService.SetToolTip(monogram, "Switch server");
        canvas.Children.Add(monogram);
        readout.FontFamily = Ui.Font("MonoFont");
        canvas.Children.Add(readout);
        Children.Add(canvas);
        SizeChanged += (_, _) => Layout();
        // The header above changes height between views: re-centre on the window.
        LayoutUpdated += (_, _) => { if (Math.Abs(WindowCentre() - lastCy) > 0.5) Layout(); };
        PointerWheelChanged += OnWheel;
        KeyDown += OnKey;
        settle.Tick += (_, _) => { settle.Stop(); Activate(pos, false); };
        serverSettle.Tick += (_, _) => { serverSettle.Stop(); if (spos < servers.Count) ServerPicked?.Invoke(servers[spos]); };
    }

    ServerVm? currentServer;
    int CurrentServer() => currentServer is null ? 0 : Math.Max(0, servers.IndexOf(currentServer));

    /// <summary>
    /// The server's channels (text first, then voice; owners get the two "+"
    /// items), the one shown, the server list and per-channel badges.
    /// </summary>
    public void Update(IReadOnlyList<ChannelVm> channels, ChannelVm? selected, bool owner,
        IReadOnlyList<ServerVm> serverList, ServerVm? server, Func<ChannelVm, (int Count, bool Live, int Mentions)> badges)
    {
        info = badges;
        var list = channels.Where(c => !c.Voice).Concat(channels.Where(c => c.Voice)).Select(c => new Item(c, false)).ToList();
        if (owner && server is not null) { list.Add(new Item(null, false)); list.Add(new Item(null, true)); }
        var structural = list.Count != items.Count || list.Zip(items).Any(p => p.First.Channel != p.Second.Channel || p.First.NewVoice != p.Second.NewVoice);
        items = list;
        var serversChanged = !serverList.SequenceEqual(servers);
        servers = [.. serverList];
        var serverMoved = server != currentServer;
        currentServer = server;
        if (serverMoved || serversChanged) spos = CurrentServer();
        if (selected is not null && !settle.IsEnabled)
        {
            var i = items.FindIndex(it => it.Channel == selected);
            if (i >= 0) pos = i;
        }
        if (pos >= items.Count) pos = Math.Max(0, items.Count - 1);
        if (structural) BuildItems();
        if (serversChanged) BuildRail();
        Layout();
    }

    static string Initials(string name)
    {
        var s = string.Concat(name.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(w => char.ToUpperInvariant(w[0])));
        return s.Length == 0 ? "—" : s.Length > 3 ? s[..3] : s;
    }

    void BuildItems()
    {
        foreach (var b in itemButtons) canvas.Children.Remove(b);
        itemButtons.Clear();
        for (var i = 0; i < items.Count; i++)
        {
            var index = i;
            var b = new Button
            {
                Height = ItemH, Padding = new Thickness(14, 0, 14, 0), MinWidth = 0,
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(1),
                BorderBrush = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                FontSize = 15, IsTabStop = false,
                CenterPoint = new Vector3(0, (float)ItemH / 2, 0),
            };
            b.Click += (_, _) => { pos = index; Layout(); Activate(index, true); };
            itemButtons.Add(b);
            canvas.Children.Add(b);
        }
    }

    void BuildRail()
    {
        foreach (var b in railButtons) canvas.Children.Remove(b);
        railButtons.Clear();
        for (var i = 0; i < servers.Count; i++)
        {
            var index = i;
            var t = Ui.Display(44);
            var b = new Button
            {
                Content = t, Background = null, BorderThickness = new Thickness(0), Padding = new Thickness(0), IsTabStop = false,
            };
            ToolTipService.SetToolTip(b, servers[i].Name);
            b.Click += (_, _) => GoServer(index, true);
            railButtons.Add(b);
            canvas.Children.Insert(1, b); // under the monogram and the pills
        }
    }

    /// <summary>Lay everything out for the current position (cheap: transforms only).</summary>
    void Layout()
    {
        var w = ActualWidth;
        var h = ActualHeight;
        if (w <= 0 || h <= 0) return;
        // Centred on the window, not on this row (like the web's --dial-y): the
        // monogram and the selected key never move when you switch channels.
        var cy = Math.Clamp(WindowCentre(), 80, Math.Max(80, h - 80));
        var instant = Math.Abs(cy - lastCy) > 0.5 && lastCy > 0; // the row moved: follow it, don't animate
        lastCy = cy;
        var cream = Ui.Brush("Cream");
        var cream55 = Ui.Brush("Cream55");
        var cream35 = Ui.Brush("Cream35");
        var gutter = 28.0;

        // monogram (measured, so any initials fit) and the geometry from it
        var mono = spos < servers.Count ? Initials(servers[spos].Name) : currentServer is null ? "" : Initials(currentServer.Name);
        if (mono != monoText.Text)
        {
            var first = monoText.Text.Length == 0;
            monoText.Text = mono;
            if (!first) SlideIn(monoText, spos >= lastSpos ? 1 : -1);
        }
        lastSpos = spos;
        monogram.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        var monoW = monogram.DesiredSize.Width;
        Canvas.SetLeft(monogram, gutter);
        Canvas.SetTop(monogram, cy - monogram.DesiredSize.Height / 2);
        var x0 = Math.Max(gutter + monoW + 34, Math.Min(160, w * 0.42));
        var centerX = x0 - Radius;
        var maxW = Math.Max(72, w - x0 - 8);

        // dots: centred on the dial's row
        dots.Margin = new Thickness(0, cy - 450, 0, 0);
        dots.VerticalAlignment = VerticalAlignment.Top;

        // scale: arcs and ticks, turned so the selected tick points right
        scale.Children.Clear();
        var hair = Ui.Brush("Hair");
        var cream20 = Ui.Brush("Cream20");
        var signal = Ui.Brush("Signal");
        scale.Children.Add(Circle(ScaleR, hair, null));
        scale.Children.Add(Circle(ScaleR - 26, cream20, [1, 6]));
        for (var i = 0; i < items.Count; i++)
        {
            for (var k = 0; k < (i < items.Count - 1 ? 4 : 1); k++)
            {
                var major = k == 0;
                var on = major && i == pos;
                var len = on ? 20 : major ? 11 : 5;
                var a = (i * StepDeg + k * StepDeg / 4) * Math.PI / 180;
                scale.Children.Add(new Line
                {
                    X1 = Math.Cos(a) * (ScaleR - len), Y1 = Math.Sin(a) * (ScaleR - len),
                    X2 = Math.Cos(a) * ScaleR, Y2 = Math.Sin(a) * ScaleR,
                    Stroke = on ? signal : major ? cream55 : cream20, StrokeThickness = on ? 2 : 1,
                });
            }
        }
        Canvas.SetLeft(scale, centerX);
        Canvas.SetTop(scale, cy);
        if (instant) Instant(scale, () => scale.Rotation = (float)(-pos * StepDeg));
        else scale.Rotation = (float)(-pos * StepDeg);

        // readout: 01/08 TXT
        var it0 = pos < items.Count ? items[pos] : null;
        var kind = it0 is null ? "" : it0.Channel is null ? "NEW" : it0.Channel.Voice ? "VOX" : "TXT";
        readout.Inlines.Clear();
        readout.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run { Text = (pos + 1).ToString("00"), Foreground = cream });
        readout.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run { Text = "/" + items.Count.ToString("00"), Foreground = cream35 });
        readout.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run { Text = "   " + kind, Foreground = cream35 });
        Canvas.SetLeft(readout, gutter);
        Canvas.SetTop(readout, cy + 30);

        // channel keys on the arc
        for (var i = 0; i < itemButtons.Count && i < items.Count; i++)
        {
            var b = itemButtons[i];
            var it = items[i];
            var off = i - pos;
            var theta = off * StepDeg;
            var r = theta * Math.PI / 180;
            var x = centerX + Radius * Math.Cos(r);
            var y = Radius * Math.Sin(r);
            var hidden = Math.Abs(off) > Visible;
            Place(b, new Vector3((float)x, (float)(cy + y - ItemH / 2), 0), (float)theta, hidden ? 0 : Math.Max(0, 1 - Math.Abs(off) * 0.17), MoveTime, instant);
            b.IsHitTestVisible = !hidden;
            b.MaxWidth = maxW;
            var cursor = off == 0;
            b.Background = cursor ? Ui.Brush("Key") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            b.BorderBrush = cursor ? cream20 : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            b.Content = ItemContent(it, cursor, cream, cream55, cream35, signal);
        }

        // the server rail: neighbours above and below the monogram, smaller and fainter
        for (var i = 0; i < railButtons.Count; i++)
        {
            var off = i - spos;
            var k = Math.Min(3, Math.Abs(off));
            var b = railButtons[i];
            ((TextBlock)b.Content).Text = Initials(servers[i].Name);
            var gone = off == 0 || Math.Abs(off) > 3;
            b.IsHitTestVisible = !gone;
            b.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var bh = b.DesiredSize.Height;
            b.CenterPoint = new Vector3(0, (float)bh / 2, 0);
            b.ScaleTransition ??= new Vector3Transition { Duration = Rail };
            var sc = (float)(Math.Abs(off) > 3 ? 0.2 : RailScale[k]);
            if (instant || b.TranslationTransition is null) Instant(b, () => b.Scale = new Vector3(sc, sc, 1)); else b.Scale = new Vector3(sc, sc, 1);
            Place(b, new Vector3((float)gutter, (float)(cy - bh / 2 + Math.Sign(off) * (Math.Abs(off) > 3 ? 240 : RailY[k])), 0), 0,
                gone ? 0 : RailOpacity[k], Rail, instant);
        }
    }

    static readonly TimeSpan MoveTime = TimeSpan.FromMilliseconds(280), Rail = TimeSpan.FromMilliseconds(420), Mono = TimeSpan.FromMilliseconds(480);
    double lastCy;
    int lastSpos;

    /// <summary>The window's vertical centre, in this control's coordinates.</summary>
    double WindowCentre()
    {
        if (XamlRoot?.Content is not FrameworkElement root || root.ActualHeight <= 0) return ActualHeight / 2;
        try { return root.ActualHeight / 2 - TransformToVisual(root).TransformPoint(new Point(0, 0)).Y; }
        catch (ArgumentException) { return ActualHeight / 2; }
    }

    /// <summary>
    /// Move an element (composition translation / rotation / opacity, animated
    /// like the web's CSS transitions). Its first placement is instant (it fades
    /// in); instant also skips the animation when the whole dial moved.
    /// </summary>
    static void Place(UIElement e, Vector3 at, float rotation, double opacity, TimeSpan duration, bool instant)
    {
        if (e.TranslationTransition is null)
        {
            e.Translation = at;
            e.Rotation = rotation;
            e.Opacity = 0;
            e.TranslationTransition = new Vector3Transition { Duration = duration };
            e.RotationTransition = new ScalarTransition { Duration = duration };
            e.OpacityTransition = new ScalarTransition { Duration = TimeSpan.FromMilliseconds(500) };
            e.Opacity = opacity; // a new server's channels fade into place
            return;
        }
        if (instant)
        {
            Instant(e, () => { e.Translation = at; e.Rotation = rotation; });
            e.Opacity = opacity;
            return;
        }
        e.Translation = at;
        e.Rotation = rotation;
        e.Opacity = opacity;
    }

    /// <summary>Apply a change without its transitions, then restore them.</summary>
    static void Instant(UIElement e, Action set)
    {
        var (t, r, sc) = (e.TranslationTransition, e.RotationTransition, e.ScaleTransition);
        e.TranslationTransition = null;
        e.RotationTransition = null;
        e.ScaleTransition = null;
        set();
        e.DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
        {
            e.TranslationTransition = t;
            e.RotationTransition = r;
            e.ScaleTransition = sc;
        });
    }

    /// <summary>The monogram's new initials rise (or drop) into place: .mono-txt from-below / from-above.</summary>
    void SlideIn(TextBlock t, int dir)
    {
        t.TranslationTransition = null;
        t.OpacityTransition = null;
        t.Translation = new Vector3(0, (float)(dir * 0.7 * Math.Max(30, t.ActualHeight)), 0);
        t.Opacity = 0;
        t.DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
        {
            t.TranslationTransition = new Vector3Transition { Duration = Mono };
            t.OpacityTransition = new ScalarTransition { Duration = Mono };
            t.Translation = Vector3.Zero;
            t.Opacity = 1;
        });
    }

    object ItemContent(Item it, bool cursor, Brush cream, Brush cream55, Brush cream35, Brush signal)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var fg = cursor ? Ui.Brush("White") : it.Channel is null ? cream35 : cream55;
        if (it.Channel is { Voice: true })
            row.Children.Add(VoiceGlyph(fg));
        row.Children.Add(new TextBlock
        {
            Text = it.Channel?.Name ?? (it.NewVoice ? "+ Voice room" : "+ Channel"),
            Foreground = fg, FontSize = 15, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center,
        });
        if (it.Channel is { } c)
        {
            var (count, live, mentions) = info(c);
            if (c.Voice && count > 0)
                row.Children.Add(new TextBlock { Text = count.ToString(), FontSize = 12, Foreground = cream55, VerticalAlignment = VerticalAlignment.Center, FontFamily = Ui.Font("MonoFont") });
            if (mentions > 0)
                row.Children.Add(new Border
                {
                    Background = signal, Padding = new Thickness(4, 0, 4, 0), VerticalAlignment = VerticalAlignment.Center,
                    Child = new TextBlock { Text = "@" + mentions, FontSize = 11, Foreground = Ui.Brush("Ink"), FontFamily = Ui.Font("MonoSemiFont") },
                });
            else if (live)
                row.Children.Add(new Rectangle { Width = 8, Height = 8, Fill = signal, VerticalAlignment = VerticalAlignment.Center });
        }
        if (cursor) row.Children.Add(new TextBlock { Text = "›", Foreground = cream55, Margin = new Thickness(-2, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center });
        return row;
    }

    static FrameworkElement VoiceGlyph(Brush fg)
    {
        var c = new Canvas { Width = 12, Height = 12, VerticalAlignment = VerticalAlignment.Center };
        foreach (var (x, y, h) in new[] { (1.0, 4.0, 4.0), (5.0, 1.5, 9.0), (9.0, 3.0, 6.0) })
        {
            var r = new Rectangle { Width = 2, Height = h, RadiusX = 1, RadiusY = 1, Fill = fg };
            Canvas.SetLeft(r, x);
            Canvas.SetTop(r, y);
            c.Children.Add(r);
        }
        return c;
    }

    static Ellipse Circle(double r, Brush stroke, double[]? dash)
    {
        var e = new Ellipse { Width = r * 2, Height = r * 2, Stroke = stroke, StrokeThickness = 1 };
        if (dash is not null) e.StrokeDashArray = [.. dash];
        Canvas.SetLeft(e, -r);
        Canvas.SetTop(e, -r);
        return e;
    }

    void Activate(int i, bool immediate)
    {
        if (i < 0 || i >= items.Count) return;
        settle.Stop();
        var it = items[i];
        if (it.Channel is null) { if (immediate) NewChannel?.Invoke(it.NewVoice); return; }
        if (immediate) ChannelPicked?.Invoke(it.Channel);
        else ChannelPicked?.Invoke(it.Channel);
    }

    void Move(int d)
    {
        var n = Math.Clamp(pos + d, 0, Math.Max(0, items.Count - 1));
        if (n == pos) return;
        pos = n;
        Layout();
        settle.Stop();
        settle.Start();
    }

    void GoServer(int i, bool immediate)
    {
        if (i < 0 || i >= servers.Count) return;
        spos = i;
        Layout();
        serverSettle.Stop();
        if (immediate) ServerPicked?.Invoke(servers[i]);
        else serverSettle.Start();
    }

    void OnWheel(object sender, PointerRoutedEventArgs e)
    {
        var p = e.GetCurrentPoint(this);
        var d = p.Properties.MouseWheelDelta;
        e.Handled = true;
        var x0 = 28 + monogram.DesiredSize.Width + 34;
        var centerX = Math.Max(x0, Math.Min(160, ActualWidth * 0.42)) - Radius;
        if (Math.Sqrt(Math.Pow(p.Position.X - centerX, 2) + Math.Pow(p.Position.Y - ActualHeight / 2, 2)) < ScaleR)
        {
            swheel -= d;
            while (Math.Abs(swheel) >= 60) { GoServer(Math.Clamp(spos + Math.Sign(swheel), 0, servers.Count - 1), false); swheel -= Math.Sign(swheel) * 60; }
            return;
        }
        wheel -= d;
        while (Math.Abs(wheel) >= 60) { Move(Math.Sign(wheel)); wheel -= Math.Sign(wheel) * 60; }
    }

    void OnKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Down) { Move(1); e.Handled = true; }
        else if (e.Key == VirtualKey.Up) { Move(-1); e.Handled = true; }
        else if (e.Key == VirtualKey.Enter) { Activate(pos, true); e.Handled = true; }
    }
}
