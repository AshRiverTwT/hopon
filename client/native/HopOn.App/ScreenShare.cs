// Screen sharing UI: the source picker (screens and windows from the core's
// DesktopCapturer, plus the quality table shared with the web client) and the
// window that shows a stream you watch. Capture, encode, decode and the
// LiveKit connection are all in the core (voice::screen).

using System.Runtime.InteropServices.WindowsRuntime;
using HopOn.Native;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace HopOn.App;

public static class SharePicker
{
    sealed record Item(string Id, string Label)
    {
        public override string ToString() => Label;
    }

    /// <summary>Same choices as the web client (QUALITIES in screen.ts).</summary>
    static readonly (string Id, string Label)[] Qualities =
    [
        ("720p30", "720p · 30 fps — lightest on your PC and connection"),
        ("720p60", "720p · 60 fps — smooth, light on bandwidth"),
        ("1080p60", "1080p · 60 fps — sharp and smooth"),
        ("1440p60", "1440p · 60 fps — sharpest; needs a fast upload"),
    ];

    /// <summary>Pick a screen or window and start sharing. False if cancelled or it failed.</summary>
    public static async Task<bool> Show(XamlRoot root, Store store)
    {
        var list = new ListView { Height = 300, SelectionMode = ListViewSelectionMode.Single };
        var quality = new ComboBox { Header = "Quality", HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var (id, label) in Qualities) quality.Items.Add(new Item(id, label));
        var saved = store.PrefString("streamQuality", "1080p60");
        quality.SelectedIndex = Math.Max(0, Array.FindIndex(Qualities, x => x.Id == saved));
        var status = new TextBlock { Text = "Looking for screens and windows…", Opacity = 0.7, FontSize = 12, TextWrapping = TextWrapping.Wrap };
        var panel = new StackPanel { Spacing = 10, MinWidth = 420 };
        panel.Children.Add(list);
        panel.Children.Add(quality);
        panel.Children.Add(status);
        var dialog = new ContentDialog
        {
            XamlRoot = root,
            Title = "Share your screen",
            Content = panel,
            PrimaryButtonText = "Share",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            IsPrimaryButtonEnabled = false,
        };
        list.SelectionChanged += (_, _) => dialog.IsPrimaryButtonEnabled = list.SelectedItem is not null;
        list.DoubleTapped += (_, _) => { if (list.SelectedItem is not null) dialog.Hide(); };

        _ = Load();
        async Task Load()
        {
            var sources = await store.ScreenSources();
            foreach (var s in sources.Where(s => s.Kind == "screen"))
                list.Items.Add(new Item(s.Id, "🖥  " + s.Title));
            foreach (var s in sources.Where(s => s.Kind == "window"))
                list.Items.Add(new Item(s.Id, "🗔  " + s.Title));
            if (list.Items.Count > 0) list.SelectedIndex = 0;
            status.Text = sources.Count == 0
                ? "Nothing to share was found."
                : "Computer sound isn't included yet in the native app.";
        }

        var picked = false;
        dialog.PrimaryButtonClick += (_, _) => picked = true;
        list.DoubleTapped += (_, _) => picked = list.SelectedItem is not null;
        await dialog.ShowAsync();
        if (!picked || list.SelectedItem is not Item source) return false;
        var q = (quality.SelectedItem as Item)?.Id ?? "1080p60";
        _ = store.SavePref("streamQuality", q);
        return await store.StartShare(source.Id, q);
    }
}

/// <summary>
/// One watched stream in its own window (resizable, fullscreen on double-click
/// or F11, Esc leaves fullscreen). Frames are pulled from the core at display
/// refresh, at the size the window shows them; closing it stops watching.
/// </summary>
public sealed class StreamWindow : Window
{
    static readonly Dictionary<string, StreamWindow> open = [];

