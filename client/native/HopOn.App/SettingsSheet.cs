// Settings as a cascading drill-down menu (port of client/ui/src/components/
// Settings.tsx and the .cascade styles): a full-window sheet, categories on
// the left in Archivo Condensed caps (fading with distance, stepped in), the
// category's options on the right as "caption / ‹ VALUE ›", the whole menu
// turned 4°. Keyboard: ↑/↓ move, → / Enter go deeper or cycle, ← back / cycle
// back, Esc closes. Values are the same synced prefs the web client uses.

using System.Text.Json;
using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using VirtualKey = Windows.System.VirtualKey;

namespace HopOn.App;

public sealed partial class SettingsSheet : Grid
{
    sealed record Opt(string Label, Func<string> Value, Action<int> Step);
    sealed record Cat(string Name, List<Opt> Opts);

    readonly Store store;
    readonly Action close;
    readonly Action editProfile;
    readonly StackPanel catsPanel = new();
    readonly StackPanel optsPanel = new();
    readonly TextBlock note = new() { FontSize = 13, Foreground = Ui.Brush("Cream55"), Margin = new Thickness(28, 0, 0, 24), VerticalAlignment = VerticalAlignment.Bottom };
    List<Cat> cats = [];
    int cat;
    int opt = -1; // -1 = focus on the category column
    string? capturing; // "ptt" or a hotkey action
    JsonElement? devices;
    string url = "";

    static readonly string[] ModeOrder = ["online", "dnd", "invisible"];
    static readonly Dictionary<string, string> ModeLabel = new() { ["online"] = "Online", ["idle"] = "Online", ["dnd"] = "Do not disturb", ["invisible"] = "Invisible" };
    static readonly (string Id, string Label, string Default)[] Actions =
    [
        ("nextChannel", "Next channel", "Alt+ArrowDown"), ("prevChannel", "Previous channel", "Alt+ArrowUp"),
        ("nextUnread", "Next unread channel", "Alt+Shift+ArrowDown"), ("prevUnread", "Previous unread channel", "Alt+Shift+ArrowUp"),
        ("nextServer", "Next server", "Ctrl+Alt+ArrowDown"), ("prevServer", "Previous server", "Ctrl+Alt+ArrowUp"),
        ("toggleMute", "Mute / unmute (global)", "Ctrl+Shift+KeyM"), ("toggleDeafen", "Deafen / undeafen (global)", "Ctrl+Shift+KeyD"),
        ("toggleGames", "Games panel", "Ctrl+KeyG"), ("focusComposer", "Jump to message box", "Ctrl+KeyT"),
        ("zoomIn", "Zoom in", "Ctrl+Equal"), ("zoomOut", "Zoom out", "Ctrl+Minus"), ("zoomReset", "Reset zoom", "Ctrl+Digit0"),
        ("overlay", "In-game overlay: show / hide (works in games)", "Alt+Backquote"), ("overlayType", "In-game overlay: type a message", "Ctrl+Backquote"),
    ];

