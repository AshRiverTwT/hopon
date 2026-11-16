using System.Runtime.InteropServices;
using HopOn.Native;

namespace HopOn.App;

/// <summary>Window services for the core. Called from core worker threads.</summary>
public sealed partial class NativeHost : IHopOnHost
{
    volatile bool hidden;
    nint hwnd;

    /// <summary>Kept current by the window (minimized or hidden to tray).</summary>
    public bool MainHidden => hidden;
    public void SetHidden(bool value) => hidden = value;
    public void SetWindow(nint handle) => hwnd = handle;

    public void RequestAttention()
    {
        var h = hwnd;
        if (h == 0 || GetForegroundWindow() == h) return;
        var info = new FLASHWINFO
        {
            cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(),
            hwnd = h,
            dwFlags = FLASHW_TRAY | FLASHW_TIMERNOFG,
            uCount = 0,
            dwTimeout = 0,
        };
        FlashWindowEx(ref info);
    }

    public void Exit(int code) => Environment.Exit(code);

    const uint FLASHW_TRAY = 0x2, FLASHW_TIMERNOFG = 0xC;

    [StructLayout(LayoutKind.Sequential)]
    struct FLASHWINFO
    {
        public uint cbSize;
        public nint hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool FlashWindowEx(ref FLASHWINFO pwfi);

    [LibraryImport("user32.dll")]
    private static partial nint GetForegroundWindow();
}
