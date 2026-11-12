// Message text → a small tree (rendered as text nodes/elements, never HTML).
// Supports: ```code blocks```, `inline code`, **bold**, *italic* / _italic_,
// ~~strike~~, http(s) links, and <@id> mentions. Unbalanced markers stay
// literal text. Kept free of Solid so it can be unit tested with node.

export type Node =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "pre"; v: string }
  | { t: "b" | "i" | "s"; c: Node[] }
  | { t: "link"; href: string; v: string }
  | { t: "mention"; id: string };

const LINK = /https?:\/\/[^\s<>"'`]+/y;
const MENTION = /<@(\d{1,20})>/y;
const TRAILING = /[.,!?;:'")\]}]$/;

function pushText(out: Node[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Inline parse of a span without code blocks. `depth` bounds nesting. */
function inline(src: string, depth = 0): Node[] {
  const out: Node[] = [];
  let i = 0;
  let textStart = 0;
  const flush = (end: number) => pushText(out, src.slice(textStart, end));
  while (i < src.length) {
    const ch = src[i];
    // `inline code`
    if (ch === "`") {
      const j = src.indexOf("`", i + 1);
      if (j > i + 1) {
        flush(i);
        out.push({ t: "code", v: src.slice(i + 1, j) });
        i = textStart = j + 1;
        continue;
      }
    }
    // <@id>
    if (ch === "<") {
      MENTION.lastIndex = i;
      const m = MENTION.exec(src);
      if (m) {
        flush(i);
        out.push({ t: "mention", id: m[1] });
        i = textStart = i + m[0].length;
        continue;
      }
    }
    // links (only at a word start)
    if (ch === "h" && (i === 0 || /[\s(\[]/.test(src[i - 1]))) {
      LINK.lastIndex = i;
      const m = LINK.exec(src);
      if (m) {
        let url = m[0];
        // Trim trailing punctuation one char at a time; keep a ")" only if
        // it closes a "(" inside the URL (e.g. wiki links).
        while (TRAILING.test(url)) {
          const last = url[url.length - 1];
          if (last === ")" && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
          url = url.slice(0, -1);
        }
        if (url.length > "https://".length) {
          flush(i);
          out.push({ t: "link", href: url, v: url });
          i = textStart = i + url.length;
          continue;
        }
      }
    }
    // **bold**, ~~strike~~, *italic*, _italic_
    if (depth < 4) {
      const pair = src.startsWith("**", i) ? "**" : src.startsWith("~~", i) ? "~~" : ch === "*" || ch === "_" ? ch : null;
      if (pair) {
        const wordish = pair === "_";
        const okStart = !wordish || i === 0 || !/\w/.test(src[i - 1]);
        const j = okStart ? src.indexOf(pair, i + pair.length) : -1;
        const inner = j > 0 ? src.slice(i + pair.length, j) : "";
        const okEnd = j > 0 && inner.trim() === inner && inner.length > 0 && (!wordish || j + 1 >= src.length || !/\w/.test(src[j + 1]));
        if (okEnd) {
          flush(i);
          out.push({ t: pair === "**" ? "b" : pair === "~~" ? "s" : "i", c: inline(inner, depth + 1) });
          i = textStart = j + pair.length;
          continue;
        }
      }
    }
    i++;
  }
  flush(src.length);
  return out;
}

export function parse(src: string): Node[] {
  const out: Node[] = [];
  let rest = src;
  for (;;) {
    const a = rest.indexOf("```");
    const b = a >= 0 ? rest.indexOf("```", a + 3) : -1;
    if (a < 0 || b < 0) {
      out.push(...inline(rest));
      return out;
    }
    out.push(...inline(rest.slice(0, a)));
    // Drop an optional language tag line: ```rust\n...
    let code = rest.slice(a + 3, b);
    const nl = code.indexOf("\n");
    if (nl >= 0 && /^[\w+-]{0,20}$/.test(code.slice(0, nl))) code = code.slice(nl + 1);
    out.push({ t: "pre", v: code.replace(/\n$/, "") });
    rest = rest.slice(b + 3).replace(/^\n/, "");
  }
}

/** Does this content mention `userId`? */
export const mentionsUser = (src: string, userId: string) => src.includes(`<@${userId}>`);

/** Composer text → wire text: "@name" for known members becomes "<@id>". */
export function encodeMentions(text: string, members: { id: string; name: string }[]): string {
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  return text.replace(/(^|[\s(])@([^\s@<>]{1,32})/g, (all, pre: string, word: string) => {
    for (const m of sorted) {
      if (word.toLowerCase().startsWith(m.name.toLowerCase())) {
        const tail = word.slice(m.name.length);
        if (tail === "" || /^[^\w]/.test(tail)) return `${pre}<@${m.id}>${tail}`;
      }
    }
    return all;
  });
}

/** Wire text → editable text: "<@id>" becomes "@name". */
export function decodeMentions(text: string, nameOf: (id: string) => string): string {
  return text.replace(/<@(\d{1,20})>/g, (_, id: string) => `@${nameOf(id)}`);
}

/** Plain one-line preview for reply quotes. */
export function preview(src: string, nameOf: (id: string) => string, max = 120): string {
  const flat = decodeMentions(src, nameOf)
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\*\*|~~|`/g, "")
    .replace(/(^|\s)[_*](\S(?:[^_*]*\S)?)[_*](?=\s|$|[.,!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|‍|️|⃣|\s)+$/u;
const HAS_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Message is only emoji (1–27 of them, no text): shown at 200 %. */
export function jumboEmoji(text: string): boolean {
  const t = text.trim();
  // Digits, #, * are emoji components too: plain text must never qualify.
  if (!t || t.length > 300 || /[0-9#*A-Za-z]/.test(t) || !EMOJI_ONLY.test(t) || !HAS_EMOJI.test(t)) return false;
  const n = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t.replace(/\s+/g, ""))].length;
  return n <= 27;
}
