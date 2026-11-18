// The theme's brushes and fonts for code-built UI. Created here rather than
// looked up in Application.Resources: under Native AOT, casting a looked-up
// resource (Style, FontFamily, Brush) can fail with InvalidCastException.
// Values match Theme.xaml.

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace HopOn.App;

public static class Ui
{
    static readonly Dictionary<string, uint> Argb = new()
    {
        ["Ink"] = 0xFF0B0B0C, ["Ink2"] = 0xFF151516, ["Key"] = 0xFF161617, ["KeyHi"] = 0xFF1E1E20,
        ["Cream"] = 0xFFEDEDEE, ["Cream80"] = 0xCCEDEDEE, ["Cream55"] = 0x8CEDEDEE, ["Cream35"] = 0x59EDEDEE,
        ["Cream20"] = 0x33EDEDEE, ["Cream10"] = 0x1AEDEDEE, ["Cream05"] = 0x0DEDEDEE,
        ["Hair"] = 0x17FFFFFF, ["Line"] = 0x12FFFFFF, ["Signal"] = 0xFFFF5B1F, ["White"] = 0xFFFFFFFF,
        ["Transparent"] = 0x00000000,
    };
    static readonly Dictionary<string, SolidColorBrush> brushes = [];
    static readonly Dictionary<string, FontFamily> fonts = [];

    static readonly Dictionary<string, string> FontFiles = new()
    {
        ["TextFont"] = "HopOnText-Regular.ttf#HopOn Text",
        ["TextMediumFont"] = "HopOnText-Medium.ttf#HopOn Text",
        ["TextSemiFont"] = "HopOnText-SemiBold.ttf#HopOn Text",
        ["MonoFont"] = "HopOnMono-Regular.ttf#HopOn Mono",
        ["MonoMediumFont"] = "HopOnMono-Medium.ttf#HopOn Mono",
        ["MonoSemiFont"] = "HopOnMono-SemiBold.ttf#HopOn Mono",
        ["DisplayFont"] = "HopOnDisplay-Black.ttf#HopOn Display",
        ["CondensedFont"] = "HopOnCondensed-Regular.ttf#HopOn Condensed",
        ["CondensedLightFont"] = "HopOnCondensed-Light.ttf#HopOn Condensed",
        ["CondensedMediumFont"] = "HopOnCondensed-Medium.ttf#HopOn Condensed",
    };

    public static SolidColorBrush Brush(string key)
    {
        if (brushes.TryGetValue(key, out var b)) return b;
        var c = Argb[key];
        b = new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb((byte)(c >> 24), (byte)(c >> 16), (byte)(c >> 8), (byte)c));
        brushes[key] = b;
        return b;
    }

    public static FontFamily Font(string key)
    {
        if (fonts.TryGetValue(key, out var f)) return f;
        f = new FontFamily("ms-appx:///Fonts/" + FontFiles[key]);
        fonts[key] = f;
        return f;
    }

    /// <summary>A title in Archivo Expanded Black (the XAML "Display" style).</summary>
    public static TextBlock Display(double size) => new()
    {
        FontFamily = Font("DisplayFont"), FontSize = size, Foreground = Brush("Cream"), CharacterSpacing = 10,
        TextLineBounds = TextLineBounds.Tight, TextWrapping = TextWrapping.NoWrap,
    };

    /// <summary>A key (the XAML "KeyButton" / "SolidKeyButton" styles).</summary>
    public static Button Key(object content, bool solid = false)
    {
        var b = new Button { Content = content, Height = 34, MinWidth = 0, Padding = new Thickness(14, 0, 14, 0), CharacterSpacing = 120, FontSize = 11.5 };
        SetKey(b, solid);
        return b;
    }

    /// <summary>Make a button a plain key (dark) or a solid one (cream), e.g. the Friends / Servers switch.</summary>
    public static void SetKey(Button b, bool solid)
    {
        b.FontFamily = Font(solid ? "MonoSemiFont" : "MonoMediumFont");
        b.Background = Brush(solid ? "Cream" : "Key");
        b.Foreground = Brush(solid ? "Ink" : "Cream80");
        b.BorderBrush = Brush(solid ? "Cream" : "Hair");
        b.BorderThickness = new Thickness(1);
    }
}
