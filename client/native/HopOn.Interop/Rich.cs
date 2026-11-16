// Message text → a small tree (rendered as text runs, never markup). C# port
// of client/ui/src/rich.ts: ```code blocks```, `inline code`, **bold**,
// *italic* / _italic_, ~~strike~~, http(s) links and <@id> mentions;
// unbalanced markers stay literal.
//
// Checked against the JS original on a 3000-case corpus
// (client/native/fixtures/rich.json, from client/ui/test/rich-corpus.mjs).
// JS regex classes are ASCII-only (\w, \d) where .NET's are Unicode, so the
// character tests here are spelled out.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace HopOn.Native;

public abstract record RichNode;
public sealed record RichText(string V) : RichNode;
public sealed record RichCode(string V) : RichNode;
public sealed record RichPre(string V) : RichNode;
/// <summary>Kind: 'b' bold, 'i' italic, 's' strike.</summary>
public sealed record RichStyled(char Kind, List<RichNode> C) : RichNode;
public sealed record RichLink(string Href, string V) : RichNode;
public sealed record RichMention(string Id) : RichNode;

public static partial class Rich
{
    [GeneratedRegex("\\Ghttps?://[^\\s<>\"'`]+", RegexOptions.CultureInvariant)]
    private static partial Regex LinkRe();

    [GeneratedRegex("\\G<@([0-9]{1,20})>", RegexOptions.CultureInvariant)]
    private static partial Regex MentionRe();

    [GeneratedRegex("<@([0-9]{1,20})>", RegexOptions.CultureInvariant)]
    private static partial Regex AnyMentionRe();

    static bool IsWord(char c) => c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') or (>= '0' and <= '9') or '_';

    /// <summary>JS \s (and String.prototype.trim): Unicode White_Space plus line terminators and U+FEFF.</summary>
    static bool IsJsSpace(char c) => c switch
    {
        '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680' or '\u2028' or '\u2029' or '\u202f'
            or '\u205f' or '\u3000' or '\ufeff' => true,
        >= '\u2000' and <= '\u200a' => true,
        _ => false,
    };

    static string JsTrim(string s)
    {
        int a = 0, b = s.Length;
        while (a < b && IsJsSpace(s[a])) a++;
        while (b > a && IsJsSpace(s[b - 1])) b--;
        return s[a..b];
    }

    static bool IsTrailing(char c) => c is '.' or ',' or '!' or '?' or ';' or ':' or '\'' or '"' or ')' or ']' or '}';

    static void PushText(List<RichNode> o, string v)
    {
        if (v.Length == 0) return;
        if (o.Count > 0 && o[^1] is RichText t) o[^1] = new RichText(t.V + v);
        else o.Add(new RichText(v));
    }

    static List<RichNode> Inline(string src, int depth = 0)
    {
        var o = new List<RichNode>();
        int i = 0, textStart = 0;
        void Flush(int end) => PushText(o, src[textStart..end]);
        while (i < src.Length)
        {
            var ch = src[i];
            // `inline code`
            if (ch == '`')
            {
                var j = src.IndexOf('`', i + 1);
                if (j > i + 1)
                {
                    Flush(i);
                    o.Add(new RichCode(src[(i + 1)..j]));
                    i = textStart = j + 1;
                    continue;
                }
            }
            // <@id>
            if (ch == '<')
            {
                var m = MentionRe().Match(src, i);
                if (m.Success)
                {
                    Flush(i);
                    o.Add(new RichMention(m.Groups[1].Value));
                    i = textStart = i + m.Length;
                    continue;
                }
            }
            // links (only at a word start)
            if (ch == 'h' && (i == 0 || IsJsSpace(src[i - 1]) || src[i - 1] == '(' || src[i - 1] == '['))
            {
                var m = LinkRe().Match(src, i);
                if (m.Success)
                {
                    var url = m.Value;
                    // Trim trailing punctuation; keep a ")" that closes a "(" in the URL.
                    while (url.Length > 0 && IsTrailing(url[^1]))
                    {
                        if (url[^1] == ')' && url.Count(c => c == '(') >= url.Count(c => c == ')')) break;
                        url = url[..^1];
                    }
                    if (url.Length > "https://".Length)
                    {
                        Flush(i);
                        o.Add(new RichLink(url, url));
                        i = textStart = i + url.Length;
                        continue;
                    }
                }
            }
            // **bold**, ~~strike~~, *italic*, _italic_
            if (depth < 4)
            {
                string? pair = src.AsSpan(i).StartsWith("**") ? "**" : src.AsSpan(i).StartsWith("~~") ? "~~" : ch is '*' or '_' ? ch.ToString() : null;
                if (pair is not null)
                {
                    var wordish = pair == "_";
                    var okStart = !wordish || i == 0 || !IsWord(src[i - 1]);
                    var j = okStart ? src.IndexOf(pair, i + pair.Length, StringComparison.Ordinal) : -1;
                    var inner = j > 0 ? src[(i + pair.Length)..j] : "";
                    var okEnd = j > 0 && JsTrim(inner) == inner && inner.Length > 0 && (!wordish || j + 1 >= src.Length || !IsWord(src[j + 1]));
                    if (okEnd)
                    {
                        Flush(i);
                        o.Add(new RichStyled(pair == "**" ? 'b' : pair == "~~" ? 's' : 'i', Inline(inner, depth + 1)));
                        i = textStart = j + pair.Length;
                        continue;
                    }
                }
            }
            i++;
        }
        Flush(src.Length);
        return o;
    }

