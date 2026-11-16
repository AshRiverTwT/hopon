// Settings: audio devices and voice processing (per PC, stored by the core),
// notifications and close-to-tray (synced prefs). Built in code: a dialog of
// simple controls doesn't need its own XAML file.

using System.Text.Json;
using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace HopOn.App;

public static class SettingsDialog
{
    sealed record DeviceItem(string? Id, string Name)
    {
        public override string ToString() => Name;
    }

    static string KeyName(int vk) => vk == 0 ? "Not set" : ((Windows.System.VirtualKey)vk).ToString();

    public static async Task Show(XamlRoot root, Store store)
    {
        var panel = new StackPanel { Spacing = 14, MinWidth = 380 };
        var status = new TextBlock { Opacity = 0.7, FontSize = 12, TextWrapping = TextWrapping.Wrap };

        // --- voice ---
        panel.Children.Add(new TextBlock { Text = "Voice", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold });
        var input = new ComboBox { Header = "Microphone", HorizontalAlignment = HorizontalAlignment.Stretch };
        var output = new ComboBox { Header = "Speakers / headphones", HorizontalAlignment = HorizontalAlignment.Stretch };
        var aec = new ToggleSwitch { Header = "Echo cancellation" };
        var ns = new ToggleSwitch { Header = "Noise suppression" };
        var agc = new ToggleSwitch { Header = "Automatic gain" };
        panel.Children.Add(input);
        panel.Children.Add(output);
        panel.Children.Add(aec);
        panel.Children.Add(ns);
        panel.Children.Add(agc);
        var ptt = new ToggleSwitch { Header = "Push to talk", IsOn = store.PrefBool("ptt", false) };
        var pttKey = store.PrefInt("pttKey", 0);
        var keyButton = new Button { Content = KeyName(pttKey) };
        var pttRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        pttRow.Children.Add(new TextBlock { Text = "Key", VerticalAlignment = VerticalAlignment.Center });
        pttRow.Children.Add(keyButton);
        panel.Children.Add(ptt);
        panel.Children.Add(pttRow);
        var activity = new ToggleSwitch { Header = "Show what I'm playing", IsOn = store.PrefBool("showActivity", true) };

        // --- app ---
        panel.Children.Add(new TextBlock { Text = "App", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Margin = new Thickness(0, 8, 0, 0) });
        var tray = new ToggleSwitch { Header = "Close to the tray", IsOn = store.CloseToTray };
        var system = new ToggleSwitch { Header = "Windows notifications", IsOn = store.PrefBool("systemNotify", true) };
        var banners = new ToggleSwitch { Header = "In-app banners", IsOn = store.PrefBool("appNotify", true) };
        panel.Children.Add(activity);
        panel.Children.Add(tray);
        panel.Children.Add(system);
        panel.Children.Add(banners);
        panel.Children.Add(status);

        var loading = true;
        try
        {
            var d = await App.Core.CallAsync("audio_devices");
            List<DeviceItem> Items(string prop)
            {
                var list = new List<DeviceItem> { new(null, "System default") };
                if (d.TryGetProperty(prop, out var arr) && arr.ValueKind == JsonValueKind.Array)
                    foreach (var x in arr.EnumerateArray())
                        list.Add(new DeviceItem(x.GetProperty("id").GetString(), x.GetProperty("name").GetString() ?? "?"));
                return list;
            }
            string? Selected(string prop) => d.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            void Fill(ComboBox box, List<DeviceItem> items, string? id)
            {
                foreach (var i in items) box.Items.Add(i);
                box.SelectedItem = items.FirstOrDefault(i => i.Id == id) ?? items[0];
            }
            Fill(input, Items("inputs"), Selected("input"));
            Fill(output, Items("outputs"), Selected("output"));
            if (d.TryGetProperty("processing", out var p))
            {
                aec.IsOn = p.GetProperty("aec").GetBoolean();
                ns.IsOn = p.GetProperty("ns").GetBoolean();
                agc.IsOn = p.GetProperty("agc").GetBoolean();
            }
        }
        catch (HopOnException e)
        {
            status.Text = $"Audio devices unavailable: {e.Message}";
            input.IsEnabled = output.IsEnabled = aec.IsEnabled = ns.IsEnabled = agc.IsEnabled = false;
        }
        loading = false;

        async Task Try(Task t)
        {
            try { await t; status.Text = ""; }
            catch (HopOnException e) { status.Text = e.Message; }
        }
        void Device(ComboBox box, bool isInput)
        {
            if (loading || box.SelectedItem is not DeviceItem item) return;
            _ = Try(App.Core.CallAsync("audio_set_device", new JsonObject { ["input"] = isInput, ["id"] = item.Id }));
        }
        void Processing()
        {
            if (loading) return;
            _ = Try(App.Core.CallAsync("audio_processing", new JsonObject { ["aec"] = aec.IsOn, ["ns"] = ns.IsOn, ["agc"] = agc.IsOn }));
            _ = store.SavePref("aec", aec.IsOn);
            _ = store.SavePref("ns", ns.IsOn);
            _ = store.SavePref("agc", agc.IsOn);
        }
        void Ptt()
        {
            _ = Try(App.Core.CallAsync("voice_ptt", new JsonObject { ["enabled"] = ptt.IsOn, ["keyCode"] = pttKey }));
            _ = store.SavePref("ptt", ptt.IsOn);
            _ = store.SavePref("pttKey", pttKey);
        }
        ptt.Toggled += (_, _) => Ptt();
        var capturing = false;
        keyButton.Click += (_, _) => { capturing = true; keyButton.Content = "Press a key…"; };
        keyButton.KeyDown += (_, e) =>
        {
            if (!capturing) return;
            e.Handled = true;
            capturing = false;
            if (e.Key != Windows.System.VirtualKey.Escape) pttKey = (int)e.Key;
            keyButton.Content = KeyName(pttKey);
            Ptt();
        };
        activity.Toggled += (_, _) =>
        {
            _ = Try(App.Core.CallAsync("activity_sharing", new JsonObject { ["enabled"] = activity.IsOn }));
            _ = store.SavePref("showActivity", activity.IsOn);
        };
        input.SelectionChanged += (_, _) => Device(input, true);
        output.SelectionChanged += (_, _) => Device(output, false);
        aec.Toggled += (_, _) => Processing();
        ns.Toggled += (_, _) => Processing();
        agc.Toggled += (_, _) => Processing();
        tray.Toggled += (_, _) => _ = store.SavePref("closeToTray", tray.IsOn);
        system.Toggled += (_, _) => _ = store.SavePref("systemNotify", system.IsOn);
        banners.Toggled += (_, _) => _ = store.SavePref("appNotify", banners.IsOn);

        var dialog = new ContentDialog
        {
            XamlRoot = root,
            Title = "Settings",
            Content = new ScrollViewer { Content = panel, MaxHeight = 560 },
            CloseButtonText = "Done",
        };
        await dialog.ShowAsync();
    }
}
