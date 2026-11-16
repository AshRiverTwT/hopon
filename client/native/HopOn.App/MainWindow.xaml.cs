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
    bool syncing;

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
            tray = new TrayIcon(iconPath, "HopOn");
            tray.Open += ShowFromTray;
            tray.Quit += () => _ = QuitApp();
        }
        AppWindow.Closing += OnClosing;
        App.Host.SetWindow(WinRT.Interop.WindowNative.GetWindowHandle(this));
        AppWindow.Changed += OnAppWindowChanged;

        Store.Changed += Render;
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
        toastTimer.Tick += (_, _) => { Toast.IsOpen = false; toastTimer.Stop(); };

        // First events (prefs, session) are delivered right here, synchronously:
        // the store only queues them.
        App.Core.Subscribe("main", (UiEvent e) => Store.Enqueue(e));

        CompositionTarget.Rendering += OnFirstFrame;
        _ = LoadConfig();
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

    void Render()
    {
        SplashView.Visibility = Store.View == View.Splash ? Visibility.Visible : Visibility.Collapsed;
        LoginView.Visibility = Store.View == View.Login ? Visibility.Visible : Visibility.Collapsed;
        ShellView.Visibility = Store.View == View.Shell ? Visibility.Visible : Visibility.Collapsed;
        MeText.Text = Store.Me?.Name ?? "";
        ConnText.Text = Store.ConnState switch
        {
            "online" => "Connected",
            "connecting" => "Connecting…",
            "incompatible" => "Update needed",
            _ => "Offline, reconnecting…",
        };
        ServerTitle.Text = Store.OpenServer?.Name ?? "";
        ChannelTitle.Text = Store.OpenChannel is null ? "" : "# " + Store.OpenChannel.Name;
        ChannelTopic.Text = Store.OpenChannel?.Topic ?? "";
        Composer.PlaceholderText = Store.OpenChannel is null ? "" : $"Message #{Store.OpenChannel.Name}";
        Composer.IsEnabled = Store.OpenChannel is not null;
        AttachButton.IsEnabled = Store.OpenChannel is not null;

        var v = Store.MyVoice;
        var inVoice = v is not null && v.State != "idle";
        VoicePanel.Visibility = inVoice ? Visibility.Visible : Visibility.Collapsed;
        if (inVoice)
        {
            var room = Store.Channels.FirstOrDefault(c => c.Id == v!.ChannelId)?.Name ?? "voice";
            VoiceText.Text = v!.State switch
            {
                "connected" => $"Voice connected · {room}",
                "connecting" => $"Connecting to {room}…",
                "reconnecting" => $"Reconnecting to {room}…",
                _ => $"{v.State} · {room}",
            };
            MuteButton.IsChecked = v.Muted;
            DeafenButton.IsChecked = v.Deafened;
        }

        syncing = true;
        ServerList.SelectedItem = Store.OpenServer;
        ChannelList.SelectedItem = Store.OpenChannel;
        syncing = false;
        if (Store.View == View.Login && UserBox.FocusState == FocusState.Unfocused) UserBox.Focus(FocusState.Programmatic);
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
        Toast.Message = message;
        Toast.IsOpen = true;
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

    void OnServerSelected(object sender, SelectionChangedEventArgs e)
    {
        if (syncing || ServerList.SelectedItem is not ServerVm vm || vm == Store.OpenServer) return;
        _ = Store.SelectServer(vm);
    }

    void OnChannelSelected(object sender, SelectionChangedEventArgs e)
    {
        if (syncing || ChannelList.SelectedItem is not ChannelVm vm || vm == Store.OpenChannel) return;
        if (vm.Voice)
        {
            // A voice room: join it, keep the text channel open.
            syncing = true;
            ChannelList.SelectedItem = Store.OpenChannel;
            syncing = false;
            _ = Store.JoinVoice(vm);
            return;
        }
        _ = Store.OpenChannelRow(vm);
    }

    void OnMute(object sender, RoutedEventArgs e) => _ = Store.SetMuted(MuteButton.IsChecked == true);
    void OnDeafen(object sender, RoutedEventArgs e) => _ = Store.SetDeafened(DeafenButton.IsChecked == true);
    void OnLeaveVoice(object sender, RoutedEventArgs e) => _ = Store.LeaveVoice();

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
