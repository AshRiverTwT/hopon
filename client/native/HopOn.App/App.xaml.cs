using HopOn.Native;
using Microsoft.UI.Xaml;

namespace HopOn.App;

public partial class App : Application
{
    public static readonly NativeHost Host = new();
    public static HopOnCore Core { get; private set; } = null!;
    /// <summary>Scripted startup measurement: exit after the first frame.</summary>
    public static bool PerfExit { get; } = Environment.GetCommandLineArgs().Contains("--perf-exit");

    MainWindow? window;

    public App()
    {
        HopOnCore.InstallCrashReporter();
        if (!PerfExit && !HopOnCore.IsSingleInstance())
        {
            // Another HopOn is running; it was brought to the front.
            Environment.Exit(0);
        }
        // Start (and connect) before any UI exists: the socket is usually up and
        // signed in by the time the window paints.
        Core = HopOnCore.Start(Host);
        try { InitializeComponent(); }
        catch (Exception x) { Crash("startup (App.xaml)", x); throw; }
        UnhandledException += (_, e) =>
        {
            // Log it, and keep the app running: one failing animation or row
            // shouldn't close HopOn (the log says what to fix).
            Crash("unhandled", e.Exception);
            e.Handled = true;
        };
    }

    /// <summary>
    /// Write a UI crash to native-crash.log in the data folder (a XAML error
    /// otherwise only shows as exit code 0xC000027B, with no message).
    /// </summary>
    public static void Crash(string where, Exception x)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "app.hopon.desktop");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "native-crash.log"), $"{DateTime.Now:O} {where}: {x}\n\n");
        }
        catch (Exception) { }
    }

    /// <summary>A Windows notification was clicked: (channel id).</summary>
    public static event Action<string>? NotificationClicked;

    static void RegisterNotifications()
    {
        try
        {
            var m = Microsoft.Windows.AppNotifications.AppNotificationManager.Default;
            m.NotificationInvoked += (_, e) =>
            {
                if (e.Arguments.TryGetValue("channel", out var channel)) NotificationClicked?.Invoke(channel);
            };
            m.Register();
            AppDomain.CurrentDomain.ProcessExit += (_, _) => { try { m.Unregister(); } catch (Exception) { } };
        }
        catch (Exception x)
        {
            // Notifications are optional (e.g. unavailable on this Windows build).
            System.Diagnostics.Debug.WriteLine($"notifications unavailable: {x.Message}");
        }
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try { window = new MainWindow(); }
        catch (Exception x) { Crash("startup (MainWindow)", x); throw; }
        window.Activate();
        // Off the startup path: register for notification clicks once the window is up.
        if (!PerfExit) Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread().TryEnqueue(
            Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, RegisterNotifications);
    }
}