    readonly Store store;
    readonly string userId;
    readonly Image image = new() { Stretch = Stretch.Uniform };
    readonly TextBlock status = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Opacity = 0.7 };
    readonly TextBlock viewers = new() { FontSize = 12, Opacity = 0.8, VerticalAlignment = VerticalAlignment.Center };
    readonly Grid bar;
    WriteableBitmap? bitmap;
    byte[] buffer = [];
    ulong seq;
    bool closed;
    DateTime lastMove = DateTime.UtcNow;
    Microsoft.UI.Dispatching.DispatcherQueueTimer? volumeTimer;

    /// <summary>Open (or bring forward) the stream window for this sharer and start watching.</summary>
    public static void Open(Store store, string userId)
    {
        if (open.TryGetValue(userId, out var w)) { w.Activate(); return; }
        w = new StreamWindow(store, userId);
        open[userId] = w;
        w.Activate();
        _ = w.Start();
    }

    /// <summary>Close every stream window (voice left).</summary>
    public static void CloseAll()
    {
        foreach (var w in open.Values.ToList()) w.Close();
    }

    public static bool IsOpen(string userId) => open.ContainsKey(userId);

    StreamWindow(Store store, string userId)
    {
        this.store = store;
        this.userId = userId;
        Title = $"{store.NameOf(userId)}'s screen — HopOn";
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1280, 760));
        var icon = Path.Combine(AppContext.BaseDirectory, "HopOn.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon);

        var volume = new Slider { Minimum = 0, Maximum = 200, Value = store.StreamVolume(userId), Width = 140, VerticalAlignment = VerticalAlignment.Center };
        volume.ValueChanged += (_, e) =>
        {
            volumeTimer?.Stop();
            _ = store.SetStreamVolume(userId, (int)e.NewValue);
            // Save the synced pref once the slider settles.
            volumeTimer = DispatcherQueue.CreateTimer();
            volumeTimer.Interval = TimeSpan.FromMilliseconds(600);
            volumeTimer.IsRepeating = false;
            var pct = (int)e.NewValue;
            volumeTimer.Tick += (_, _) => _ = store.SaveStreamVolume(userId, pct);
            volumeTimer.Start();
        };
        var full = new Button { Content = "Fullscreen", FontSize = 12, Padding = new Thickness(8, 3, 8, 3) };
        full.Click += (_, _) => ToggleFullscreen();
        var stop = new Button { Content = "Stop watching", FontSize = 12, Padding = new Thickness(8, 3, 8, 3) };
        stop.Click += (_, _) => Close();
        var right = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
        right.Children.Add(new TextBlock { Text = "🔊", VerticalAlignment = VerticalAlignment.Center });
        right.Children.Add(volume);
        right.Children.Add(full);
        right.Children.Add(stop);
        bar = new Grid { Padding = new Thickness(12, 6, 12, 6), VerticalAlignment = VerticalAlignment.Bottom, Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0xb0, 0, 0, 0)) };
        bar.Children.Add(viewers);
        bar.Children.Add(right);

        var root = new Grid { Background = new SolidColorBrush(Microsoft.UI.Colors.Black), RequestedTheme = ElementTheme.Dark };
        root.Children.Add(image);
        root.Children.Add(status);
        root.Children.Add(bar);
        root.DoubleTapped += (_, _) => ToggleFullscreen();
        root.PointerMoved += (_, _) => { lastMove = DateTime.UtcNow; bar.Opacity = 1; };
        root.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.F11) ToggleFullscreen();
            else if (e.Key == Windows.System.VirtualKey.Escape && AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen) ToggleFullscreen();
        };
        Content = root;
        status.Text = "Connecting…";

        store.ScreenChanged += OnScreenChanged;
        CompositionTarget.Rendering += OnRendering;
        Closed += (_, _) =>
        {
            closed = true;
            CompositionTarget.Rendering -= OnRendering;
            store.ScreenChanged -= OnScreenChanged;
            open.Remove(userId);
            if (store.Screen.Watching.Contains(userId)) _ = store.Unwatch(userId);
        };
        OnScreenChanged();
    }

    async Task Start()
    {
        if (!await store.Watch(userId)) { if (!closed) Close(); return; }
        var v = store.StreamVolume(userId);
        if (v != 100) _ = store.SetStreamVolume(userId, v);
    }

    void ToggleFullscreen() =>
        AppWindow.SetPresenter(AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen ? AppWindowPresenterKind.Default : AppWindowPresenterKind.FullScreen);

    void OnScreenChanged()
    {
        if (closed) return;
        var n = store.ViewerCount(userId);
        viewers.Text = n <= 1 ? store.NameOf(userId) : $"{store.NameOf(userId)} · {n} watching";
        // The sharer stopped (or you left voice): the core already stopped watching.
        if (!store.IsSharing(userId) && seq > 0) { status.Text = "The stream ended."; image.Source = null; }
    }

    void OnRendering(object? sender, object e)
    {
        if (closed) return;
        // Hide the control bar after 2.5 s without the mouse moving.
        if (bar.Opacity > 0 && (DateTime.UtcNow - lastMove).TotalSeconds > 2.5) bar.Opacity = 0;
        // Pull at the size shown (physical pixels): no point decoding 1440p into a small window.
        var scale = Content.XamlRoot?.RasterizationScale ?? 1;
        var maxW = Math.Max(2, (int)(image.ActualWidth > 0 ? image.ActualWidth * scale : 1280));
        var maxH = Math.Max(2, (int)(image.ActualHeight > 0 ? image.ActualHeight * scale : 720));
        if (Content is FrameworkElement fe && fe.ActualWidth > 0)
        {
            maxW = Math.Max(2, (int)(fe.ActualWidth * scale));
            maxH = Math.Max(2, (int)(fe.ActualHeight * scale));
        }
        var need = maxW * maxH * 4;
        if (buffer.Length < need) buffer = new byte[need];
        if (!store.ScreenFrame(userId, seq, buffer, maxW, maxH, out var w, out var h, out var s)) return;
        seq = s;
        if (bitmap is null || bitmap.PixelWidth != w || bitmap.PixelHeight != h)
        {
            bitmap = new WriteableBitmap(w, h);
            image.Source = bitmap;
        }
        using (var px = bitmap.PixelBuffer.AsStream())
            px.Write(buffer, 0, w * h * 4);
        bitmap.Invalidate();
        if (status.Text.Length > 0) status.Text = "";
    }
}
