// Where attachment media lives (port of client/ui/src/media.ts): uploads on
// the chat server at /files/{id}, GIFs on the provider's CDN (absolute URLs).

using System;

namespace HopOn.Native;

public static class Media
{
    /// <summary>"wss://host:port/ws" → "https://host:port" ("" if not a ws URL).</summary>
    public static string HttpBase(string wsUrl)
    {
        var scheme = wsUrl.StartsWith("wss://", StringComparison.OrdinalIgnoreCase) ? "https"
            : wsUrl.StartsWith("ws://", StringComparison.OrdinalIgnoreCase) ? "http" : null;
        if (scheme is null) return "";
        var rest = wsUrl[(wsUrl.IndexOf("://", StringComparison.Ordinal) + 3)..];
        var host = rest.Split('/')[0];
        return host.Length == 0 ? "" : $"{scheme}://{host}";
    }

    public static string Url(string httpBase, Attachment a) => a.Url.Length > 0 ? a.Url : $"{httpBase}/files/{a.Id}";
    public static bool IsImage(Attachment a) => a.Mime.StartsWith("image/", StringComparison.Ordinal);
    public static bool IsVideo(Attachment a) => a.Mime.StartsWith("video/", StringComparison.Ordinal);

    public static string FormatSize(ulong n) =>
        n < 1024 ? $"{n} B" : n < 1048576 ? $"{n / 1024.0:0} KB" : n < 10485760 ? $"{n / 1048576.0:0.0} MB" : $"{n / 1048576.0:0} MB";

    /// <summary>Display box within maxW × maxH keeping the aspect ratio (unknown size: 320 × 200).</summary>
    public static (int W, int H) FitBox(uint w, uint h, int maxW = 420, int maxH = 320)
    {
        if (w == 0 || h == 0) return (Math.Min(maxW, 320), 200);
        var k = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / h));
        return (Math.Max(48, (int)Math.Round(w * k)), Math.Max(32, (int)Math.Round(h * k)));
    }
}
