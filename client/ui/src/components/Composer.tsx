import { createMemo, createSignal, For, Show } from "solid-js";
import { currentServer, s, sendMessage, set, userName } from "../store";
import { preview } from "../rich";
import { Avatar } from "./Avatar";

export default function Composer() {
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [pick, setPick] = createSignal(0);
  let ta!: HTMLTextAreaElement;
  const name = () => currentServer()?.channels.find((c) => c.id === s.selChannel)?.name ?? "";

  // "@que" right before the caret → member suggestions.
  const query = createMemo(() => {
    const before = text().slice(0, caret());
    const m = before.match(/(^|[\s(])@([^\s@<>]{0,32})$/);
    return m ? m[2] : null;
  });
  const matches = createMemo(() => {
    const q = query();
    if (q === null) return [];
    const ql = q.toLowerCase();
    return (currentServer()?.members ?? []).filter((m) => m.name.toLowerCase().startsWith(ql)).slice(0, 6);
  });

  const resize = () => { ta.style.height = "auto"; ta.style.height = Math.min(200, ta.scrollHeight) + "px"; };
  const insert = (memberName: string) => {
    const q = query() ?? "";
    const pos = caret();
    const start = pos - q.length;
    const next = text().slice(0, start) + memberName + " " + text().slice(pos);
    setText(next);
    ta.value = next;
    const c = start + memberName.length + 1;
    ta.setSelectionRange(c, c);
    setCaret(c);
    setPick(0);
    ta.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (matches().length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPick((pick() + 1) % matches().length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPick((pick() - 1 + matches().length) % matches().length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); insert(matches()[pick()].name); return; }
    }
    if (e.key === "Escape" && s.replyTo) { set("replyTo", null); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = text();
      if (v.trim()) {
        sendMessage(v);
        setText("");
        ta.value = "";
        resize();
      }
    } else if (e.key === "ArrowUp" && !text()) {
      const mine = [...s.msgs].reverse().find((m) => m.authorId === s.user?.id && !m.id.startsWith("p"));
      if (mine) { e.preventDefault(); set("editing", mine.id); }
    }
  };
  return (
    <div class="composer">
      <Show when={s.replyTo}>
        {(r) => (
          <div class="replying">
            <span class="muted">Replying to</span>
            <span class="quote-author">{userName(r().authorId)}</span>
            <span class="quote-text">{preview(r().content, userName, 80)}</span>
            <button class="link" onClick={() => set("replyTo", null)} aria-label="Cancel reply">Cancel</button>
          </div>
        )}
      </Show>
      <Show when={matches().length}>
        <ul class="suggest" role="listbox">
          <For each={matches()}>
            {(m, i) => (
              <li role="option" aria-selected={i() === pick()} classList={{ on: i() === pick() }}
                onMouseDown={(e) => { e.preventDefault(); insert(m.name); }}>
                <Avatar id={m.id} size={20} /> {m.name}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <textarea
        ref={ta}
        rows={1}
        maxLength={4000}
        placeholder={s.replyTo ? `Reply in ${name()}` : `Write in ${name()}`}
        onInput={(e) => { setText(e.currentTarget.value); setCaret(e.currentTarget.selectionStart); setPick(0); resize(); }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKey}
        autofocus
      />
    </div>
  );
}