    public SettingsSheet(Store store, Action close, Action editProfile)
    {
        this.store = store;
        this.close = close;
        this.editProfile = editProfile;
        Background = Ui.Brush("Ink");
        IsTabStop = true;
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(76) });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        // sheet bar: the mark + HopOn, Close
        var bar = new Grid { Padding = new Thickness(28, 0, 28, 0) };
        var word = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, VerticalAlignment = VerticalAlignment.Center };
        word.Children.Add(Mark(22));
        word.Children.Add(new TextBlock { Text = "HopOn", FontSize = 17, FontFamily = Ui.Font("TextMediumFont"), Foreground = Ui.Brush("Cream"), VerticalAlignment = VerticalAlignment.Center });
        bar.Children.Add(word);
        var closeKey = Ui.Key("CLOSE");
        closeKey.HorizontalAlignment = HorizontalAlignment.Right;
        closeKey.VerticalAlignment = VerticalAlignment.Center;
        closeKey.Click += (_, _) => close();
        bar.Children.Add(closeKey);
        Children.Add(bar);

        // the cascade: turned -4°, categories | options
        var cascade = new Grid
        {
            ColumnSpacing = 56, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(28, 0, 28, 60), RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5),
            RenderTransform = new RotateTransform { Angle = -4 },
        };
        cascade.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        cascade.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(520) });
        catsPanel.HorizontalAlignment = HorizontalAlignment.Right;
        catsPanel.VerticalAlignment = VerticalAlignment.Center;
        cascade.Children.Add(catsPanel);
        var scroll = new ScrollViewer { Content = optsPanel, VerticalAlignment = VerticalAlignment.Center, MaxHeight = 560, Padding = new Thickness(0, 0, 8, 0) };
        Grid.SetColumn(scroll, 1);
        cascade.Children.Add(scroll);
        Grid.SetRow(cascade, 1);
        Children.Add(cascade);
        Grid.SetRow(note, 1);
        Children.Add(note);

        KeyDown += OnKey;
        PointerPressed += OnPointer;
        Loaded += (_, _) => Focus(FocusState.Programmatic);
        cats = Build();
        Render();
        _ = Load();
    }

    /// <summary>The HopOn mark (logo-mark): two legs and the orange bar.</summary>
    public static Viewbox Mark(double size)
    {
        var c = new Canvas { Width = 512, Height = 512 };
        foreach (var (x, y, w, h, brush) in new[] { (100.0, 160.0, 96.0, 256.0, "Cream"), (316, 96, 96, 256, "Cream"), (196, 228, 120, 64, "Signal") })
        {
            var r = new Microsoft.UI.Xaml.Shapes.Rectangle { Width = w, Height = h, Fill = Ui.Brush(brush) };
            Canvas.SetLeft(r, x);
            Canvas.SetTop(r, y);
            c.Children.Add(r);
        }
        return new Viewbox { Width = size, Height = size, Child = c, VerticalAlignment = VerticalAlignment.Center };
    }

    async Task Load()
    {
        try { devices = await App.Core.CallAsync("audio_devices"); }
        catch (HopOnException) { devices = null; note.Text = "Audio devices are unavailable in this build."; }
        try { url = (await App.Core.CallAsync("get_config", HopOnJson.Default.Config)).Url; }
        catch (HopOnException) { }
        Render();
    }

    string OnOff(bool b) => b ? "On" : "Off";
    async void Call(string name, JsonObject args)
    {
        try { await App.Core.CallAsync(name, args); }
        catch (HopOnException e) { note.Text = e.Message; }
    }
    void Toggle(string key, bool fallback) => _ = store.SavePref(key, !store.PrefBool(key, fallback));

    string DeviceName(bool input)
    {
        if (devices is not { } d) return "Unavailable";
        var id = d.TryGetProperty(input ? "input" : "output", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        foreach (var x in d.GetProperty(input ? "inputs" : "outputs").EnumerateArray())
            if (x.GetProperty("id").GetString() == id) return x.GetProperty("name").GetString() ?? "?";
        return "System default";
    }

    void CycleDevice(bool input, int dir)
    {
        if (devices is not { } d) return;
        var list = new List<(string? Id, string Name)> { (null, "System default") };
        foreach (var x in d.GetProperty(input ? "inputs" : "outputs").EnumerateArray())
            list.Add((x.GetProperty("id").GetString(), x.GetProperty("name").GetString() ?? "?"));
        var cur = d.TryGetProperty(input ? "input" : "output", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var i = Math.Max(0, list.FindIndex(x => x.Id == cur));
        var next = list[(i + (dir == 0 ? 1 : dir) + list.Count) % list.Count];
        Call("audio_set_device", new JsonObject { ["input"] = input, ["id"] = next.Id });
        // Keep the shown value in step (the core doesn't send device events).
        var obj = JsonNode.Parse(d.GetRawText())!.AsObject();
        obj[input ? "input" : "output"] = next.Id;
        devices = JsonDocument.Parse(obj.ToJsonString()).RootElement;
    }

    void Processing(string key)
    {
        _ = store.SavePref(key, !store.PrefBool(key, true));
        Call("audio_processing", new JsonObject { ["aec"] = store.PrefBool("aec", true), ["ns"] = store.PrefBool("ns", true), ["agc"] = store.PrefBool("agc", true) });
    }

    void SavePtt(bool enabled, int key)
    {
        _ = store.SavePref("ptt", enabled);
        _ = store.SavePref("pttKey", key);
        Call("voice_ptt", new JsonObject { ["enabled"] = enabled, ["keyCode"] = key });
    }

    static string VkName(int vk)
    {
        if (vk >= 0x70 && vk <= 0x87) return $"F{vk - 0x6f}";
        var named = new Dictionary<int, string> { [0x14] = "Caps Lock", [0x20] = "Space", [0xc0] = "`", [0x12] = "Alt", [0x11] = "Ctrl", [0x10] = "Shift", [0x1004] = "Mouse 4", [0x1005] = "Mouse 5" };
        return named.TryGetValue(vk, out var n) ? n : vk >= 0x30 && vk <= 0x5a ? ((char)vk).ToString() : $"Key {vk}";
    }

    string Hotkey(string id, string fallback)
    {
        try
        {
            using var doc = JsonDocument.Parse(store.PrefsJson);
            if (doc.RootElement.TryGetProperty("hotkeys", out var h) && h.TryGetProperty(id, out var v) && v.ValueKind == JsonValueKind.String) return v.GetString()!;
        }
        catch (JsonException) { }
        return fallback;
    }

    static string ComboLabel(string c)
    {
        if (c.Length == 0) return "Not set";
        var names = new Dictionary<string, string>
        {
            ["ArrowDown"] = "↓", ["ArrowUp"] = "↑", ["ArrowLeft"] = "←", ["ArrowRight"] = "→", ["Backquote"] = "`", ["Equal"] = "=", ["Minus"] = "-",
            ["Space"] = "Space", ["Enter"] = "Enter", ["Tab"] = "Tab", ["Escape"] = "Esc", ["Backspace"] = "Backspace", ["PageUp"] = "PgUp", ["PageDown"] = "PgDn",
        };
        return string.Join(" + ", c.Split('+').Select(p => names.TryGetValue(p, out var n) ? n : p.Replace("Key", "").Replace("Digit", "").Replace("Numpad", "Num ")));
    }

    List<Cat> Build() =>
    [
        new("Profile", [
            new("Profile · picture, banner, colour, about me", () => "Edit", d => { if (d == 0) { close(); editProfile(); } }),
            new("Status · idle is automatic after 10 minutes away", () => ModeLabel.GetValueOrDefault(store.MyStatus?.Mode ?? "online", "Online"), d =>
            {
                var i = Math.Max(0, Array.IndexOf(ModeOrder, store.MyStatus?.Mode ?? "online"));
                _ = store.SetStatus(ModeOrder[(i + (d == -1 ? ModeOrder.Length - 1 : 1)) % ModeOrder.Length], store.MyStatus?.Emoji ?? "", store.MyStatus?.Text ?? "");
            }),
            new("Show what I'm playing", () => OnOff(store.PrefBool("showActivity", true)), dir =>
            {
                var on = !store.PrefBool("showActivity", true);
                _ = store.SavePref("showActivity", on);
                Call("activity_sharing", new JsonObject { ["enabled"] = on });
            }),
        ]),
        new("Audio", [
            new("Microphone", () => DeviceName(true), d => CycleDevice(true, d)),
            new("Output", () => DeviceName(false), d => CycleDevice(false, d)),
            new("Join / leave sounds", () => OnOff(store.PrefBool("sounds", true)), _ => Toggle("sounds", true)),
        ]),
        new("Notifications", [
            new("Windows notifications · when HopOn is in the background or tray", () => OnOff(store.PrefBool("systemNotify", true)), _ => Toggle("systemNotify", true)),
            new("In-app notifications · messages in other channels", () => OnOff(store.PrefBool("appNotify", true)), _ => Toggle("appNotify", true)),
            new("Notification sound", () => OnOff(store.PrefBool("notifySound", true)), _ => Toggle("notifySound", true)),
            new("Per channel · bell next to the channel name", () => "All · @ · Off", _ => { }),
        ]),
        new("Voice", [
            new("Echo cancellation · off for headsets", () => OnOff(store.PrefBool("aec", true)), _ => Processing("aec")),
            new("Noise suppression", () => OnOff(store.PrefBool("ns", true)), _ => Processing("ns")),
            new("Auto gain", () => OnOff(store.PrefBool("agc", true)), _ => Processing("agc")),
        ]),
        new("Controls", [
            new("Push to talk", () => OnOff(store.PrefBool("ptt", false)), _ => SavePtt(!store.PrefBool("ptt", false), store.PrefInt("pttKey", 0))),
            new("Talk key", () => capturing == "ptt" ? "Press a key" : store.PrefInt("pttKey", 0) is var k and > 0 ? VkName(k) : "Not set", d => { if (d == 0) capturing = "ptt"; }),
            new("Latency overlay", () => "Ctrl+Shift+P", _ => { }),
        ]),
        new("Display", [
            new("Close button · hides to the tray", () => store.PrefBool("closeToTray", true) ? "Tray" : "Quit", _ => Toggle("closeToTray", true)),
            new("Mini player · streams follow you out of the voice room", () => OnOff(store.PrefBool("autoPip", true)), _ => Toggle("autoPip", true)),
            new("Low resource streams", () => OnOff(store.PrefBool("lowResource", false)), _ => Toggle("lowResource", false)),
            new("Scale · not in the native preview yet", () => "100%", _ => { }),
        ]),
        new("Hotkeys", [.. Actions.Select(a => new Opt(a.Label,
            () => capturing == a.Id ? "Press keys · Del clears" : ComboLabel(Hotkey(a.Id, a.Default)),
            d => { if (d == 0) capturing = a.Id; }))]),
        new("Account", [
            new("Version", () => $"HopOn {typeof(App).Assembly.GetName().Version?.ToString(3)} · native preview", _ => { }),
            new("Updates", () => "Install new builds by hand for now", _ => { }),
            new("Server", () => url, _ => { }),
            new("Emoji artwork", () => "Twemoji · CC-BY 4.0", d => { if (d == 0) Call("open_url", new JsonObject { ["url"] = "https://github.com/jdecked/twemoji" }); }),
            new("Session", () => "Log out", d => { if (d == 0) { Call("logout", []); close(); } }),
        ]),
    ];

    /// <summary>Redraw both columns for the current category / option.</summary>
    void Render()
    {
        var w = XamlRoot?.Size.Width ?? 1200;
        var catSize = Math.Clamp(w * 0.04, 30, 48);
        var valSize = Math.Clamp(w * 0.032, 26, 40);
        catsPanel.Children.Clear();
        for (var i = 0; i < cats.Count; i++)
        {
            var index = i;
            var on = i == cat;
            var label = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 14 };
            label.Children.Add(new TextBlock
            {
                Text = cats[i].Name.ToUpperInvariant(), FontSize = catSize, LineHeight = catSize * 1.12, LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
                FontFamily = Ui.Font(on ? "CondensedMediumFont" : "CondensedLightFont"),
                Foreground = Ui.Brush(on && opt < 0 ? "White" : on ? "Cream" : "Cream55"),
            });
            label.Children.Add(new TextBlock { Text = "›", FontSize = catSize * 0.6, Foreground = Ui.Brush(on ? "White" : "Cream35"), VerticalAlignment = VerticalAlignment.Center });
            var b = new Button
            {
                Content = label, Background = null, BorderThickness = new Thickness(0), Padding = new Thickness(0),
                HorizontalAlignment = HorizontalAlignment.Right, IsTabStop = false,
                Margin = new Thickness(0, 0, i < 4 ? 64 - i * 16 : 0, 0),
                Opacity = Math.Max(0.28, 1 - Math.Abs(i - cat) * 0.22),
            };
            b.Click += (_, _) => { cat = index; opt = 0; Render(); };
            b.PointerEntered += (_, _) => { if (opt < 0 && cat != index) { cat = index; Render(); } };
            catsPanel.Children.Add(b);
        }

        optsPanel.Children.Clear();
        var opts = cats[cat].Opts;
        for (var i = 0; i < opts.Count; i++)
        {
            var o = opts[i];
            var index = i;
            var focus = opt == i;
            var li = new StackPanel { Padding = new Thickness(18, 8, 0, 8), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
            li.Children.Add(new TextBlock
            {
                Text = o.Label.ToUpperInvariant(), FontSize = 12, CharacterSpacing = 50, Foreground = Ui.Brush("Cream55"),
                Margin = new Thickness(0, 0, 0, 2), TextWrapping = TextWrapping.Wrap,
            });
            var val = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
            Button Chev(string text, int dir)
            {
                var c = new Button
                {
                    Content = text, FontSize = 26, Width = 18, Padding = new Thickness(0), Background = null, BorderThickness = new Thickness(0),
                    Foreground = Ui.Brush(focus ? "Cream" : "Cream35"), IsTabStop = false, VerticalAlignment = VerticalAlignment.Center,
                };
                c.Click += (_, _) => { opt = index; o.Step(dir); Render(); };
                return c;
            }
            val.Children.Add(Chev("‹", -1));
            var v = new Button
            {
                Content = new TextBlock
                {
                    Text = o.Value().ToUpperInvariant(), FontSize = valSize, LineHeight = valSize * 1.05, LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
                    FontFamily = Ui.Font("CondensedFont"), Foreground = Ui.Brush("Cream"), TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 440,
                },
                Background = null, BorderThickness = new Thickness(0), Padding = new Thickness(0), IsTabStop = false,
            };
            v.Click += (_, _) => { opt = index; o.Step(0); Render(); };
            val.Children.Add(v);
            val.Children.Add(Chev("›", 1));
            li.Children.Add(val);
            li.PointerEntered += (_, _) => { if (opt != index) { opt = index; Render(); } };
            optsPanel.Children.Add(li);
        }
    }

    // ---------- keyboard ----------

    static readonly HashSet<VirtualKey> Mods = [VirtualKey.Control, VirtualKey.LeftControl, VirtualKey.RightControl, VirtualKey.Menu, VirtualKey.LeftMenu, VirtualKey.RightMenu, VirtualKey.Shift, VirtualKey.LeftShift, VirtualKey.RightShift, VirtualKey.LeftWindows, VirtualKey.RightWindows];

    /// <summary>A key event as the web's combo string ("Ctrl+Shift+KeyM"), or null for a bare modifier.</summary>
    static string? ComboOf(VirtualKey key)
    {
        if (Mods.Contains(key)) return null;
        static bool Down(VirtualKey k) => Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(k).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        var code = key switch
        {
            >= VirtualKey.A and <= VirtualKey.Z => "Key" + key,
            >= VirtualKey.Number0 and <= VirtualKey.Number9 => "Digit" + (char)('0' + (key - VirtualKey.Number0)),
            VirtualKey.Up => "ArrowUp", VirtualKey.Down => "ArrowDown", VirtualKey.Left => "ArrowLeft", VirtualKey.Right => "ArrowRight",
            (VirtualKey)0xC0 => "Backquote", (VirtualKey)0xBB => "Equal", (VirtualKey)0xBD => "Minus",
            _ => key.ToString(),
        };
        return string.Join("+", new[] { Down(VirtualKey.Control) ? "Ctrl" : null, Down(VirtualKey.Menu) ? "Alt" : null, Down(VirtualKey.Shift) ? "Shift" : null, code }.Where(x => x is not null));
    }

    void OnKey(object sender, KeyRoutedEventArgs e)
    {
        e.Handled = true;
        if (capturing == "ptt")
        {
            capturing = null;
            if (e.Key != VirtualKey.Escape) SavePtt(true, (int)e.Key);
            Render();
            return;
        }
        if (capturing is { } action)
        {
            if (e.Key == VirtualKey.Escape) { capturing = null; Render(); return; }
            if (e.Key is VirtualKey.Delete or VirtualKey.Back) { capturing = null; BindHotkey(action, ""); return; }
            if (ComboOf(e.Key) is not { } combo) return; // modifier alone: keep waiting
            capturing = null;
            if (!combo.StartsWith("Ctrl") && !combo.StartsWith("Alt") && !(e.Key >= VirtualKey.F1 && e.Key <= VirtualKey.F24))
            {
                note.Text = "Use Ctrl or Alt (or an F-key) so typing isn't affected";
                Render();
                return;
            }
            BindHotkey(action, combo);
            return;
        }
        var n = opt < 0 ? cats.Count : cats[cat].Opts.Count;
        var at = opt < 0 ? cat : opt;
        switch (e.Key)
        {
            case VirtualKey.Escape: if (opt >= 0) opt = -1; else { close(); return; } break;
            case VirtualKey.Down: if (opt < 0) cat = (at + 1) % n; else opt = (at + 1) % n; break;
            case VirtualKey.Up: if (opt < 0) cat = (at - 1 + n) % n; else opt = (at - 1 + n) % n; break;
            case VirtualKey.Right: if (opt < 0) opt = 0; else cats[cat].Opts[opt].Step(1); break;
            case VirtualKey.Left: if (opt == 0) opt = -1; else if (opt > 0) cats[cat].Opts[opt].Step(-1); break;
            case VirtualKey.Enter: if (opt < 0) opt = 0; else cats[cat].Opts[opt].Step(0); break;
            default: e.Handled = false; return;
        }
        Render();
    }

    /// <summary>Mouse 4 / 5 as the talk key.</summary>
    void OnPointer(object sender, PointerRoutedEventArgs e)
    {
        if (capturing != "ptt") return;
        var p = e.GetCurrentPoint(this).Properties;
        if (!p.IsXButton1Pressed && !p.IsXButton2Pressed) return;
        e.Handled = true;
        capturing = null;
        SavePtt(true, p.IsXButton1Pressed ? 0x1004 : 0x1005);
        Render();
    }

    void BindHotkey(string action, string combo)
    {
        JsonObject hk;
        try { hk = (JsonNode.Parse(store.PrefsJson) as JsonObject)?["hotkeys"]?.DeepClone() as JsonObject ?? []; }
        catch (JsonException) { hk = []; }
        foreach (var a in Actions) if (!hk.ContainsKey(a.Id)) hk[a.Id] = a.Default;
        if (combo.Length > 0)
            foreach (var a in Actions)
                if (a.Id != action && hk[a.Id]?.GetValue<string>() == combo) { hk[a.Id] = ""; note.Text = $"{ComboLabel(combo)} moved from \"{a.Label}\""; }
        hk[action] = combo;
        _ = store.SavePref("hotkeys", hk).ContinueWith(_ => DispatcherQueue.TryEnqueue(Render));
        Render();
    }
}
