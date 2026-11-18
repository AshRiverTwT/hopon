// Games beside the chat (port of client/ui/src/components/GamesPanel.tsx):
// tabs for each game, "Open in browser" / "Close", a note, and the game's real
// website in a WebView2. The webview exists only while the panel is open (its
// browser process and memory go with it).
//
// Results: the core's hook script runs in every page and reports what the
// game shares by setting document.title to "HOPON_RESULT:<encoded>"; the core
// validates it against the game's pattern and posts it to general (the same
// path as the Tauri build). New windows (ads) are refused.

using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace HopOn.App;

public sealed partial class GamesPanel : Grid
{
    static readonly (string Id, string Name)[] Games = [("wordle", "Wordle"), ("cryptic", "Minute Cryptic"), ("krillion", "Krillion")];

    readonly Store store;
    readonly StackPanel tabs = new() { Orientation = Orientation.Horizontal, Spacing = 16 };
    readonly Border host = new() { Background = Ui.Brush("Ink2") };
    readonly TextBlock loading = new() { Foreground = Ui.Brush("Cream55"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    readonly Grid hostGrid = new();
    WebView2? web;
    string game;
    string? hook;

    public GamesPanel(Store store, Action close)
    {
        this.store = store;
        game = store.PrefString("game", "wordle") is var g && Games.Any(x => x.Id == g) ? g : "wordle";
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        // head: tabs on top; the note and the actions under them
        var head = new Grid { Padding = new Thickness(0, 8, 0, 12), RowSpacing = 8, ColumnSpacing = 12 };
        head.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        head.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumnSpan(tabs, 2);
        head.Children.Add(tabs);
        var note = new TextBlock { Text = "Hit Share when you finish: your result posts to general.", FontSize = 12, LineHeight = 16, Foreground = Ui.Brush("Cream35"), TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
        Grid.SetRow(note, 1);
        head.Children.Add(note);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 14, VerticalAlignment = VerticalAlignment.Center };
        actions.Children.Add(Link("Open in browser", () => _ = Run("games_open_external", new JsonObject { ["game"] = game })));
        actions.Children.Add(Link("Close", close));
        Grid.SetRow(actions, 1);
        Grid.SetColumn(actions, 1);
        head.Children.Add(actions);
        Children.Add(head);

        hostGrid.Children.Add(loading);
        host.Child = hostGrid;
        Grid.SetRow(host, 1);
        Children.Add(host);
        RenderTabs();
        // The column slides open first; the game appears once it has settled (like the web, 340 ms).
        var t = DispatcherQueue.CreateTimer();
        t.Interval = TimeSpan.FromMilliseconds(340);
        t.IsRepeating = false;
        t.Tick += (_, _) => _ = Open(game);
        t.Start();
    }

    static HyperlinkButton Link(string text, Action click)
    {
        var l = new HyperlinkButton { Content = text, Padding = new Thickness(0), FontSize = 13, Foreground = Ui.Brush("Cream55") };
        l.Click += (_, _) => click();
        return l;
    }

    void RenderTabs()
    {
        tabs.Children.Clear();
        foreach (var (id, name) in Games)
        {
            var on = id == game;
            var label = new StackPanel { Orientation = Orientation.Horizontal };
            label.Children.Add(new TextBlock { Text = name.ToUpperInvariant(), FontFamily = Ui.Font("CondensedFont"), FontSize = 19, Foreground = Ui.Brush(on ? "Cream" : "Cream35") });
            if (on) label.Children.Add(new TextBlock { Text = " ›", FontFamily = Ui.Font("CondensedFont"), FontSize = 19, Foreground = Ui.Brush("White") });
            var b = new Button { Content = label, Background = null, BorderThickness = new Thickness(0), Padding = new Thickness(0) };
            var gid = id;
            b.Click += (_, _) => { if (gid != game) _ = Open(gid); };
            tabs.Children.Add(b);
        }
    }

    async Task<string?> Run(string name, JsonObject args)
    {
        try { return (await App.Core.CallAsync(name, args)).ToString(); }
        catch (HopOnException e) { loading.Text = e.Message; return null; }
    }

    async Task Open(string id)
    {
        game = id;
        RenderTabs();
        if (store.PrefString("game", "") != id) _ = store.SavePref("game", id);
        loading.Text = $"Loading {Games.First(g => g.Id == id).Name}…";
        string url;
        try { url = (await App.Core.CallAsync("games_select", new JsonObject { ["game"] = id, ["serverId"] = store.OpenServer?.Id ?? "0" })).GetString() ?? ""; }
        catch (HopOnException e) { loading.Text = e.Message; return; }
        try
        {
            if (web is null)
            {
                hook ??= (await App.Core.CallAsync("games_hook")).GetString();
                // Its own profile folder, next to the app's data.
                Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER",
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "app.hopon.desktop", "games-webview"));
                web = new WebView2 { DefaultBackgroundColor = Microsoft.UI.ColorHelper.FromArgb(255, 0x15, 0x15, 0x16) };
                hostGrid.Children.Add(web);
                await web.EnsureCoreWebView2Async();
                var core = web.CoreWebView2;
                if (hook is not null) await core.AddScriptToExecuteOnDocumentCreatedAsync(hook);
                core.NewWindowRequested += (_, e) => e.Handled = true; // ads must not open windows
                core.DocumentTitleChanged += (_, _) =>
                {
                    var title = core.DocumentTitle ?? "";
                    if (title.StartsWith("HOPON_RESULT:", StringComparison.Ordinal))
                        _ = Run("games_result", new JsonObject { ["encoded"] = title["HOPON_RESULT:".Length..] });
                };
                core.NavigationCompleted += (_, _) => loading.Text = "";
            }
            web.CoreWebView2.Navigate(url);
        }
        catch (Exception e)
        {
            loading.Text = $"Games need the Microsoft Edge WebView2 runtime ({e.Message})";
        }
    }

    /// <summary>Results go to the server you're looking at.</summary>
    public void ServerChanged(string serverId) => _ = Run("games_server", new JsonObject { ["serverId"] = serverId });

    /// <summary>Destroy the webview: its browser process and memory go with it.</summary>
    public void Shutdown()
    {
        _ = Run("games_deselect", []);
        if (web is not null)
        {
            hostGrid.Children.Remove(web);
            web.Close();
            web = null;
        }
    }
}
