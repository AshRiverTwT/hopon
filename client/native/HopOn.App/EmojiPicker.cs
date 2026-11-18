// Emoji picker shared by the composer and reactions (port of
// client/ui/src/components/EmojiPicker.tsx + .emoji-picker styles): a 340 ×
// 380 panel with search, category tabs (recent first), and an 8-column grid.
// Enter picks the first result (or most recent), Esc closes, Shift-click
// keeps it open. Built only while open.

using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace HopOn.App;

public static class EmojiPicker
{
    sealed record Emoji(string E, string K);

    static List<(string Name, string Icon, List<Emoji> List)>? cats;
    static List<(string Name, string Icon, List<Emoji> List)> Cats => cats ??= [.. EmojiData.Categories.Select(c => (c.Name, c.Icon,
        c.Rows.Select(r => { var i = r.IndexOf(' '); return new Emoji(r[..i], r[(i + 1)..].ToLowerInvariant()); }).ToList()))];

    /// <summary>Same ranking as searchEmoji in emoji.ts.</summary>
    static List<Emoji> Search(string q, int limit = 64)
    {
        var t = q.Trim().ToLowerInvariant();
        if (t.Length == 0) return [];
        var words = t.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return [.. Cats.SelectMany(c => c.List)
            .Where(x => words.All(w => x.K.Split(' ').Any(k => k.StartsWith(w, StringComparison.Ordinal)) || x.K.Contains(w, StringComparison.Ordinal)))
            .OrderBy(x => x.K.StartsWith(words[0], StringComparison.Ordinal) ? 0 : 1)
            .Take(limit)];
    }

