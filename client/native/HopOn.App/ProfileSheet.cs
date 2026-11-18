// Edit profile (port of client/ui/src/components/ProfileEditor.tsx in the
// web's Overlay sheet): a full-window sheet, "PROFILE" in Archivo, then
// label | value rows: picture, banner, colour swatches, display name (shown
// in the picked colour), about me, Save.

using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics.Imaging;

namespace HopOn.App;

public static class Sheet
{
    /// <summary>
    /// The web's Overlay: a bar ("HOPON" · Close), a big title, a body indented
    /// to the dial's width. Esc closes. Returns the sheet and its body.
    /// </summary>
    public static (Grid Sheet, StackPanel Body) Create(string title, Action close)
    {
        var sheet = new Grid { Background = Ui.Brush("Ink"), IsTabStop = true };
        sheet.RowDefinitions.Add(new RowDefinition { Height = new GridLength(76) });
        sheet.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var bar = new Grid { Padding = new Thickness(28, 0, 28, 0) };
        bar.Children.Add(new TextBlock { Text = "HOPON", FontFamily = Ui.Font("MonoFont"), FontSize = 10.5, CharacterSpacing = 160, Foreground = Ui.Brush("Cream55"), VerticalAlignment = VerticalAlignment.Center });
        var closeKey = Ui.Key("CLOSE");
        closeKey.HorizontalAlignment = HorizontalAlignment.Right;
        closeKey.VerticalAlignment = VerticalAlignment.Center;
        closeKey.Click += (_, _) => close();
        bar.Children.Add(closeKey);
        sheet.Children.Add(bar);
        var body = new StackPanel { Padding = new Thickness(300, 24, 28, 60), MaxWidth = 300 + 860 };
        var w = 1200.0;
        var t = Ui.Display(Math.Clamp(w * 0.06, 40, 84));
        t.Text = title.ToUpperInvariant();
        t.Margin = new Thickness(0, 0, 0, 32);
        body.Children.Add(t);
        var scroll = new ScrollViewer { Content = body, HorizontalAlignment = HorizontalAlignment.Left };
        Grid.SetRow(scroll, 1);
        sheet.Children.Add(scroll);
        sheet.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Escape) { e.Handled = true; close(); } };
        sheet.Loaded += (_, _) =>
        {
            sheet.Focus(FocusState.Programmatic);
            var width = sheet.XamlRoot?.Size.Width ?? 1200;
            t.FontSize = Math.Clamp(width * 0.06, 40, 84);
            if (width < 900) body.Padding = new Thickness(16, 24, 16, 60);
        };
        return (sheet, body);
    }

    /// <summary>A label | value row (.rows > .row): 170 px eyebrow column, hairline on top.</summary>
    public static Grid Row(string label, UIElement value, bool first = false)
    {
        var row = new Grid
        {
            ColumnSpacing = 24, Padding = new Thickness(0, first ? 6 : 22, 0, 22),
            BorderThickness = new Thickness(0, first || label.Length == 0 ? 0 : 1, 0, 0), BorderBrush = Ui.Brush("Cream10"),
        };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(170) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.Children.Add(new TextBlock
        {
            Text = label.ToUpperInvariant(), FontFamily = Ui.Font("MonoFont"), FontSize = 10.5, CharacterSpacing = 160,
            Foreground = Ui.Brush("Cream55"), Padding = new Thickness(0, 9, 0, 0),
        });
        Grid.SetColumn((FrameworkElement)value, 1);
        row.Children.Add(value);
        return row;
    }
}

public static class ProfileSheet
{
    const int MaxBio = 190;
    /// <summary>Same as client/ui/src/profile.ts.</summary>
    static readonly uint[] Accents = [0, 0xff1b50, 0xff7a4d, 0xf2b84b, 0xb8d65a, 0x4fd1a5, 0x5ab4f0, 0xa58cf5, 0xf283c4];
    static readonly string[] AccentNames = ["None", "Red", "Coral", "Amber", "Lime", "Mint", "Sky", "Violet", "Rose"];

