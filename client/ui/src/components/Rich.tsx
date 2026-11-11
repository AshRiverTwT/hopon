// Renders the parsed message tree as elements/text nodes (never innerHTML).
// Hot path: most messages are plain text, which skips the parser entirely.
// Nodes are built with plain conditionals (no Switch/Match), since a row's
// content only changes on edit, when the whole Rich re-renders.
import { createMemo, type JSX } from "solid-js";
import { call } from "../ipc";
import { parse, type Node } from "../rich";
import { s, toast, userName } from "../store";

const SPECIAL = /[*_~`<]|https?:\/\//;

function open(href: string) {
  call("open_url", { url: href }).catch((e) => toast(String(e)));
}

function render(n: Node): JSX.Element {
  switch (n.t) {
    case "text": return n.v;
    case "code": return <code class="md-code">{n.v}</code>;
    case "pre": return <pre class="md-pre"><code>{n.v}</code></pre>;
    case "b": return <strong>{n.c.map(render)}</strong>;
    case "i": return <em>{n.c.map(render)}</em>;
    case "s": return <s>{n.c.map(render)}</s>;
    case "link":
      // No real href: the webview must never navigate; the core opens it.
      return <a class="md-link" role="link" tabIndex={0} title={n.href}
        onClick={(e) => { e.preventDefault(); open(n.href); }}
        onKeyDown={(e) => e.key === "Enter" && open(n.href)}>{n.v}</a>;
    case "mention":
      return <span class="mention" classList={{ me: n.id === s.user?.id }}>@{userName(n.id)}</span>;
  }
}

export default function Rich(p: { text: string }) {
  const out = createMemo(() => (SPECIAL.test(p.text) ? parse(p.text).map(render) : p.text));
  return <>{out()}</>;
}