    public static List<string> Recent(Store store)
    {
        try
        {
            using var doc = JsonDocument.Parse(store.PrefsJson);
            if (doc.RootElement.TryGetProperty("recentEmoji", out var r) && r.ValueKind == JsonValueKind.Array)
                return [.. r.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!)];
        }
        catch (JsonException) { }
        return [];
    }

    static void NoteRecent(Store store, string e)
    {
        var list = new JsonArray();
        foreach (var x in new[] { e }.Concat(Recent(store).Where(x => x != e)).Take(24)) list.Add(x);
        _ = store.SavePref("recentEmoji", list);
    }

    /// <summary>A 16 × 16 stroked icon from an icons.tsx path.</summary>
    public static Microsoft.UI.Xaml.Shapes.Path Icon(string d, Brush stroke)
    {
        var path = (Microsoft.UI.Xaml.Shapes.Path)Microsoft.UI.Xaml.Markup.XamlReader.Load(
            "<Path xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' Width='16' Height='16' Stretch='None' " +
            $"StrokeThickness='1.5' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round' Data='{d}' />");
        path.Stroke = stroke;
        return path;
    }

    /// <summary>
    /// Open above <paramref name="anchor"/>, right edges aligned (.for-composer / .for-react).
    /// <paramref name="pick"/> gets (emoji, keepOpen).
    /// </summary>
    public static Popup Show(FrameworkElement anchor, Store store, Action<string, bool> pick, Action? closed = null)
    {
        const double W = 340, H = 380;
        var root = (FrameworkElement)anchor.XamlRoot.Content;
        var r = anchor.TransformToVisual(root).TransformBounds(new Rect(0, 0, anchor.ActualWidth, anchor.ActualHeight));
        var popup = new Popup
        {
            XamlRoot = anchor.XamlRoot, IsLightDismissEnabled = true,
            HorizontalOffset = Math.Max(8, Math.Min(root.ActualWidth - W - 8, r.Right - W)),
            VerticalOffset = Math.Max(8, r.Top - H - 8),
        };
        var panel = new Grid { RowSpacing = 8 };
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var search = new TextBox
        {
            PlaceholderText = "Search emoji", FontSize = 15, Background = Ui.Brush("Ink"), BorderBrush = Ui.Brush("Cream10"),
            BorderThickness = new Thickness(1), Padding = new Thickness(10, 7, 10, 7), MinHeight = 0,
        };
        panel.Children.Add(search);
        var tabs = new Grid();
        Grid.SetRow(tabs, 1);
        panel.Children.Add(tabs);
        var grid = new StackPanel();
        var scroll = new ScrollViewer { Content = grid };
        Grid.SetRow(scroll, 2);
        panel.Children.Add(scroll);
        popup.Child = new Border
        {
            Width = W, Height = H, Padding = new Thickness(10), Background = Ui.Brush("Ink2"),
            BorderBrush = Ui.Brush("Line"), BorderThickness = new Thickness(1), Child = panel,
            Shadow = new ThemeShadow(), Translation = new System.Numerics.Vector3(0, 0, 32),
        };

        void Choose(string e, bool keepOpen)
        {
            NoteRecent(store, e);
            pick(e, keepOpen);
            if (!keepOpen) popup.IsOpen = false;
        }
        Button Cell(string e, string? title)
        {
            var b = new Button
            {
                Content = e, Width = 32, Height = 32, Padding = new Thickness(0), FontSize = 19, Background = null,
                BorderThickness = new Thickness(0), HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center,
            };
            if (title is not null) ToolTipService.SetToolTip(b, title);
            b.Click += (_, _) => Choose(e, Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down));
            return b;
        }
        Grid Cells(IEnumerable<(string E, string? Title)> list)
        {
            var g = new Grid { ColumnSpacing = 2, RowSpacing = 2 };
            for (var c = 0; c < 8; c++) g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var i = 0;
            foreach (var (e, title) in list)
            {
                if (i % 8 == 0) g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                var b = Cell(e, title);
                Grid.SetRow(b, i / 8);
                Grid.SetColumn(b, i % 8);
                g.Children.Add(b);
                i++;
            }
            return g;
        }
        TextBlock CatHead(string name) => new()
        {
            Text = name.ToUpperInvariant(), FontSize = 11, CharacterSpacing = 60, Foreground = Ui.Brush("Cream55"),
            Padding = new Thickness(2, 6, 2, 4),
        };

        var recent = Recent(store);
        var heads = new List<(string Name, FrameworkElement Head)>();
        var tabButtons = new List<(string Name, Button B, Microsoft.UI.Xaml.Shapes.Path P, Border Line)>();
        void Browse()
        {
            grid.Children.Clear();
            heads.Clear();
            if (recent.Count > 0)
            {
                var h = CatHead("Recent");
                heads.Add(("Recent", h));
                grid.Children.Add(h);
                grid.Children.Add(Cells(recent.Select(e => (e, (string?)null))));
            }
            foreach (var c in Cats)
            {
                var h = CatHead(c.Name);
                heads.Add((c.Name, h));
                grid.Children.Add(h);
                grid.Children.Add(Cells(c.List.Select(x => (x.E, (string?)x.K.Split(' ')[0]))));
            }
        }
        void SetTab(string name)
        {
            foreach (var t in tabButtons)
            {
                var on = t.Name == name;
                t.P.Stroke = Ui.Brush(on ? "Cream" : "Cream35");
                t.Line.Background = on ? Ui.Brush("White") : null;
            }
        }
        var names = (recent.Count > 0 ? new[] { ("Recent", EmojiData.RecentIcon) } : []).Concat(Cats.Select(c => (c.Name, c.Icon))).ToList();
        for (var i = 0; i < names.Count; i++)
        {
            tabs.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var (name, icon) = names[i];
            var path = Icon(icon, Ui.Brush("Cream35"));
            var line = new Border { Height = 2, VerticalAlignment = VerticalAlignment.Bottom };
            var cell = new Grid { Height = 28 };
            cell.Children.Add(path);
            cell.Children.Add(line);
            var b = new Button { Content = cell, Background = null, BorderThickness = new Thickness(0), Padding = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(1, 0, 1, 0) };
            ToolTipService.SetToolTip(b, name);
            b.Click += (_, _) =>
            {
                var h = heads.FirstOrDefault(x => x.Name == name).Head;
                if (h is not null) scroll.ChangeView(null, h.TransformToVisual(grid).TransformPoint(new Point(0, 0)).Y, null, true);
                SetTab(name);
            };
            Grid.SetColumn(b, i);
            tabs.Children.Add(b);
            tabButtons.Add((name, b, path, line));
        }
        // The category you're scrolled to lights up in the tabs.
        scroll.ViewChanged += (_, _) =>
        {
            var at = "";
            foreach (var (name, head) in heads)
                if (head.TransformToVisual(grid).TransformPoint(new Point(0, 0)).Y <= scroll.VerticalOffset + 6) at = name;
            if (at.Length > 0) SetTab(at);
        };
        search.TextChanged += (_, _) =>
        {
            var q = search.Text;
            tabs.Visibility = q.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            if (q.Length == 0) { Browse(); return; }
            grid.Children.Clear();
            var hits = Search(q);
            if (hits.Count == 0) grid.Children.Add(new TextBlock { Text = $"No emoji match \"{q}\"", FontSize = 13, Foreground = Ui.Brush("Cream55"), Padding = new Thickness(4, 20, 4, 20) });
            else grid.Children.Add(Cells(hits.Select(x => (x.E, (string?)x.K.Split(' ')[0]))));
        };
        search.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Escape) { e.Handled = true; popup.IsOpen = false; }
            else if (e.Key == Windows.System.VirtualKey.Enter)
            {
                e.Handled = true;
                var first = search.Text.Length > 0 ? Search(search.Text).FirstOrDefault()?.E : recent.FirstOrDefault();
                if (first is not null) Choose(first, false);
            }
        };
        Browse();
        SetTab(names[0].Item1);
        popup.Closed += (_, _) => closed?.Invoke();
        popup.IsOpen = true;
        search.Focus(FocusState.Programmatic);
        return popup;
    }
}
