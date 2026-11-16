// Your profile: display name, bio, profile picture (128 px JPEG, center-cropped;
// the server takes PNG/JPEG/WebP up to 48 KB).

using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Graphics.Imaging;

namespace HopOn.App;

public static class ProfileDialog
{
    public static async Task Show(XamlRoot root, nint hwnd, Store store)
    {
        if (store.Me is not { } me) return;
        var (profile, avatar) = await store.LoadProfile(me.Id);
        var picture = new PersonPicture { Width = 72, Height = 72, ProfilePicture = avatar, DisplayName = me.Name, HorizontalAlignment = HorizontalAlignment.Left };
        var change = new Button { Content = "Change picture…" };
        var remove = new Button { Content = "Remove" };
        var pics = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        pics.Children.Add(change);
        pics.Children.Add(remove);
        var name = new TextBox { Header = "Display name", Text = me.Name, MaxLength = 32, MinWidth = 340 };
        var bio = new TextBox { Header = "About you", Text = profile?.Bio ?? "", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxLength = 190, Height = 90 };
        var status = new TextBlock { FontSize = 12, Opacity = 0.7, TextWrapping = TextWrapping.Wrap };
        var panel = new StackPanel { Spacing = 10 };
        panel.Children.Add(picture);
        panel.Children.Add(pics);
        panel.Children.Add(name);
        panel.Children.Add(bio);
        panel.Children.Add(status);

        async Task Try(Func<Task> f, string done)
        {
            try { await f(); status.Text = done; }
            catch (HopOnException e) { status.Text = e.Message; }
        }
        change.Click += async (_, _) =>
        {
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            foreach (var ext in new[] { ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp" }) picker.FileTypeFilter.Add(ext);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);
            if (await picker.PickSingleFileAsync() is not { } file) return;
            try
            {
                var jpeg = await SquareJpeg(file, 128);
                await Try(() => App.Core.CallAsync("set_avatar", null, jpeg), "Picture updated");
            }
            catch (Exception x) when (x is not HopOnException)
            {
                status.Text = $"Couldn't read that image: {x.Message}";
            }
        };
        remove.Click += async (_, _) => await Try(() => App.Core.CallAsync("set_avatar"), "Picture removed");

        var dialog = new ContentDialog
        {
            XamlRoot = root, Title = "Your profile", Content = panel,
            PrimaryButtonText = "Save", CloseButtonText = "Close", DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        if (name.Text.Trim() is { Length: > 0 } n && n != me.Name)
            await Try(() => App.Core.CallAsync("set_display_name", new JsonObject { ["name"] = n }), "");
        if (bio.Text.Trim() != (profile?.Bio ?? ""))
            await Try(() => App.Core.CallAsync("set_profile", new JsonObject { ["bio"] = bio.Text.Trim(), ["accent"] = me.Accent }), "");
    }

    /// <summary>Scale so the short side is <paramref name="size"/>, crop the center square, encode JPEG.</summary>
    static async Task<byte[]> SquareJpeg(Windows.Storage.StorageFile file, uint size)
    {
        using var input = await file.OpenReadAsync();
        var decoder = await BitmapDecoder.CreateAsync(input);
        var k = (double)size / Math.Min(decoder.PixelWidth, decoder.PixelHeight);
        var w = (uint)Math.Max(size, Math.Round(decoder.PixelWidth * k));
        var h = (uint)Math.Max(size, Math.Round(decoder.PixelHeight * k));
        var transform = new BitmapTransform
        {
            ScaledWidth = w, ScaledHeight = h, InterpolationMode = BitmapInterpolationMode.Fant,
            Bounds = new BitmapBounds { X = (w - size) / 2, Y = (h - size) / 2, Width = size, Height = size },
        };
        var pixels = await decoder.GetPixelDataAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, transform,
            ExifOrientationMode.RespectExifOrientation, ColorManagementMode.ColorManageToSRgb);
        using var output = new Windows.Storage.Streams.InMemoryRandomAccessStream();
        var props = new BitmapPropertySet { ["ImageQuality"] = new BitmapTypedValue(0.85, Windows.Foundation.PropertyType.Single) };
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, output, props);
        encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, size, size, 96, 96, pixels.DetachPixelData());
        await encoder.FlushAsync();
        var bytes = new byte[output.Size];
        using var reader = new Windows.Storage.Streams.DataReader(output.GetInputStreamAt(0));
        await reader.LoadAsync((uint)output.Size);
        reader.ReadBytes(bytes);
        return bytes;
    }
}
