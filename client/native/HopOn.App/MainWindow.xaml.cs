using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using VirtualKey = Windows.System.VirtualKey;

namespace HopOn.App;

public sealed partial class MainWindow : Window
{
    public Store Store { get; }

    readonly DispatcherQueue dispatcher;
    readonly DispatcherQueueTimer toastTimer;
    readonly List<string> paintPending = [];
    bool paintArmed;
    bool readySent;

    public MainWindow()
    {
        dispatcher = DispatcherQueue.GetForCurrentThread();
        Store = new Store(dispatcher, App.Core);
        InitializeComponent();

        AppWindow.Resize(new Windows.Graphics.SizeInt32(1200, 780));
        var iconPath = Path.Combine(AppContext.BaseDirectory, "HopOn.ico");
        if (File.Exists(iconPath)) AppWindow.SetIcon(iconPath);
        if (!App.PerfExit && File.Exists(iconPath))
        {
            // After the first frame: not on the startup path.
            dispatcher.TryEnqueue(DispatcherQueuePriority.Low, () =>
            {
                tray = new TrayIcon(iconPath, "HopOn");
                tray.Open += ShowFromTray;
                tray.Quit += () => _ = QuitApp();
            });
        }
        AppWindow.Closing += OnClosing;
        App.Host.SetWindow(WinRT.Interop.WindowNative.GetWindowHandle(this));
        AppWindow.Changed += OnAppWindowChanged;

        Store.Changed += Render;
        Store.Changed += () => { if (Store.OpenServer is { } sv && !Store.HomeMode) lastServer = sv; };
        Store.VoiceChanged += () => { if (Store.View == View.Shell) { if (!Store.HomeMode) SyncDial(); RenderStage(); } };
        Store.ScreenChanged += () => { if (Store.View == View.Shell) RenderStage(); };
        ChannelDial.ChannelPicked += OnDialChannel;
        ChannelDial.NewChannel += OnDialNewChannel;
        ChannelDial.ServerPicked += sv => { stage = null; if (sv != Store.OpenServer) _ = Store.SelectServer(sv); };
        ChannelDial.MonogramClicked += OnMonogram;
        Root.SizeChanged += (_, _) => FitTitle();
        // The status corner's clock: once a minute, on the minute.
        var clock = DispatcherQueue.CreateTimer();
        clock.Interval = TimeSpan.FromSeconds(60.05 - DateTime.Now.Second - DateTime.Now.Millisecond / 1000.0);
        clock.Tick += (t, _) => { t.Interval = TimeSpan.FromSeconds(60); if (Store.View == View.Shell) RenderStatus(); };
        clock.Start();
        var splashTimer = DispatcherQueue.CreateTimer();
        splashTimer.Interval = TimeSpan.FromSeconds(5);
        splashTimer.IsRepeating = false;
        splashTimer.Tick += (_, _) => Store.GiveUpSplash();
        splashTimer.Start();
        Store.Toast += ShowToast;
        Store.Appended += ScrollToEnd;
        Store.Painted += MarkPainted;
        Store.TypingChanged += line => TypingText.Text = line;
        Store.ComposerModeChanged += OnComposerModeChanged;
        Store.Notify += OnNotify;
        Activated += (_, e) => Store.Looking = e.WindowActivationState != WindowActivationState.Deactivated && AppWindow.IsVisible;
        App.NotificationClicked += channelId => dispatcher.TryEnqueue(() =>
        {
            AppWindow.Show();
            Activate();
            _ = Store.OpenChannelById(channelId);
        });
        toastTimer = dispatcher.CreateTimer();
        toastTimer.Interval = TimeSpan.FromSeconds(4);
        toastTimer.Tick += (_, _) => { Toast.Visibility = Visibility.Collapsed; toastTimer.Stop(); };

        // First events (prefs, session) are delivered right here, synchronously:
        // the store only queues them.
        App.Core.Subscribe("main", (UiEvent e) => Store.Enqueue(e));

        // Built on first use: keeps it out of startup.
        GifButton.Click += (_, _) =>
        {
            if (GifButton.Flyout is null) { GifButton.Flyout = GifFlyout.Create(Store, NowMs); GifButton.Flyout.ShowAt(GifButton); }
        };
        MessageVm.ContextMenuAction = ShowMessageMenu;
        AddShortcuts();
        MessageVm.ShowProfileAction = (userId, anchor) => _ = ShowProfileCard(userId, anchor);
        ChannelVm.Act = (c, what) => _ = ChannelAction(c, what);
        MemberVm.KickAction = (id, name) => _ = KickMember(id, name);
        CompositionTarget.Rendering += OnFirstFrame;
        _ = LoadConfig();
    }

    // ---------- keyboard shortcuts (the README's defaults) ----------

    void AddShortcuts()
    {
        void Add(VirtualKey key, Windows.System.VirtualKeyModifiers mods, Action act)
        {
            var a = new KeyboardAccelerator { Key = key, Modifiers = mods };
            a.Invoked += (_, e) => { e.Handled = true; act(); };
            Root.KeyboardAccelerators.Add(a);
        }
        var alt = Windows.System.VirtualKeyModifiers.Menu;
        var shift = Windows.System.VirtualKeyModifiers.Shift;
        var ctrl = Windows.System.VirtualKeyModifiers.Control;
        Add(VirtualKey.Down, alt, () => _ = Store.StepChannel(1, false));
        Add(VirtualKey.Up, alt, () => _ = Store.StepChannel(-1, false));
        Add(VirtualKey.Down, alt | shift, () => _ = Store.StepChannel(1, true));
        Add(VirtualKey.Up, alt | shift, () => _ = Store.StepChannel(-1, true));
        Add(VirtualKey.Down, ctrl | alt, () => _ = Store.StepServer(1));
        Add(VirtualKey.Up, ctrl | alt, () => _ = Store.StepServer(-1));
        Add(VirtualKey.T, ctrl, () => Composer.Focus(FocusState.Keyboard));
        Add(VirtualKey.M, ctrl | shift, () => { if (Store.MyVoice is { State: not "idle" } v) _ = Store.SetMuted(!v.Muted); });
        Add(VirtualKey.D, ctrl | shift, () => { if (Store.MyVoice is { State: not "idle" } v) _ = Store.SetDeafened(!v.Deafened); });
        // Shortcuts work everywhere, but don't advertise tooltips on the root.
        Root.KeyboardAcceleratorPlacementMode = KeyboardAcceleratorPlacementMode.Hidden;
    }

