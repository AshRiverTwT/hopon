// CSS-like transitions for code-built UI: animate an element's composition
// Translation / Scale (Vector3) or Rotation / Opacity (scalar) from where it
// is *now* (mid-animation included) to a target, with a cubic-bezier curve,
// a duration and an optional delay — what `transition: transform .28s
// cubic-bezier(.2,.7,.2,1)` does in the web build.

using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;

namespace HopOn.App;

public static class Motion
{
    /// <summary>The web's curves.</summary>
    public static readonly (float, float, float, float) Dial = (0.2f, 0.7f, 0.2f, 1f), Rail = (0.2f, 0.8f, 0.2f, 1f), Ease = (0.25f, 0.1f, 0.25f, 1f);

    sealed class Track
    {
        public Vector3 From, To;
        public long Start;
        public double Delay, Duration;
        public (float, float, float, float) Curve;
    }

    static readonly Dictionary<(UIElement, string), Track> tracks = [];

    /// <summary>Where the property is on screen now (following any running animation).</summary>
    static Vector3 Current(UIElement e, string prop)
    {
        if (!tracks.TryGetValue((e, prop), out var t)) return Get(e, prop);
        var ms = (Environment.TickCount64 - t.Start) - t.Delay;
        if (ms <= 0) return t.From;
        if (ms >= t.Duration) return t.To;
        var k = (float)Bezier(t.Curve, ms / t.Duration);
        return Vector3.Lerp(t.From, t.To, k);
    }

    static Vector3 Get(UIElement e, string prop) => prop switch
    {
        "Translation" => e.Translation,
        "Scale" => e.Scale,
        "Rotation" => new Vector3(e.Rotation, 0, 0),
        _ => new Vector3((float)e.Opacity, 0, 0),
    };

    static void Set(UIElement e, string prop, Vector3 v)
    {
        switch (prop)
        {
            case "Translation": e.Translation = v; break;
            case "Scale": e.Scale = v; break;
            case "Rotation": e.Rotation = v.X; break;
            default: e.Opacity = v.X; break;
        }
    }

    /// <summary>
    /// Animate <paramref name="prop"/> to <paramref name="to"/> over <paramref name="ms"/>
    /// (0 = jump there). <paramref name="from"/> overrides the start (e.g. 0 for a fade-in).
    /// </summary>
    public static void To(UIElement e, string prop, Vector3 to, double ms, (float, float, float, float) curve, double delayMs = 0, Vector3? from = null)
    {
        var start = from ?? Current(e, prop);
        var old = tracks.GetValueOrDefault((e, prop));
        if (from is null && old is not null && old.To == to && start == to) return; // already there
        Set(e, prop, to);
        if (ms <= 0 || start == to)
        {
            // Stop anything still running on it: a 1 ms animation to the target.
            if (old is not null) Start(e, prop, to, to, 1, 0, curve);
            tracks.Remove((e, prop));
            return;
        }
        Start(e, prop, start, to, ms, delayMs, curve);
        tracks[(e, prop)] = new Track { From = start, To = to, Start = Environment.TickCount64, Delay = delayMs, Duration = ms, Curve = curve };
    }

    public static void To(UIElement e, string prop, float to, double ms, (float, float, float, float) curve, double delayMs = 0, float? from = null) =>
        To(e, prop, new Vector3(to, 0, 0), ms, curve, delayMs, from is { } f ? new Vector3(f, 0, 0) : null);

    static void Start(UIElement e, string prop, Vector3 from, Vector3 to, double ms, double delayMs, (float, float, float, float) c)
    {
        // Not ElementCompositionPreview.GetElementVisual(e): Windows refuses that on
        // an element whose facade properties (CenterPoint, Translation…) are in use.
        var compositor = Microsoft.UI.Xaml.Media.CompositionTarget.GetCompositorForCurrentThread();
        var ease = compositor.CreateCubicBezierEasingFunction(new Vector2(c.Item1, c.Item2), new Vector2(c.Item3, c.Item4));
        CompositionAnimation anim;
        if (prop is "Translation" or "Scale")
        {
            var a = compositor.CreateVector3KeyFrameAnimation();
            a.InsertKeyFrame(0, from);
            a.InsertKeyFrame(1, to, ease);
            a.Duration = TimeSpan.FromMilliseconds(ms);
            a.DelayTime = TimeSpan.FromMilliseconds(delayMs);
            a.DelayBehavior = AnimationDelayBehavior.SetInitialValueBeforeDelay;
            anim = a;
        }
        else
        {
            var a = compositor.CreateScalarKeyFrameAnimation();
            a.InsertKeyFrame(0, from.X);
            a.InsertKeyFrame(1, to.X, ease);
            a.Duration = TimeSpan.FromMilliseconds(ms);
            a.DelayTime = TimeSpan.FromMilliseconds(delayMs);
            a.DelayBehavior = AnimationDelayBehavior.SetInitialValueBeforeDelay;
            anim = a;
        }
        anim.Target = prop;
        e.StartAnimation(anim);
    }

    /// <summary>Forget an element (it was removed).</summary>
    public static void Drop(UIElement e)
    {
        foreach (var k in tracks.Keys.Where(k => k.Item1 == e).ToList()) tracks.Remove(k);
    }

    /// <summary>CSS cubic-bezier(x1, y1, x2, y2) at progress x (Newton + bisection on x(t)).</summary>
    public static double Bezier((float, float, float, float) c, double x)
    {
        double X(double t) => 3 * (1 - t) * (1 - t) * t * c.Item1 + 3 * (1 - t) * t * t * c.Item3 + t * t * t;
        double Y(double t) => 3 * (1 - t) * (1 - t) * t * c.Item2 + 3 * (1 - t) * t * t * c.Item4 + t * t * t;
        double lo = 0, hi = 1, t = x;
        for (var i = 0; i < 20; i++)
        {
            var v = X(t) - x;
            if (Math.Abs(v) < 1e-5) break;
            if (v > 0) hi = t; else lo = t;
            t = (lo + hi) / 2;
        }
        return Y(t);
    }
}
