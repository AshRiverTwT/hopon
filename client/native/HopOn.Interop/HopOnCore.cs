// The HopOn core (Rust, hopon_ffi) from C#. One instance per process.
//
// Threading: event handlers and the host callbacks run on the core's worker
// threads. A UI must hop to its own thread (WinUI: DispatcherQueue.TryEnqueue)
// and must not block in them, or call back into HopOnCore from them. One
// exception: the first events of a subscription are delivered synchronously
// inside Subscribe, on the calling thread. Command results complete their Task
// on a worker thread (await resumes on the caller's context as usual).

using System;
using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace HopOn.Native;

/// <summary>Window services the core asks the shell for.</summary>
public interface IHopOnHost
{
    /// <summary>
    /// The main window is minimized or hidden to the tray. Read for every event,
    /// from worker threads: return a field the UI thread keeps current (e.g. from
    /// AppWindow.Changed), never query the window here.
    /// </summary>
    bool MainHidden { get; }
    /// <summary>Flash the taskbar button if the main window isn't focused.</summary>
    void RequestAttention();
    /// <summary>Exit the app (an update was handed to the installer, or a scripted run ended).</summary>
    void Exit(int code);
}

/// <summary>A command failed; <see cref="Exception.Message"/> is user-facing text from the core.</summary>
public sealed class HopOnException(string message) : Exception(message);

public sealed unsafe class HopOnCore
{
    const int Ok = 0, AlreadyStarted = 1, NotStarted = 2, BadArgument = 3, StartFailed = 4;

    static HopOnCore? instance;
    static IHopOnHost? host;

    readonly ConcurrentDictionary<ulong, TaskCompletionSource<JsonElement>> pending = new();
    readonly ConcurrentDictionary<uint, Action<JsonElement>> sinks = new();
    readonly ConcurrentDictionary<string, uint> sinkOfLabel = new();
    long nextRequest;
    int nextSink;

    HopOnCore() { }

    /// <summary>The started core (throws before <see cref="Start"/>).</summary>
    public static HopOnCore Instance => instance ?? throw new InvalidOperationException("HopOnCore.Start has not been called");

    /// <summary>Version of the loaded hopon_ffi library.</summary>
    public static string NativeVersion => Marshal.PtrToStringUTF8((nint)NativeMethods.hopon_version()) ?? "";

    /// <summary>Optional, before Start: core logs to stderr (RUST_LOG filters).</summary>
    public static void InitLogging() => NativeMethods.hopon_init_logging();

    /// <summary>Optional, before Start: write panics to crash.log and show a message box.</summary>
    public static void InstallCrashReporter() => NativeMethods.hopon_install_crash_reporter();

    /// <summary>False if another HopOn is running (it was brought to the front).</summary>
    public static bool IsSingleInstance() => NativeMethods.hopon_single_instance() != 0;

    /// <summary>
    /// Start the core and begin connecting. <paramref name="dataDir"/>: where the
    /// cache and sign-in live; null → the standard folder shared with the Tauri build.
    /// </summary>
    public static HopOnCore Start(IHopOnHost shellHost, string? dataDir = null)
    {
        if (instance is not null) throw new InvalidOperationException("already started");
        host = shellHost;
        var core = new HopOnCore();
        instance = core;
        var callbacks = new HoponCallbacks
        {
            ctx = null,
            on_event = &OnEvent,
            on_reply = &OnReply,
            main_hidden = &MainHidden,
            request_attention = &RequestAttention,
            exit = &ExitApp,
        };
        var dir = Encoding.UTF8.GetBytes(dataDir ?? "");
        int rc;
        fixed (byte* p = dir) rc = NativeMethods.hopon_start(p, (nuint)dir.Length, callbacks);
        if (rc != Ok)
        {
            instance = null;
            throw new InvalidOperationException(rc switch
            {
                AlreadyStarted => "the core is already running",
                BadArgument => "bad data folder",
                StartFailed => "the core could not start (see the log)",
                _ => $"hopon_start failed ({rc})",
            });
        }
        return core;
    }