    // ---------- tray ----------

    TrayIcon? tray;
    bool quitting;

    void OnClosing(AppWindow sender, AppWindowClosingEventArgs e)
    {
        if (quitting) return;
        if (Store.CloseToTray && tray is not null)
        {
            // Hide: voice, notifications and hotkeys keep working.
            e.Cancel = true;
            AppWindow.Hide();
            App.Host.SetHidden(true);
            _ = App.Core.CallAsync("ui_set_visibility", new JsonObject { ["visible"] = false });
            return;
        }
        e.Cancel = true;
        _ = QuitApp();
    }

    void ShowFromTray()
    {
        AppWindow.Show();
        if (AppWindow.Presenter is OverlappedPresenter p && p.State == OverlappedPresenterState.Minimized) p.Restore();
        Activate();
        App.Host.SetHidden(false);
        _ = App.Core.CallAsync("ui_set_visibility", new JsonObject { ["visible"] = true });
    }

    /// <summary>Quit for real: leave voice cleanly (≤ 800 ms), then exit; 3 s at most in all.</summary>
    async Task QuitApp()
    {
        if (quitting) return;
        quitting = true;
        _ = Task.Run(async () => { await Task.Delay(3000); Environment.Exit(0); });
        try { await App.Core.CallAsync("voice_leave").WaitAsync(TimeSpan.FromMilliseconds(800)); }
        catch (Exception) { }
        tray?.Dispose();
        Environment.Exit(0);
    }

    // ---------- instrumentation (same protocol as the webview) ----------

    /// <summary>Unix ms, sub-ms precision, same clock as the core's SystemTime.</summary>
    static double NowMs() => (DateTime.UtcNow - DateTime.UnixEpoch).TotalMilliseconds;

    void OnFirstFrame(object? sender, object e)
    {
        CompositionTarget.Rendering -= OnFirstFrame;
        // Low priority runs after this frame's layout and render pass, like
        // setTimeout(0) from requestAnimationFrame in the webview.
        dispatcher.TryEnqueue(DispatcherQueuePriority.Low, () =>
        {
            if (readySent) return;
            readySent = true;
            _ = App.Core.CallAsync("ui_ready", new JsonObject { ["tPaintMs"] = NowMs() });
        });
    }

    void MarkPainted(List<string> keys)
    {
        paintPending.AddRange(keys);
        if (paintArmed) return;
        paintArmed = true;
        CompositionTarget.Rendering += OnPaintFrame;
    }

    void OnPaintFrame(object? sender, object e)
    {
        CompositionTarget.Rendering -= OnPaintFrame;
        dispatcher.TryEnqueue(DispatcherQueuePriority.Low, () =>
        {
            paintArmed = false;
            var t = NowMs();
            var marks = new JsonArray();
            foreach (var k in paintPending) marks.Add(new JsonArray(k, t));
            paintPending.Clear();
            _ = App.Core.CallAsync("perf_painted", new JsonObject { ["marks"] = marks });
        });
    }

    // ---------- rendering ----------

    /// <summary>The voice room shown in the main column (a voice channel picked on the dial), or null.</summary>
    ChannelVm? stage;

    static string Caps(string s) => s.ToUpperInvariant();

