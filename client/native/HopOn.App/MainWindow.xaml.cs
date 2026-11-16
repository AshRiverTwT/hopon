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
        App.Host.SetWindow(WinRT.Interop.WindowNative.GetWindowHandle(this));
        AppWindow.Changed += OnAppWindowChanged;

        Store.Changed += Render;
        Store.Toast += ShowToast;
        Store.Appended += ScrollToEnd;
        Store.Painted += MarkPainted;
        toastTimer = dispatcher.CreateTimer();
        toastTimer.Interval = TimeSpan.FromSeconds(4);
        toastTimer.Tick += (_, _) => { Toast.IsOpen = false; toastTimer.Stop(); };

        // First events (prefs, session) are delivered right here, synchronously:
        // the store only queues them.
        App.Core.Subscribe("main", (UiEvent e) => Store.Enqueue(e));

        CompositionTarget.Rendering += OnFirstFrame;
        _ = LoadConfig();
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
        _ = Store.OpenChannelRow(vm);
    }

    void OnComposerKeyDown(object sender, KeyRoutedEventArgs e)
    {
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
    }
}
