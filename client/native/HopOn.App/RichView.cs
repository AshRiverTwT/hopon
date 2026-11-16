using HopOn.Native;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;

namespace HopOn.App;

/// <summary>
/// RichView.Text="..." on a RichTextBlock renders message text with the
/// shared parser (Rich.Parse): runs only, never markup.
/// </summary>
public static partial class RichView
{
    public static readonly DependencyProperty TextProperty = DependencyProperty.RegisterAttached(
        "Text", typeof(string), typeof(RichView), new PropertyMetadata("", OnTextChanged));

    public static string GetText(DependencyObject o) => (string)o.GetValue(TextProperty);
    public static void SetText(DependencyObject o, string value) => o.SetValue(TextProperty, value);

    /// <summary>Display name for a user id (set by the store).</summary>
    public static Func<string, string> NameOf { get; set; } = id => id;

    static readonly FontFamily Mono = new("Cascadia Mono, Consolas");

    static Brush? accent;
    static Brush? Accent()
    {
        if (accent is not null) return accent;
        if (Application.Current.Resources.TryGetValue("AccentTextFillColorPrimaryBrush", out var v) && v is Brush b) accent = b;
        return accent;
    }

    static void OnTextChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is not RichTextBlock block) return;
        block.Blocks.Clear();
        var text = e.NewValue as string ?? "";
        var para = new Paragraph();
        foreach (var n in Rich.Parse(text))
        {
            if (n is RichPre pre)
            {
                if (para.Inlines.Count > 0) { block.Blocks.Add(para); para = new Paragraph(); }
                var code = new Paragraph { FontFamily = Mono, Margin = new Thickness(0, 4, 0, 4) };
                code.Inlines.Add(new Run { Text = pre.V });
                block.Blocks.Add(code);
                continue;
            }
            para.Inlines.Add(MakeInline(n));
        }
        if (para.Inlines.Count > 0 || block.Blocks.Count == 0) block.Blocks.Add(para);
    }

    static Microsoft.UI.Xaml.Documents.Inline MakeInline(RichNode n)
    {
        switch (n)
        {
            case RichText t:
                return new Run { Text = t.V };
            case RichCode c:
                return new Run { Text = c.V, FontFamily = Mono };
            case RichLink l:
            {
                var h = new Hyperlink { NavigateUri = new Uri(l.Href) };
                h.Inlines.Add(new Run { Text = l.V });
                return h;
            }
            case RichMention m:
            {
                var run = new Run { Text = "@" + NameOf(m.Id), FontWeight = FontWeights.SemiBold };
                if (Accent() is Brush b) run.Foreground = b;
                return run;
            }
            case RichStyled s:
            {
                Span span = s.Kind switch { 'b' => new Bold(), 'i' => new Italic(), _ => new Span { TextDecorations = Windows.UI.Text.TextDecorations.Strikethrough } };
                foreach (var c in s.C) span.Inlines.Add(MakeInline(c));
                return span;
            }
            default:
                return new Run();
        }
    }
}
