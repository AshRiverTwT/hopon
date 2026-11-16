// System tray icon (WinUI has none): a message-only window receives the icon's
// clicks; left click opens HopOn, right click shows Open / Quit. Created and
// pumped on the UI thread (WinUI's message loop dispatches its messages).

using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace HopOn.App;

public sealed unsafe partial class TrayIcon : IDisposable
{
    const uint WM_TRAY = 0x8000 + 1; // WM_APP + 1
    const uint WM_LBUTTONUP = 0x0202, WM_RBUTTONUP = 0x0205;
    const uint NIM_ADD = 0, NIM_DELETE = 2;
    const uint NIF_MESSAGE = 1, NIF_ICON = 2, NIF_TIP = 4;
    const uint MF_STRING = 0, TPM_RETURNCMD = 0x100, TPM_RIGHTBUTTON = 2;
    const uint IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, LR_DEFAULTSIZE = 0x40;
    const int CMD_OPEN = 1, CMD_QUIT = 2;

    static TrayIcon? current;
    readonly nint hwnd;
    readonly nint icon;
    bool added;

    public event Action? Open;
    public event Action? Quit;

    public TrayIcon(string iconPath, string tooltip)
    {
        current = this;
        var hinst = GetModuleHandleW(null);
        fixed (char* cls = "HopOnTray")
        {
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)sizeof(WNDCLASSEXW),
                lpfnWndProc = &WndProc,
                hInstance = hinst,
                lpszClassName = cls,
            };
            RegisterClassExW(&wc);
            hwnd = CreateWindowExW(0, cls, null, 0, 0, 0, 0, 0, -3 /* HWND_MESSAGE */, 0, hinst, 0);
        }
        fixed (char* path = iconPath)
            icon = LoadImageW(0, path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
        var data = Data();
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        data.uCallbackMessage = WM_TRAY;
        data.hIcon = icon;
        var tip = tooltip.Length > 127 ? tooltip[..127] : tooltip;
        for (var i = 0; i < tip.Length; i++) data.szTip[i] = tip[i];
        added = Shell_NotifyIconW(NIM_ADD, &data) != 0;
    }

    NOTIFYICONDATAW Data() => new() { cbSize = (uint)sizeof(NOTIFYICONDATAW), hWnd = hwnd, uID = 1 };

    public void Dispose()
    {
        if (added)
        {
            var data = Data();
            Shell_NotifyIconW(NIM_DELETE, &data);
            added = false;
        }
        if (hwnd != 0) DestroyWindow(hwnd);
        if (current == this) current = null;
    }

    void ShowMenu()
    {
        var menu = CreatePopupMenu();
        fixed (char* open = "Open HopOn")
        fixed (char* quit = "Quit HopOn")
        {
            AppendMenuW(menu, MF_STRING, CMD_OPEN, open);
            AppendMenuW(menu, MF_STRING, CMD_QUIT, quit);
        }
        GetCursorPos(out var pt);
        // Required so the menu closes when clicking elsewhere.
        SetForegroundWindow(hwnd);
        var cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.X, pt.Y, 0, hwnd, 0);
        DestroyMenu(menu);
        if (cmd == CMD_OPEN) Open?.Invoke();
        else if (cmd == CMD_QUIT) Quit?.Invoke();
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    static nint WndProc(nint hwnd, uint msg, nint wParam, nint lParam)
    {
        if (msg == WM_TRAY && current is { } t)
        {
            try
            {
                var ev = (uint)(lParam & 0xFFFF);
                if (ev == WM_LBUTTONUP) t.Open?.Invoke();
                else if (ev == WM_RBUTTONUP) t.ShowMenu();
            }
            catch (Exception) { /* never unwind into Win32 */ }
            return 0;
        }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct WNDCLASSEXW
    {
        public uint cbSize;
        public uint style;
        public delegate* unmanaged[Stdcall]<nint, uint, nint, nint, nint> lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public nint hInstance;
        public nint hIcon;
        public nint hCursor;
        public nint hbrBackground;
        public char* lpszMenuName;
        public char* lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct NOTIFYICONDATAW
    {
        public uint cbSize;
        public nint hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public nint hIcon;
        public fixed char szTip[128];
        public uint dwState;
        public uint dwStateMask;
        public fixed char szInfo[256];
        public uint uVersion;
        public fixed char szInfoTitle[64];
        public uint dwInfoFlags;
        public Guid guidItem;
        public nint hBalloonIcon;
    }

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint GetModuleHandleW(string? name);
    [LibraryImport("user32.dll")]
    private static partial ushort RegisterClassExW(WNDCLASSEXW* wc);
    [LibraryImport("user32.dll")]
    private static partial nint CreateWindowExW(uint exStyle, char* cls, char* name, uint style, int x, int y, int w, int h, nint parent, nint menu, nint hinst, nint param);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DestroyWindow(nint hwnd);
    [LibraryImport("user32.dll")]
    private static partial nint DefWindowProcW(nint hwnd, uint msg, nint wParam, nint lParam);
    [LibraryImport("user32.dll")]
    private static partial nint LoadImageW(nint hinst, char* name, uint type, int cx, int cy, uint flags);
    [LibraryImport("shell32.dll")]
    private static partial int Shell_NotifyIconW(uint message, NOTIFYICONDATAW* data);
    [LibraryImport("user32.dll")]
    private static partial nint CreatePopupMenu();
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AppendMenuW(nint menu, uint flags, nint id, char* text);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DestroyMenu(nint menu);
    [LibraryImport("user32.dll")]
    private static partial int TrackPopupMenu(nint menu, uint flags, int x, int y, int reserved, nint hwnd, nint rect);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetCursorPos(out POINT p);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetForegroundWindow(nint hwnd);
}