    void Render()
    {
        SplashView.Visibility = Store.View == View.Splash ? Visibility.Visible : Visibility.Collapsed;
        var conn = Store.ConnState switch
        {
            "online" => "",
            "offline" => "Can't reach the server. Retrying…",
            "incompatible" => "This server runs a different HopOn version.",
            _ => "Connecting to the server…",
        };
        SplashStatus.Text = Caps(conn);
        LoginConn.Text = conn.Length == 0 ? "" : conn;
        LoginView.Visibility = Store.View == View.Login ? Visibility.Visible : Visibility.Collapsed;
        ShellView.Visibility = Store.View == View.Shell ? Visibility.Visible : Visibility.Collapsed;
        if (Store.View != View.Shell)
        {
            if (Store.View == View.Login && UserBox.FocusState == FocusState.Unfocused) UserBox.Focus(FocusState.Programmatic);
            return;
        }

        // nav: Friends | Servers
        var home = Store.HomeMode;
        FriendsTab.Style = (Style)Application.Current.Resources[home ? "SolidKeyButton" : "KeyButton"];
        ServersTab.Style = (Style)Application.Current.Resources[home ? "KeyButton" : "SolidKeyButton"];
        FriendsTab.Height = ServersTab.Height = 36;
        var requests = Store.Friends.Count(f => f.State == "incoming");
        FriendsBadge.Visibility = requests > 0 ? Visibility.Visible : Visibility.Collapsed;
        FriendsBadgeText.Text = requests.ToString();
        FriendsPanel.Visibility = home ? Visibility.Visible : Visibility.Collapsed;
        ChannelDial.Visibility = home ? Visibility.Collapsed : Visibility.Visible;
        if (!home) SyncDial();

        // you (bottom left)
        var st = Store.MyStatus;
        MeText.Text = Store.Me?.Name ?? "";
        MeInitial.Text = Store.Me?.Name is { Length: > 0 } n ? n[..1].ToUpperInvariant() : "";
        MeAvatar.Source = Store.Me is { } me ? Store.AvatarOf(me.Id) : null;
        MeDot.Fill = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources[st?.Mode is "dnd" ? "Signal" : st?.Mode is "invisible" or "idle" ? "Cream35" : "Cream"];
        ToolTipService.SetToolTip(MeButton, st is { Text.Length: > 0 } ? $"{st.Emoji} {st.Text}".Trim() : "Your status");
        var v = Store.MyVoice;
        var muted = v?.Muted ?? false;
        var deafened = v?.Deafened ?? false;
        Toggle(MuteButton, MicLed, MicText, !muted, muted ? "MIC OFF" : "MIC ON");
        Toggle(DeafenButton, SoundLed, SoundText, !deafened, deafened ? "SOUND OFF" : "SOUND ON");

        // head + main: a text channel, or the voice room
        if (stage is not null && !Store.Channels.Contains(stage)) stage = null;
        var serverName = home ? "Direct messages" : Store.OpenServer?.Name ?? "";
        var room = stage is not null;
        if (room)
        {
            ServerTitle.Text = Caps($"Voice room · {serverName}");
            ChannelTitle.Text = Caps(stage!.Name);
            ChannelTopic.Text = "";
        }
        else
        {
            ServerTitle.Text = Store.OpenChannel is null ? Caps(serverName) : Caps($"{(home ? "Direct message" : "Text channel")} · {serverName}");
            ChannelTitle.Text = Caps(Store.OpenChannel?.Name ?? (home ? "Friends" : ""));
            ChannelTopic.Text = Store.OpenChannel?.Topic ?? "";
        }
        ChannelTopic.Visibility = ChannelTopic.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        FitTitle();
        MessageList.Visibility = room ? Visibility.Collapsed : Visibility.Visible;
        ComposerPanel.Visibility = room ? Visibility.Collapsed : Visibility.Visible;
        StagePanel.Visibility = room ? Visibility.Visible : Visibility.Collapsed;
        if (Store.OpenChannel is { } oc && !room)
        {
            var level = Store.ChannelLevel(oc.Id);
            BellAll.IsChecked = level == "all";
            BellMentions.IsChecked = level == "mentions";
            BellNone.IsChecked = level == "none";
            BellPath.Data = (Microsoft.UI.Xaml.Media.Geometry)Microsoft.UI.Xaml.Markup.XamlBindingHelper.ConvertValue(typeof(Microsoft.UI.Xaml.Media.Geometry),
                level == "none" ? "M4 11V7a4 4 0 016.7-3M12 7v4l1.2 1.5H5M6.5 14h3M2 2l12 12" : "M4 11V7a4 4 0 018 0v4l1.2 1.5H2.8zM6.5 14h3");
        }
        BellButton.Visibility = Store.OpenChannel is null || room ? Visibility.Collapsed : Visibility.Visible;
        Composer.PlaceholderText = Store.OpenChannel is null ? "" : $"Write in {Store.OpenChannel.Name}";
        Composer.IsEnabled = Store.OpenChannel is not null;
        AttachButton.IsEnabled = Store.OpenChannel is not null;
        GifButton.IsEnabled = Store.OpenChannel is not null;

        // side: toolbar strip, people
        ServerMenuButton.Visibility = Store.OpenServer is null || home ? Visibility.Collapsed : Visibility.Visible;
        PeopleKey.Visibility = Store.OpenServer is null || home ? Visibility.Collapsed : Visibility.Visible;
        PeopleCount.Text = Store.OpenServer?.MemberIds.Count.ToString() ?? "";
        CreateChannelItem.Visibility = Store.IsOwner ? Visibility.Visible : Visibility.Collapsed;
        ServerSettingsItem.Visibility = Store.IsOwner ? Visibility.Visible : Visibility.Collapsed;
        ChannelVm.OwnerTools = Store.IsOwner;
        LeaveServerItem.Visibility = Store.IsOwner ? Visibility.Collapsed : Visibility.Visible;
        OnlineHead.Text = $"ONLINE · {Store.Members.Count(m => m.Online)}";

        RenderStatus();
        RenderStage();
    }

