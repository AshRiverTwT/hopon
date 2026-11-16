using HopOn.Native;

static class MediaTests
{
    static Attachment A(string id, string mime, string url = "", uint w = 0, uint h = 0) => new()
    {
        Id = id, Name = "x", Mime = mime, Size = 1, Width = w, Height = h, Url = url, Preview = "",
    };

    public static void Run(Action<bool, string> check)
    {
        check(Media.HttpBase("wss://hopon-chat.duckdns.org/ws") == "https://hopon-chat.duckdns.org", "wss → https base");
        check(Media.HttpBase("ws://127.0.0.1:18080/ws") == "http://127.0.0.1:18080", "ws → http base, port kept");
        check(Media.HttpBase("http://nope") == "", "non-ws URL → no base");
        check(Media.Url("http://h", A("abc", "image/png")) == "http://h/files/abc", "uploads are served by the chat server");
        check(Media.Url("http://h", A("g", "image/webp", "https://cdn/x.webp")) == "https://cdn/x.webp", "GIFs keep the provider URL");
        check(Media.IsImage(A("1", "image/gif")) && !Media.IsImage(A("1", "video/mp4")) && Media.IsVideo(A("1", "video/mp4")), "image / video by mime");
        // Same results as media.ts fmtSize / fitBox.
        check(Media.FormatSize(512) == "512 B" && Media.FormatSize(2048) == "2 KB" && Media.FormatSize(5 * 1048576) == "5.0 MB" && Media.FormatSize(20 * 1048576UL) == "20 MB", "FormatSize");
        check(Media.FitBox(0, 0) == (320, 200), "unknown size box");
        check(Media.FitBox(1920, 1080) == (420, 236), "wide image fits the width");
        check(Media.FitBox(1000, 2000) == (160, 320), "tall image fits the height");
        check(Media.FitBox(100, 50) == (100, 50), "small images aren't enlarged");
        check(Media.FitBox(10, 10) == (48, 32), "tiny images get a minimum box");
    }
}