    static SolidColorBrush AccentBrush(int i) => i == 0
        ? Ui.Brush("Cream")
        : new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(255, (byte)(Accents[i] >> 16), (byte)(Accents[i] >> 8), (byte)Accents[i]));

    public static async Task<Grid?> Create(Store store, nint hwnd, Action close, Action<string> toast)
    {
        if (store.Me is not { } me) return null;
        var (profile, avatar) = await store.LoadProfile(me.Id);
        var accent = (int)me.Accent;
        var (sheet, body) = Sheet.Create("Profile", close);
        var rows = new StackPanel { MaxWidth = 860, HorizontalAlignment = HorizontalAlignment.Left };
        body.Children.Add(rows);

        async Task<bool> Run(Func<Task> act)
        {
            try { await act(); return true; }
            catch (HopOnException e) { toast(e.Message); return false; }
        }
        async Task<Windows.Storage.StorageFile?> Pick()
        {
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            foreach (var ext in new[] { ".png", ".jpg", ".jpeg", ".webp" }) picker.FileTypeFilter.Add(ext);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);
            return await picker.PickSingleFileAsync();
        }

        // picture
        var picRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 14 };
        var pic = ProfileCard.Avatar(me.Name, avatar, 44, "offline", 0);
        picRow.Children.Add(pic);
        var change = Ui.Key(me.AvatarV != 0 ? "CHANGE" : "UPLOAD");
        change.Click += async (_, _) =>
        {
            if (await Pick() is not { } f) return;
            if (await Run(async () => await App.Core.CallAsync("set_avatar", null, await Crop(f, 256, 256, 120_000)))) toast("Picture updated");
        };
        picRow.Children.Add(change);
        if (me.AvatarV != 0)
        {
            var remove = new HyperlinkButton { Content = "Remove", Foreground = Ui.Brush("Cream55"), Padding = new Thickness(0), VerticalAlignment = VerticalAlignment.Center };
            remove.Click += async (_, _) => { if (await Run(() => App.Core.CallAsync("set_avatar"))) toast("Picture removed"); };
            picRow.Children.Add(remove);
        }
        rows.Children.Add(Sheet.Row("Picture", picRow, first: true));

        // banner
        var bannerRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 14 };
        var thumb = new Border { Width = 132, Height = 44, BorderThickness = new Thickness(1), BorderBrush = Ui.Brush("Cream10"), Background = accent == 0 ? Ui.Brush("Cream10") : AccentBrush(accent) };
        var thumbImg = new Image { Stretch = Stretch.UniformToFill };
        thumb.Child = thumbImg;
        if (profile is { BannerV: > 0 } && await store.BannerOf(me.Id, profile.BannerV) is { } b) thumbImg.Source = b;
        bannerRow.Children.Add(thumb);
        var bannerKey = Ui.Key(profile is { BannerV: > 0 } ? "CHANGE" : "UPLOAD");
        bannerKey.Click += async (_, _) =>
        {
            if (await Pick() is not { } f) return;
            var bytes = await Crop(f, 600, 200, 56_000);
            if (await Run(() => App.Core.CallAsync("set_banner", null, bytes)))
            {
                var bmp = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage();
                using var ms = new Windows.Storage.Streams.InMemoryRandomAccessStream();
                await ms.WriteAsync(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.AsBuffer(bytes));
                ms.Seek(0);
                await bmp.SetSourceAsync(ms);
                thumbImg.Source = bmp;
                toast("Banner updated");
            }
        };
        bannerRow.Children.Add(bannerKey);
        if (profile is { BannerV: > 0 })
        {
            var remove = new HyperlinkButton { Content = "Remove", Foreground = Ui.Brush("Cream55"), Padding = new Thickness(0), VerticalAlignment = VerticalAlignment.Center };
            remove.Click += async (_, _) => { if (await Run(() => App.Core.CallAsync("set_banner"))) { thumbImg.Source = null; toast("Banner removed"); } };
            bannerRow.Children.Add(remove);
        }
        rows.Children.Add(Sheet.Row("Banner", bannerRow));

        // name (declared first: the swatches recolour it)
        var name = new TextBox { Text = me.Name, MaxLength = 32, PlaceholderText = store.Username, FontSize = 22, Padding = new Thickness(0, 10, 0, 12), Foreground = AccentBrush(accent) };
        var bio = new TextBox
        {
            Text = profile?.Bio ?? "", MaxLength = MaxBio, PlaceholderText = "A line or two about you", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap,
            MinHeight = 70, FontSize = 15, Padding = new Thickness(0, 8, 0, 8),
        };
        var count = new TextBlock { FontFamily = Ui.Font("MonoFont"), FontSize = 11, Foreground = Ui.Brush("Cream55") };

        // colour swatches
        var sw = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, Padding = new Thickness(0, 6, 0, 0) };
        var swatches = new List<Border>();
        var save = Ui.Key("SAVE", solid: true);
        void PickAccent(int i)
        {
            accent = i;
            for (var k = 0; k < swatches.Count; k++)
                swatches[k].BorderBrush = k == i ? Ui.Brush("Cream") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            name.Foreground = AccentBrush(i);
            if (thumbImg.Source is null) thumb.Background = i == 0 ? Ui.Brush("Cream10") : AccentBrush(i);
            Dirty();
        }
        for (var i = 0; i < Accents.Length; i++)
        {
            var index = i;
            var chip = new Border
            {
                Width = 18, Height = 18, Background = i == 0 ? null : AccentBrush(i),
                BorderBrush = i == 0 ? Ui.Brush("Cream35") : null, BorderThickness = new Thickness(i == 0 ? 1.5 : 0),
            };
            var ring = new Border { Padding = new Thickness(4), BorderThickness = new Thickness(1.5), Child = chip, Margin = new Thickness(-5.5) };
            ToolTipService.SetToolTip(ring, AccentNames[i]);
            ring.Tapped += (_, _) => PickAccent(index);
            swatches.Add(ring);
            sw.Children.Add(ring);
        }
        rows.Children.Add(Sheet.Row("Colour", sw));

        var nameCol = new StackPanel { Spacing = 10 };
        nameCol.Children.Add(name);
        nameCol.Children.Add(new TextBlock { Text = "@" + store.Username, FontFamily = Ui.Font("MonoFont"), FontSize = 11, Foreground = Ui.Brush("Cream55") });
        rows.Children.Add(Sheet.Row("Display name", nameCol));

        // about me
        var bioCol = new StackPanel { Spacing = 10 };
        bioCol.Children.Add(bio);
        bioCol.Children.Add(count);
        rows.Children.Add(Sheet.Row("About me", bioCol));

        save.HorizontalAlignment = HorizontalAlignment.Left;
        rows.Children.Add(Sheet.Row("", save));
        void Dirty()
        {
            count.Text = $"{bio.Text.Length} / {MaxBio}";
            save.IsEnabled = name.Text.Trim() != me.Name || accent != me.Accent || bio.Text != (profile?.Bio ?? "");
        }
        name.TextChanged += (_, _) => Dirty();
        bio.TextChanged += (_, _) => Dirty();
        save.Click += async (_, _) =>
        {
            save.IsEnabled = false;
            save.Content = "SAVING…";
            var ok = (name.Text.Trim() == me.Name || await Run(() => App.Core.CallAsync("set_display_name", new JsonObject { ["name"] = name.Text.Trim() })))
                && await Run(() => App.Core.CallAsync("set_profile", new JsonObject { ["bio"] = bio.Text.Trim(), ["accent"] = accent }));
            save.Content = "SAVE";
            if (ok) { toast("Profile saved"); close(); }
            else Dirty();
        };
        PickAccent(accent);
        Dirty();
        return sheet;
    }

    /// <summary>Scale to cover w × h, crop the centre, JPEG under maxBytes (quality steps down like the web's toBannerBytes).</summary>
    static async Task<byte[]> Crop(Windows.Storage.StorageFile file, uint w, uint h, int maxBytes)
    {
        using var input = await file.OpenReadAsync();
        var decoder = await BitmapDecoder.CreateAsync(input);
        var k = Math.Max((double)w / decoder.PixelWidth, (double)h / decoder.PixelHeight);
        var sw = (uint)Math.Max(w, Math.Round(decoder.PixelWidth * k));
        var sh = (uint)Math.Max(h, Math.Round(decoder.PixelHeight * k));
        var transform = new BitmapTransform
        {
            ScaledWidth = sw, ScaledHeight = sh, InterpolationMode = BitmapInterpolationMode.Fant,
            Bounds = new BitmapBounds { X = (sw - w) / 2, Y = (sh - h) / 2, Width = w, Height = h },
        };
        var pixels = (await decoder.GetPixelDataAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, transform,
            ExifOrientationMode.RespectExifOrientation, ColorManagementMode.ColorManageToSRgb)).DetachPixelData();
        byte[] bytes = [];
        foreach (var q in new[] { 0.85, 0.7, 0.55, 0.4 })
        {
            using var output = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            var props = new BitmapPropertySet { ["ImageQuality"] = new BitmapTypedValue(q, Windows.Foundation.PropertyType.Single) };
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, output, props);
            encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, w, h, 96, 96, pixels);
            await encoder.FlushAsync();
            bytes = new byte[output.Size];
            using var reader = new Windows.Storage.Streams.DataReader(output.GetInputStreamAt(0));
            await reader.LoadAsync((uint)output.Size);
            reader.ReadBytes(bytes);
            if (bytes.Length <= maxBytes) break;
        }
        return bytes;
    }
}