    /// <summary>Mic / Sound key: a lit LED when on; transparent with a hollow LED when off.</summary>
    static void Toggle(Button b, Microsoft.UI.Xaml.Shapes.Rectangle led, TextBlock label, bool on, string text)
    {
        var res = Application.Current.Resources;
        label.Text = text;
        b.Background = on ? (Microsoft.UI.Xaml.Media.Brush)res["Key"] : new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent);
        label.Foreground = (Microsoft.UI.Xaml.Media.Brush)res[on ? "Cream80" : "Cream35"];
        led.Fill = on ? (Microsoft.UI.Xaml.Media.Brush)res["Signal"] : null;
        led.Stroke = on ? null : (Microsoft.UI.Xaml.Media.Brush)res["Cream35"];
        led.StrokeThickness = 1;
    }

    /// <summary>Titles fit the column like the web's clamp(34px, 5.2vw, 72px).</summary>
    void FitTitle()
    {
        var w = Root.ActualWidth > 0 ? Root.ActualWidth : 1200;
        ChannelTitle.FontSize = Math.Clamp(w * 0.052, 34, 72);
        var col = Math.Max(200, w - DialColumn.ActualWidth - RailColumn.ActualWidth - 80);
        ChannelTitle.MaxWidth = col;
        LoginHop.FontSize = LoginOn.FontSize = Math.Clamp(w * 0.11, 64, 168);
    }

    void SyncDial()
    {
        ChannelDial.Update(Store.Channels, stage ?? Store.OpenChannel, Store.IsOwner, Store.Servers, Store.OpenServer, c =>
        {
            var people = c.Voice ? Store.VoiceMembers(c.Id) : [];
            var live = c.Voice ? people.Any(p => Store.IsSpeaking(p.UserId)) : c.Unread && c != Store.OpenChannel;
            return (people.Count, live, 0);
        });
    }

    /// <summary>Bottom right: the light, the room you're live in, latency, clock.</summary>
    void RenderStatus()
    {
        var res = Application.Current.Resources;
        var v = Store.MyVoice;
        var inVoice = v is not null && v.State != "idle";
        var online = Store.ConnState == "online";
        StatusLed.Fill = (Microsoft.UI.Xaml.Media.Brush)res[!online ? "White" : inVoice ? "Signal" : "Cream35"];
        if (inVoice)
        {
            var roomName = Store.Channels.FirstOrDefault(c => c.Id == v!.ChannelId)?.Name ?? "voice";
            StatusVoice.Text = Caps($"{(v!.State == "connected" ? "Live" : v.State == "reconnecting" ? "Reconnecting" : "Joining")} · {roomName}");
            StatusVoice.Visibility = Visibility.Visible;
        }
        else StatusVoice.Visibility = Visibility.Collapsed;
        ConnText.Text = Caps(Store.ConnState switch
        {
            "online" => Store.RttMs is { } r ? (r < 1 ? "<1 ms" : $"{r:0} ms") : "Online",
            "connecting" => "Connecting",
            "incompatible" => "Update needed",
            _ => "Offline",
        });
        ClockText.Text = DateTime.Now.ToString("hh:mm tt", System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>The voice room: everyone in it (big names, like the web's index), Join / Leave, Stream.</summary>
    void RenderStage()
    {
        if (stage is null) return;
        var res = Application.Current.Resources;
        var v = Store.MyVoice;
        var joined = v is not null && v.State != "idle" && v.ChannelId == stage.Id;
        var connected = joined && v!.State == "connected";
        StagePeople.Children.Clear();
        var people = Store.VoiceMembers(stage.Id);
        if (people.Count == 0)
            StagePeople.Children.Add(new TextBlock { Text = "Nobody is here yet.", FontSize = 17, Foreground = (Microsoft.UI.Xaml.Media.Brush)res["Cream55"], Margin = new Thickness(0, 14, 0, 0) });
        foreach (var p in people.OrderBy(p => Store.NameOf(p.UserId), StringComparer.CurrentCultureIgnoreCase))
        {
            var row = new Grid { ColumnSpacing = 16, Padding = new Thickness(4, 14, 4, 14), BorderThickness = new Thickness(0, 0, 0, 1), BorderBrush = (Microsoft.UI.Xaml.Media.Brush)res["Cream10"] };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var name = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 14 };
            var speaking = Store.IsSpeaking(p.UserId);
            var av = new Grid { Width = 40, Height = 40 };
            av.Children.Add(new Border { Background = (Microsoft.UI.Xaml.Media.Brush)res["Cream10"], BorderThickness = new Thickness(speaking ? 2 : 0), BorderBrush = (Microsoft.UI.Xaml.Media.Brush)res["Signal"],
                Child = new TextBlock { Text = Store.NameOf(p.UserId)[..1].ToUpperInvariant(), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } });
            if (Store.AvatarOf(p.UserId) is { } img) av.Children.Add(new Image { Source = img, Stretch = Microsoft.UI.Xaml.Media.Stretch.UniformToFill, Margin = new Thickness(speaking ? 2 : 0) });
            name.Children.Add(av);
            name.Children.Add(new TextBlock { Text = Store.NameOf(p.UserId), FontSize = 28, VerticalAlignment = VerticalAlignment.Center, Foreground = (Microsoft.UI.Xaml.Media.Brush)res[speaking ? "Cream" : "Cream80"] });
            if (speaking) name.Children.Add(new Microsoft.UI.Xaml.Shapes.Rectangle { Width = 8, Height = 8, Fill = (Microsoft.UI.Xaml.Media.Brush)res["Signal"], VerticalAlignment = VerticalAlignment.Center });
            if (Store.IsSharing(p.UserId))
                name.Children.Add(new Border { Background = (Microsoft.UI.Xaml.Media.Brush)res["Signal"], Padding = new Thickness(5, 1, 5, 1), VerticalAlignment = VerticalAlignment.Center,
                    Child = new TextBlock { Text = "LIVE", FontSize = 11, FontFamily = (Microsoft.UI.Xaml.Media.FontFamily)res["MonoSemiFont"], Foreground = (Microsoft.UI.Xaml.Media.Brush)res["Ink"] } });
            row.Children.Add(name);
            var meta = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, VerticalAlignment = VerticalAlignment.Center };
            if (connected && p.UserId != Store.Me?.Id && Store.IsSharing(p.UserId))
            {
                var user = p.UserId;
                var watch = new Button { Content = StreamWindow.IsOpen(user) ? "OPEN" : "WATCH", Style = (Style)res["KeyButton"] };
                watch.Click += (_, _) => { StreamWindow.Open(Store, user); RenderStage(); };
                meta.Children.Add(watch);
            }
            var flags = string.Join(" · ", new[] { p.Muted ? "Mic off" : null, p.Deafened ? "Sound off" : null }.Where(x => x is not null));
            if (flags.Length > 0) meta.Children.Add(new TextBlock { Text = flags, FontSize = 13, Foreground = (Microsoft.UI.Xaml.Media.Brush)res["Cream55"], VerticalAlignment = VerticalAlignment.Center });
            Grid.SetColumn(meta, 1);
            row.Children.Add(meta);
            StagePeople.Children.Add(row);
        }
        StageJoin.Visibility = joined ? Visibility.Collapsed : Visibility.Visible;
        StageJoin.Content = v is not null && v.State != "idle" ? "SWITCH TO THIS ROOM" : "JOIN";
        StageJoin.IsEnabled = Store.ConnState == "online";
        StageLeave.Visibility = joined ? Visibility.Visible : Visibility.Collapsed;
        ShareButton.Visibility = joined ? Visibility.Visible : Visibility.Collapsed;
        ShareButton.IsEnabled = connected || Store.Screen.Sharing;
        ShareText.Text = Store.Screen.Sharing ? "STOP STREAMING" : "STREAM";
        VoiceText.Text = !joined ? "" : v!.State == "connected" ? "You're live" : v.State == "reconnecting" ? "Reconnecting…" : "Joining…";
        SyncSharers(v is not null && v.State != "idle");
    }

    ScrollViewer? messageScroll;

    void OnMessageListLoaded(object sender, RoutedEventArgs e)
    {
        messageScroll = FindChild<ScrollViewer>(MessageList);
        if (messageScroll is not null) messageScroll.ViewChanged += OnMessagesScrolled;
    }

    void OnMessagesScrolled(object? sender, ScrollViewerViewChangedEventArgs e)
    {
        if (messageScroll is null) return;
        Store.AtBottom = messageScroll.VerticalOffset >= messageScroll.ScrollableHeight - 48;
        if (messageScroll.VerticalOffset < 400 && messageScroll.ScrollableHeight > 0) _ = Store.LoadOlder();
    }

    static T? FindChild<T>(DependencyObject root) where T : DependencyObject
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var c = VisualTreeHelper.GetChild(root, i);
            if (c is T t) return t;
            if (FindChild<T>(c) is T deeper) return deeper;
        }
        return null;
    }

    void ScrollToEnd()
    {
        // Follow new messages only if the user is at the bottom (or just opened the channel).
        if (Store.Messages.Count > 0 && Store.AtBottom) MessageList.ScrollIntoView(Store.Messages[^1]);
    }

    void OnNotify(NotifyKind kind, string title, string body, string channelId)
    {
        if (kind == NotifyKind.Banner)
        {
            ShowToast($"{title}: {body}");
            return;
        }
        try
        {
            var n = new Microsoft.Windows.AppNotifications.Builder.AppNotificationBuilder()
                .AddArgument("channel", channelId)
                .AddText(title)
                .AddText(body)
                .BuildNotification();
            Microsoft.Windows.AppNotifications.AppNotificationManager.Default.Show(n);
        }
        catch (Exception x)
        {
            System.Diagnostics.Debug.WriteLine($"notification failed: {x.Message}");
        }
        App.Host.RequestAttention();
    }

    void ShowToast(string message)
    {
        ToastText.Text = message;
        Toast.Visibility = Visibility.Visible;
        toastTimer.Stop();
        toastTimer.Start();
    }

    void OnAppWindowChanged(AppWindow sender, AppWindowChangedEventArgs args)
    {
        if (args.DidPresenterChange || args.DidVisibilityChange || args.DidSizeChange)
        {
            var minimized = sender.Presenter is OverlappedPresenter p && p.State == OverlappedPresenterState.Minimized;
            var hidden = minimized || !sender.IsVisible;
            App.Host.SetHidden(hidden);
            _ = App.Core.CallAsync("ui_set_visibility", new JsonObject { ["visible"] = !hidden });
        }
    }

    // ---------- sign in ----------

    async Task LoadConfig()
    {
        try
        {
            var cfg = await App.Core.CallAsync("get_config", HopOnJson.Default.Config);
            UrlBox.Text = cfg.Url;
            AttachmentVm.HttpBase = Media.HttpBase(cfg.Url);
        }
        catch (HopOnException) { }
    }

    async Task Auth(string command)
    {
        LoginError.Text = "";
        SignInButton.IsEnabled = SignUpButton.IsEnabled = false;
        try
        {
            await App.Core.CallAsync("set_server_url", new JsonObject { ["url"] = UrlBox.Text });
            AttachmentVm.HttpBase = Media.HttpBase(UrlBox.Text.Trim());
            await App.Core.CallAsync(command, new JsonObject { ["username"] = UserBox.Text.Trim(), ["password"] = PassBox.Password });
        }
        catch (HopOnException e)
        {
            LoginError.Text = e.Message;
        }
        finally
        {
            SignInButton.IsEnabled = SignUpButton.IsEnabled = true;
        }
    }

    void OnSignIn(object sender, RoutedEventArgs e) => _ = Auth("login");
    void OnSignUp(object sender, RoutedEventArgs e) => _ = Auth("signup");

    // ---------- the message context menu (one, shared by every row) ----------

    MenuFlyout? messageMenu;
    MessageVm? menuTarget;
    MenuFlyoutItem? editItem, deleteItem;

    void ShowMessageMenu(MessageVm m, UIElement row, Microsoft.UI.Xaml.Input.ContextRequestedEventArgs e)
    {
        e.Handled = true;
        if (messageMenu is null)
        {
            messageMenu = new MenuFlyout();
            MenuFlyoutItem Item(string text, Action<MessageVm> act)
            {
                var i = new MenuFlyoutItem { Text = text };
                i.Click += (_, _) => { if (menuTarget is { } t) act(t); };
                return i;
            }
            messageMenu.Items.Add(Item("Reply", t => t.Reply()));
            var react = new MenuFlyoutSubItem { Text = "React" };
            foreach (var (emoji, i) in MessageVm.Quick.Select((x, i) => (x, i)))
                react.Items.Add(Item(emoji, t => t.QuickReactAt(i)));
            messageMenu.Items.Add(react);
            editItem = Item("Edit", t => t.BeginEdit());
            deleteItem = Item("Delete", t => t.Delete());
            messageMenu.Items.Add(editItem);
            messageMenu.Items.Add(deleteItem);
        }
        menuTarget = m;
        editItem!.Visibility = m.MineVisibility;
        deleteItem!.Visibility = m.DeleteVisibility;
        if (e.TryGetPosition(row, out var point)) messageMenu.ShowAt(row, point);
        else messageMenu.ShowAt((FrameworkElement)row);
    }

    async Task ShowProfileCard(string userId, FrameworkElement anchor)
    {
        var (p, avatar) = await Store.LoadProfile(userId);
        if (p is null) return;
        static string Date(long ms) => ms <= 0 ? "" : DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("d MMM yyyy");
        var card = new StackPanel { Spacing = 6, Width = 280 };
        card.Children.Add(new PersonPicture { Width = 72, Height = 72, ProfilePicture = avatar, DisplayName = p.User.Name, HorizontalAlignment = HorizontalAlignment.Left });
        card.Children.Add(new TextBlock { Text = p.User.Name, FontSize = 18, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold });
        card.Children.Add(new TextBlock { Text = "@" + p.Username, Opacity = 0.7 });
        if (p.Bio.Length > 0) card.Children.Add(new TextBlock { Text = p.Bio, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 0) });
        var dates = new List<string>();
        if (Date(p.CreatedAt) is { Length: > 0 } c) dates.Add($"HopOn member since {c}");
        if (Date(p.JoinedAt) is { Length: > 0 } j) dates.Add($"Joined this server {j}");
        if (dates.Count > 0) card.Children.Add(new TextBlock { Text = string.Join("\n", dates), FontSize = 12, Opacity = 0.6, Margin = new Thickness(0, 6, 0, 0) });
        new Flyout { Content = card }.ShowAt(anchor);
    }

    async Task<string?> Ask(string title, string header, string placeholder, string ok, Control? extra = null)
    {
        var box = new TextBox { Header = header, PlaceholderText = placeholder, MinWidth = 320 };
        var panel = new StackPanel { Spacing = 10 };
        panel.Children.Add(box);
        if (extra is not null) panel.Children.Add(extra);
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = title, Content = panel,
            PrimaryButtonText = ok, CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary && box.Text.Trim().Length > 0 ? box.Text.Trim() : null;
    }

    void OnEditProfile(object sender, RoutedEventArgs e) =>
        _ = ProfileDialog.Show(Content.XamlRoot, WinRT.Interop.WindowNative.GetWindowHandle(this), Store);

    void OnHome(object sender, RoutedEventArgs e)
    {
        stage = null;
        Store.ShowHome();
    }

    /// <summary>Servers tab: back to the last server (or the first).</summary>
    void OnServersTab(object sender, RoutedEventArgs e)
    {
        if (!Store.HomeMode) return;
        _ = Store.SelectServer(lastServer is not null && Store.Servers.Contains(lastServer) ? lastServer : Store.Servers.FirstOrDefault());
    }

    ServerVm? lastServer;

    /// <summary>The monogram: every server, plus create / join.</summary>
    void OnMonogram(FrameworkElement anchor)
    {
        var menu = new MenuFlyout();
        foreach (var sv in Store.Servers)
        {
            var item = new ToggleMenuFlyoutItem { Text = sv.Name, IsChecked = sv == Store.OpenServer };
            var target = sv;
            item.Click += (_, _) => { stage = null; _ = Store.SelectServer(target); };
            menu.Items.Add(item);
        }
        if (Store.Servers.Count > 0) menu.Items.Add(new MenuFlyoutSeparator());
        var create = new MenuFlyoutItem { Text = "Create a server…" };
        create.Click += OnCreateServer;
        var join = new MenuFlyoutItem { Text = "Join with an invite…" };
        join.Click += OnJoinServer;
        menu.Items.Add(create);
        menu.Items.Add(join);
        menu.ShowAt(anchor);
    }

    void OnDialChannel(ChannelVm vm)
    {
        if (vm.Voice)
        {
            // A voice room: show it (Join is a click away); the text channel stays open underneath.
            stage = vm;
            Render();
            return;
        }
        var wasStage = stage is not null;
        stage = null;
        if (vm != Store.OpenChannel) _ = Store.OpenChannelRow(vm);
        else if (wasStage) Render();
    }

    async void OnDialNewChannel(bool voice)
    {
        var box = new CheckBox { Content = "Voice room", IsChecked = voice };
        if (await Ask("Create a channel", "Name", voice ? "Lounge" : "new-channel", "Create", box) is { } name) await Store.CreateChannel(name, box.IsChecked == true);
    }

    void OnStageJoin(object sender, RoutedEventArgs e)
    {
        if (stage is not null) _ = Store.JoinVoice(stage);
    }

    async void OnAddFriend(object sender, RoutedEventArgs e)
    {
        if (await Ask("Add a friend", "Their username", "username", "Send request") is { } name) await Store.AddFriend(name);
    }

    async void OnCreateServer(object sender, RoutedEventArgs e)
    {
        if (await Ask("Create a server", "Name", "My server", "Create") is { } name) await Store.CreateServer(name);
    }

    async void OnJoinServer(object sender, RoutedEventArgs e)
    {
        if (await Ask("Join a server", "Invite", "hopon://invite/… or code", "Join") is { } code) await Store.JoinInvite(code);
    }

    async void OnInvite(object sender, RoutedEventArgs e)
    {
        if (await Store.CreateInvite() is not { } link) return;
        var data = new Windows.ApplicationModel.DataTransfer.DataPackage();
        data.SetText(link);
        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(data);
        ShowToast($"Invite link copied: {link}");
    }

    async void OnCreateChannel(object sender, RoutedEventArgs e)
    {
        var voice = new CheckBox { Content = "Voice room" };
        if (await Ask("Create a channel", "Name", "new-channel", "Create", voice) is { } name) await Store.CreateChannel(name, voice.IsChecked == true);
    }

    async void OnLeaveServer(object sender, RoutedEventArgs e)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = $"Leave {Store.OpenServer?.Name}?",
            Content = "You can come back with an invite.", PrimaryButtonText = "Leave", CloseButtonText = "Cancel",
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary) await Store.LeaveServer();
    }

    async Task<bool> Confirm(string title, string body, string ok, string? typeToConfirm = null)
    {
        var panel = new StackPanel { Spacing = 10 };
        panel.Children.Add(new TextBlock { Text = body, TextWrapping = TextWrapping.Wrap });
        TextBox? typed = null;
        if (typeToConfirm is not null)
        {
            typed = new TextBox { PlaceholderText = typeToConfirm, Header = $"Type \"{typeToConfirm}\" to confirm" };
            panel.Children.Add(typed);
        }
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = title, Content = panel, PrimaryButtonText = ok, CloseButtonText = "Cancel",
        };
        if (typed is not null)
        {
            dialog.IsPrimaryButtonEnabled = false;
            typed.TextChanged += (_, _) => dialog.IsPrimaryButtonEnabled = typed.Text.Trim() == typeToConfirm;
        }
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    async Task ChannelAction(ChannelVm c, string what)
    {
        switch (what)
        {
            case "rename":
                if (await Ask($"Rename #{c.Name}", "Name", c.Name, "Save") is { } name) await Store.UpdateChannel(c.Id, name, null);
                break;
            case "topic":
                if (await Ask($"Topic for #{c.Name}", "Topic", c.Topic, "Save") is { } topic) await Store.UpdateChannel(c.Id, null, topic);
                break;
            case "delete":
                if (await Confirm($"Delete #{c.Name}?", "Its messages are deleted for everyone.", "Delete", c.Name)) await Store.DeleteChannel(c.Id);
                break;
        }
    }

    async Task KickMember(string userId, string name)
    {
        if (await Confirm($"Remove {name}?", "They can come back with a new invite.", "Remove")) await Store.KickMember(userId);
    }

    async void OnServerSettings(object sender, RoutedEventArgs e)
    {
        if (Store.OpenServer is not { } sv) return;
        var name = new TextBox { Header = "Server name", Text = sv.Name, MinWidth = 320 };
        var revoke = new Button { Content = "Revoke all invite links" };
        var delete = new Button { Content = "Delete server…" };
        var panel = new StackPanel { Spacing = 12 };
        panel.Children.Add(name);
        panel.Children.Add(revoke);
        panel.Children.Add(delete);
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = "Server settings", Content = panel,
            PrimaryButtonText = "Save", CloseButtonText = "Close", DefaultButton = ContentDialogButton.Primary,
        };
        var deleteAsked = false;
        revoke.Click += async (_, _) => { await Store.RevokeInvites(); ShowToast("Invite links revoked"); };
        delete.Click += (_, _) => { deleteAsked = true; dialog.Hide(); };
        var r = await dialog.ShowAsync();
        if (r == ContentDialogResult.Primary && name.Text.Trim() is { Length: > 0 } n && n != sv.Name) await Store.RenameServer(n);
        if (deleteAsked && await Confirm($"Delete {sv.Name}?", "Every channel and message is deleted for everyone. This can't be undone.", "Delete server", sv.Name))
            await Store.DeleteServer();
    }

    async void OnBell(object sender, RoutedEventArgs e)
    {
        if (Store.OpenChannel is not { } ch || sender is not FrameworkElement { Tag: string level }) return;
        await Store.SetChannelLevel(ch.Id, level);
        Render();
    }

    void OnStatus(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: string mode }) return;
        _ = Store.SetStatus(mode, Store.MyStatus?.Emoji ?? "", Store.MyStatus?.Text ?? "");
    }

    void OnClearStatus(object sender, RoutedEventArgs e) => _ = Store.SetStatus(Store.MyStatus?.Mode ?? "online", "", "");

    async void OnCustomStatus(object sender, RoutedEventArgs e)
    {
        var emoji = new TextBox { Header = "Emoji", Width = 80, Text = Store.MyStatus?.Emoji ?? "" };
        var text = new TextBox { Header = "Status", Width = 260, MaxLength = 80, Text = Store.MyStatus?.Text ?? "" };
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        row.Children.Add(emoji);
        row.Children.Add(text);
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = "Custom status", Content = row,
            PrimaryButtonText = "Save", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
            await Store.SetStatus(Store.MyStatus?.Mode ?? "online", emoji.Text.Trim(), text.Text.Trim());
    }

    void OnSettings(object sender, RoutedEventArgs e) => _ = SettingsDialog.Show(Content.XamlRoot, Store);

    async void OnSignOut(object sender, RoutedEventArgs e)
    {
        try { await App.Core.CallAsync("logout"); }
        catch (HopOnException x) { ShowToast(x.Message); }
        PassBox.Password = "";
    }

    void OnPasswordKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter) _ = Auth("login");
    }

    // ---------- navigation and composing ----------

    void OnMute(object sender, RoutedEventArgs e) => _ = Store.SetMuted(!(Store.MyVoice?.Muted ?? false));
    void OnDeafen(object sender, RoutedEventArgs e) => _ = Store.SetDeafened(!(Store.MyVoice?.Deafened ?? false));
    void OnLeaveVoice(object sender, RoutedEventArgs e) => _ = Store.LeaveVoice();

    async void OnShareScreen(object sender, RoutedEventArgs e)
    {
        if (Store.Screen.Sharing) { await Store.StopShare(); return; }
        ShareButton.IsEnabled = false;
        try { await SharePicker.Show(Content.XamlRoot, Store); }
        finally { ShareButton.IsEnabled = true; }
    }

    /// <summary>Leaving voice closes every stream window (watching needs the room).</summary>
    void SyncSharers(bool inVoice)
    {
        if (!inVoice) StreamWindow.CloseAll();
    }

    async void OnAttach(object sender, RoutedEventArgs e)
    {
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        picker.FileTypeFilter.Add("*");
        // Unpackaged apps must give pickers their window.
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var files = await picker.PickMultipleFilesAsync();
        foreach (var f in files) _ = AddStorageFile(f);
    }

    // ---------- paste and drag-and-drop ----------

    void OnDragOver(object sender, DragEventArgs e)
    {
        if (Store.OpenChannel is not null && e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems))
        {
            e.AcceptedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.Copy;
            e.DragUIOverride.Caption = "Attach";
        }
    }

    async void OnDrop(object sender, DragEventArgs e)
    {
        if (Store.OpenChannel is null || !e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems)) return;
        var deferral = e.GetDeferral();
        try
        {
            foreach (var item in await e.DataView.GetStorageItemsAsync())
                if (item is Windows.Storage.StorageFile f) _ = AddStorageFile(f);
        }
        finally
        {
            deferral.Complete();
        }
    }

    /// <summary>Ctrl+V of an image or of copied files attaches them; text pastes as usual.</summary>
    async void OnComposerPaste(object sender, TextControlPasteEventArgs e)
    {
        var view = Windows.ApplicationModel.DataTransfer.Clipboard.GetContent();
        var formats = Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems;
        if (view.Contains(formats))
        {
            e.Handled = true;
            foreach (var item in await view.GetStorageItemsAsync())
                if (item is Windows.Storage.StorageFile f) _ = AddStorageFile(f);
            return;
        }
        if (!view.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Bitmap)) return;
        e.Handled = true;
        try
        {
            var reference = await view.GetBitmapAsync();
            using var source = await reference.OpenReadAsync();
            var decoder = await Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(source);
            using var bitmap = await decoder.GetSoftwareBitmapAsync();
            using var png = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            var encoder = await Windows.Graphics.Imaging.BitmapEncoder.CreateAsync(Windows.Graphics.Imaging.BitmapEncoder.PngEncoderId, png);
            encoder.SetSoftwareBitmap(bitmap);
            await encoder.FlushAsync();
            var bytes = new byte[png.Size];
            png.Seek(0);
            using (var reader = new Windows.Storage.Streams.DataReader(png.GetInputStreamAt(0)))
            {
                await reader.LoadAsync((uint)png.Size);
                reader.ReadBytes(bytes);
            }
            await Store.AddFile($"pasted-{DateTime.Now:yyyyMMdd-HHmmss}.png", bytes, decoder.PixelWidth, decoder.PixelHeight);
        }
        catch (Exception x)
        {
            ShowToast($"Couldn't paste the image: {x.Message}");
        }
    }

    async void OnCreatePoll(object sender, RoutedEventArgs e)
    {
        var question = new TextBox { Header = "Question", MaxLength = 200, MinWidth = 340 };
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(question);
        var options = new List<TextBox>();
        for (var i = 0; i < 5; i++)
        {
            var o = new TextBox { PlaceholderText = i < 2 ? $"Option {i + 1}" : $"Option {i + 1} (optional)", MaxLength = 80 };
            options.Add(o);
            panel.Children.Add(o);
        }
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot, Title = "Create a poll", Content = panel,
            PrimaryButtonText = "Post", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        var q = question.Text.Trim();
        var opts = options.Select(o => o.Text.Trim()).Where(t => t.Length > 0).ToList();
        if (q.Length == 0 || opts.Count < 2)
        {
            ShowToast("A poll needs a question and at least two options");
            return;
        }
        Store.Send(Polls.Encode(new Poll(q, opts)), NowMs());
    }

    async Task AddStorageFile(Windows.Storage.StorageFile f)
    {
        try
        {
            var buffer = await Windows.Storage.FileIO.ReadBufferAsync(f);
            var bytes = new byte[buffer.Length];
            using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(buffer)) reader.ReadBytes(bytes);
            uint w = 0, h = 0;
            if (f.ContentType.StartsWith("image/", StringComparison.Ordinal))
            {
                try
                {
                    using var stream = await f.OpenReadAsync();
                    var decoder = await Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
                    (w, h) = (decoder.PixelWidth, decoder.PixelHeight);
                }
                catch (Exception) { /* not decodable here: sent without a size */ }
            }
            await Store.AddFile(f.Name, bytes, w, h);
        }
        catch (Exception x)
        {
            ShowToast($"Couldn't read {f.Name}: {x.Message}");
        }
    }

    void OnComposerModeChanged()
    {
        if (Store.Editing is { } ed)
        {
            ComposerBannerText.Text = "Editing your message (Enter to save, Esc to cancel)";
            Composer.Text = Store.Editable(ed.Content);
            Composer.SelectionStart = Composer.Text.Length;
        }
        else if (Store.Replying is { } r)
        {
            ComposerBannerText.Text = $"Replying to {r.Author}: {Store.Preview(r)}";
        }
        ComposerBanner.Visibility = Store.Editing is null && Store.Replying is null ? Visibility.Collapsed : Visibility.Visible;
        if (Store.Editing is null && Store.Replying is not null || Store.Editing is not null) Composer.Focus(FocusState.Programmatic);
    }

    void OnCancelComposerMode(object sender, RoutedEventArgs e)
    {
        var wasEditing = Store.Editing is not null;
        Store.CancelComposerMode();
        if (wasEditing) Composer.Text = "";
    }

    void OnComposerKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (MentionList.Visibility == Visibility.Visible && MentionList.ItemsSource is List<string> { Count: > 0 } names)
        {
            switch (e.Key)
            {
                case VirtualKey.Tab:
                case VirtualKey.Enter:
                    e.Handled = true;
                    CompleteMention(names[Math.Max(0, MentionList.SelectedIndex)]);
                    return;
                case VirtualKey.Down:
                    e.Handled = true;
                    MentionList.SelectedIndex = (MentionList.SelectedIndex + 1) % names.Count;
                    return;
                case VirtualKey.Up:
                    e.Handled = true;
                    MentionList.SelectedIndex = (MentionList.SelectedIndex - 1 + names.Count) % names.Count;
                    return;
                case VirtualKey.Escape:
                    e.Handled = true;
                    MentionList.Visibility = Visibility.Collapsed;
                    return;
            }
        }
        if (e.Key == VirtualKey.Escape && (Store.Editing is not null || Store.Replying is not null))
        {
            e.Handled = true;
            OnCancelComposerMode(sender, e);
            return;
        }
        if (e.Key != VirtualKey.Enter) return;
        var shift = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift);
        if ((shift & Windows.UI.Core.CoreVirtualKeyStates.Down) != 0) return;
        e.Handled = true;
        var t = NowMs();
        var text = Composer.Text;
        Composer.Text = "";
        Store.Send(text, t);
    }

    void OnComposerChanged(object sender, TextChangedEventArgs e)
    {
        if (Composer.Text.Length > 0) Store.Typing();
        UpdateMentions();
    }

    /// <summary>"@que" right before the caret (after a space or at the start), or null.</summary>
    string? MentionQuery(out int start)
    {
        start = -1;
        var caret = Math.Min(Composer.SelectionStart, Composer.Text.Length);
        var before = Composer.Text[..caret];
        var at = before.LastIndexOf('@');
        if (at < 0 || (at > 0 && !char.IsWhiteSpace(before[at - 1]) && before[at - 1] != '(')) return null;
        var q = before[(at + 1)..];
        if (q.Length > 32 || q.Contains('\n') || q.Contains('@')) return null;
        start = at;
        return q;
    }

    void UpdateMentions()
    {
        var q = MentionQuery(out _);
        var list = q is null ? [] : Store.MentionSuggestions(q);
        MentionList.ItemsSource = list;
        MentionList.SelectedIndex = list.Count > 0 ? 0 : -1;
        MentionList.Visibility = list.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    void CompleteMention(string name)
    {
        if (MentionQuery(out var start) is null) return;
        var caret = Math.Min(Composer.SelectionStart, Composer.Text.Length);
        var insert = "@" + name + " ";
        Composer.Text = Composer.Text[..start] + insert + Composer.Text[caret..];
        Composer.SelectionStart = start + insert.Length;
        MentionList.Visibility = Visibility.Collapsed;
        Composer.Focus(FocusState.Programmatic);
    }

    void OnMentionClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is string name) CompleteMention(name);
    }
}