    /// <summary>
    /// Receive events for a window: "main" (everything, plus what was buffered
    /// before) or "overlay". Each event is a JSON object whose "t" names its kind
    /// (client/ui/src/types.ts lists them). The handler runs on a worker thread.
    /// Subscribing a label again replaces the previous handler for it.
    /// </summary>
    public void Subscribe(string label, Action<JsonElement> onEvent)
    {
        var sink = (uint)Interlocked.Increment(ref nextSink);
        sinks[sink] = onEvent;
        var bytes = Encoding.UTF8.GetBytes(label);
        int rc;
        fixed (byte* p = bytes) rc = NativeMethods.hopon_subscribe(sink, p, (nuint)bytes.Length);
        if (rc != Ok)
        {
            sinks.TryRemove(sink, out _);
            Check(rc, "subscribe");
        }
        // The core replaced the label's old subscription: drop its handler.
        if (sinkOfLabel.TryGetValue(label, out var old) && old != sink) sinks.TryRemove(old, out _);
        sinkOfLabel[label] = sink;
    }

    /// <summary>Stop events for a window (it closed).</summary>
    public void Unsubscribe(string label)
    {
        var bytes = Encoding.UTF8.GetBytes(label);
        fixed (byte* p = bytes) Check(NativeMethods.hopon_unsubscribe(p, (nuint)bytes.Length), "unsubscribe");
        if (sinkOfLabel.TryRemove(label, out var sink)) sinks.TryRemove(sink, out _);
    }

    /// <summary>
    /// Run a core command by name (the same names and camelCase arguments as the
    /// webview's invoke calls). <paramref name="blob"/>: file bytes for
    /// upload_file, set_avatar and set_banner. Throws <see cref="HopOnException"/>
    /// with the core's message on failure.
    /// </summary>
    public Task<JsonElement> CallAsync(string name, JsonObject? args = null, ReadOnlySpan<byte> blob = default)
    {
        var req = (ulong)Interlocked.Increment(ref nextRequest);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[req] = tcs;
        var n = Encoding.UTF8.GetBytes(name);
        var a = args is null ? [] : Encoding.UTF8.GetBytes(args.ToJsonString());
        int rc;
        fixed (byte* pn = n)
        fixed (byte* pa = a)
        fixed (byte* pb = blob)
            rc = NativeMethods.hopon_call(req, pn, (nuint)n.Length, pa, (nuint)a.Length, pb, (nuint)blob.Length);
        if (rc != Ok)
        {
            pending.TryRemove(req, out _);
            tcs.SetException(new HopOnException($"{name}: could not be queued ({rc})"));
        }
        return tcs.Task;
    }

    static void Check(int rc, string what)
    {
        if (rc != Ok) throw new InvalidOperationException($"{what} failed ({rc})");
    }

    static JsonElement Parse(byte* data, nuint len)
    {
        using var doc = JsonDocument.Parse(new ReadOnlyMemory<byte>(new ReadOnlySpan<byte>(data, checked((int)len)).ToArray()));
        return doc.RootElement.Clone();
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    static void OnEvent(void* ctx, uint sink, byte* json, nuint len)
    {
        try
        {
            if (instance?.sinks.TryGetValue(sink, out var handler) == true) handler(Parse(json, len));
        }
        catch (Exception e)
        {
            // Never let an exception cross into native code.
            Console.Error.WriteLine($"HopOn event handler failed: {e}");
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    static void OnReply(void* ctx, ulong req, byte ok, byte* data, nuint len)
    {
        try
        {
            if (instance is null || !instance.pending.TryRemove(req, out var tcs)) return;
            if (ok != 0) tcs.SetResult(Parse(data, len));
            else tcs.SetException(new HopOnException(Encoding.UTF8.GetString(data, checked((int)len))));
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"HopOn reply handler failed: {e}");
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    static byte MainHidden(void* ctx)
    {
        try { return host?.MainHidden == true ? (byte)1 : (byte)0; }
        catch { return 0; }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    static void RequestAttention(void* ctx)
    {
        try { host?.RequestAttention(); }
        catch (Exception e) { Console.Error.WriteLine($"HopOn RequestAttention failed: {e}"); }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    static void ExitApp(void* ctx, int code)
    {
        try { host?.Exit(code); }
        catch (Exception e) { Console.Error.WriteLine($"HopOn Exit failed: {e}"); }
    }
}