    static bool IsLangTag(string s) => s.Length <= 20 && s.All(c => IsWord(c) || c is '+' or '-');

    public static List<RichNode> Parse(string src)
    {
        var o = new List<RichNode>();
        var rest = src;
        for (;;)
        {
            var a = rest.IndexOf("```", StringComparison.Ordinal);
            var b = a >= 0 ? rest.IndexOf("```", a + 3, StringComparison.Ordinal) : -1;
            if (a < 0 || b < 0)
            {
                o.AddRange(Inline(rest));
                return o;
            }
            o.AddRange(Inline(rest[..a]));
            // Drop an optional language tag line: ```rust\n...
            var code = rest[(a + 3)..b];
            var nl = code.IndexOf('\n');
            if (nl >= 0 && IsLangTag(code[..nl])) code = code[(nl + 1)..];
            if (code.EndsWith('\n')) code = code[..^1];
            o.Add(new RichPre(code));
            rest = rest[(b + 3)..];
            if (rest.StartsWith('\n')) rest = rest[1..];
        }
    }

    /// <summary>Does this content mention <paramref name="userId"/>?</summary>
    public static bool MentionsUser(string src, string userId) => src.Contains($"<@{userId}>", StringComparison.Ordinal);

    /// <summary>Wire text → editable text: "&lt;@id&gt;" becomes "@name".</summary>
    public static string DecodeMentions(string text, Func<string, string> nameOf) =>
        AnyMentionRe().Replace(text, m => "@" + nameOf(m.Groups[1].Value));

    /// <summary>
    /// Composer text → wire text: "@name" for known members becomes "&lt;@id&gt;"
    /// (longest name first, case-insensitive, at a word start).
    /// </summary>
    public static string EncodeMentions(string text, IReadOnlyList<(string Id, string Name)> members)
    {
        var sorted = members.OrderByDescending(m => m.Name.Length).ToList();
        // JS: /(^|[\s(])@([^\n@<>]{1,32}?)(?=\s@|[.,!?]|$)/g — scanned by hand to keep JS semantics.
        var sb = new StringBuilder();
        var i = 0;
        var last = 0;
        while (i < text.Length)
        {
            if (text[i] == '@' && (i == 0 || IsJsSpace(text[i - 1]) || text[i - 1] == '('))
            {
                var word = LazyWord(text, i + 1);
                if (word is not null)
                {
                    string? replaced = null;
                    foreach (var m in sorted)
                    {
                        if (word.StartsWith(m.Name, StringComparison.OrdinalIgnoreCase) && word.Length >= m.Name.Length)
                        {
                            var tail = word[m.Name.Length..];
                            if (tail.Length == 0 || !IsWord(tail[0])) { replaced = $"<@{m.Id}>{tail}"; break; }
                        }
                    }
                    if (replaced is not null)
                    {
                        sb.Append(text, last, i - last).Append(replaced);
                        i += 1 + word.Length;
                        last = i;
                        continue;
                    }
                    // No member: JS consumes the whole match (and moves past it).
                    i += 1 + word.Length;
                    continue;
                }
            }
            i++;
        }
        sb.Append(text, last, text.Length - last);
        return sb.ToString();
    }

    /// <summary>The shortest 1–32 char run of [^\n@&lt;&gt;] at <paramref name="start"/> followed by \s@, [.,!?] or the end.</summary>
    static string? LazyWord(string text, int start)
    {
        for (var n = 1; n <= 32 && start + n <= text.Length; n++)
        {
            var c = text[start + n - 1];
            if (c is '\n' or '@' or '<' or '>') return null;
            var end = start + n;
            if (end == text.Length) return text.Substring(start, n);
            var next = text[end];
            if (next is '.' or ',' or '!' or '?') return text.Substring(start, n);
            if (IsJsSpace(next) && end + 1 < text.Length && text[end + 1] == '@') return text.Substring(start, n);
        }
        return null;
    }
}
