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
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            System.Diagnostics.Debug.WriteLine($"unhandled: {e.Exception}");
        };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new MainWindow();
        window.Activate();
    }
}
