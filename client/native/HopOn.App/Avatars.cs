using System.Text.Json.Nodes;
using HopOn.Native;
using Microsoft.UI.Xaml.Media.Imaging;

namespace HopOn.App;

/// <summary>
/// Profile pictures, decoded once per (user, version) on the UI thread. The
/// core caches the bytes on disk; this keeps the decoded bitmaps.
/// </summary>
public sealed class Avatars(HopOnCore core)
{
    readonly Dictionary<string, BitmapImage?> cache = [];
    readonly HashSet<string> loading = [];

    /// <summary>A picture finished loading for this user.</summary>
    public event Action<string>? Loaded;

    /// <summary>The picture if loaded (null: none, or still loading; Loaded fires when ready).</summary>
    public BitmapImage? Get(string userId, uint v)
    {
        if (v == 0) return null;
        var key = $"{userId}:{v}";
        if (cache.TryGetValue(key, out var img)) return img;
        if (loading.Add(key)) _ = Load(key, userId, v);
        return null;
    }

    async Task Load(string key, string userId, uint v)
    {
        BitmapImage? img = null;
        try
        {
            var r = await core.CallAsync("avatar", new JsonObject { ["userId"] = userId, ["v"] = v });
            if (r.GetString() is { } url && url.StartsWith("data:", StringComparison.Ordinal) && url.IndexOf(',') is var comma and > 0)
            {
                var bytes = Convert.FromBase64String(url[(comma + 1)..]);
                using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
                using (var writer = new Windows.Storage.Streams.DataWriter(stream.GetOutputStreamAt(0)))
                {
                    writer.WriteBytes(bytes);
                    await writer.StoreAsync();
                    await writer.FlushAsync();
                    writer.DetachStream();
                }
                stream.Seek(0);
                img = new BitmapImage { DecodePixelWidth = 80, DecodePixelType = DecodePixelType.Logical };
                await img.SetSourceAsync(stream);
            }
        }
        catch (Exception) { img = null; }
        cache[key] = img;
        loading.Remove(key);
        if (img is not null) Loaded?.Invoke(userId);
    }
}
