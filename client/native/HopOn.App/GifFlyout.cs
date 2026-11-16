// GIF search (KLIPY, through the chat server: the provider key stays there).
// Trending on open, search 300 ms after typing stops, click sends.

using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;

namespace HopOn.App;

public static class GifFlyout
{
    public static Flyout Create(Store store, Func<double> now)
    {
        var box = new TextBox { PlaceholderText = "Search GIFs" };
        var status = new TextBlock { Opacity = 0.7, FontSize = 12 };
        var grid = new GridView { IsItemClickEnabled = true, SelectionMode = ListViewSelectionMode.None, Height = 360 };
        var panel = new StackPanel { Spacing = 8, Width = 420 };
        panel.Children.Add(box);
        panel.Children.Add(status);
        panel.Children.Add(grid);
        var flyout = new Flyout { Content = panel };

        var seq = 0;
        async Task Search(string q)
        {
            var mine = ++seq;
            status.Text = "Loading…";
            try
            {
                var r = await App.Core.CallAsync("gif_search", HopOnJson.Default.GifResults, new JsonObject { ["query"] = q });
                if (mine != seq) return;
                grid.Items.Clear();
                if (!r.Enabled) { status.Text = "GIFs aren't set up on this server."; return; }
                status.Text = r.Results.Count == 0 ? "No GIFs found." : "";
                foreach (var g in r.Results)
                {
                    var (w, h) = Media.FitBox(g.Width, g.Height, 130, 100);
                    grid.Items.Add(new Image
                    {
                        Source = Uri.TryCreate(g.Preview, UriKind.Absolute, out var u) ? new BitmapImage(u) { DecodePixelWidth = w * 2 } : null,
                        Width = w, Height = h, Stretch = Microsoft.UI.Xaml.Media.Stretch.UniformToFill, Tag = g,
                    });
                }
            }
            catch (HopOnException e)
            {
                if (mine == seq) status.Text = e.Message;
            }
        }

        var timer = DispatcherQueueTimerFor(box);
        timer.Interval = TimeSpan.FromMilliseconds(300);
        timer.Tick += (_, _) => { timer.Stop(); _ = Search(box.Text.Trim()); };
        box.TextChanged += (_, _) => { timer.Stop(); timer.Start(); };
        flyout.Opened += (_, _) => { box.Text = ""; _ = Search(""); box.Focus(FocusState.Programmatic); };
        grid.ItemClick += (_, e) =>
        {
            if (e.ClickedItem is Image { Tag: Gif g })
            {
                flyout.Hide();
                store.SendGif(g, now());
            }
        };
        return flyout;
    }

    static Microsoft.UI.Dispatching.DispatcherQueueTimer DispatcherQueueTimerFor(FrameworkElement e) =>
        Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread().CreateTimer();
}
