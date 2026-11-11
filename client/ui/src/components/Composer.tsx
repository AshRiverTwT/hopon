import { createMemo, createSignal, For, Show } from "solid-js";
import { currentServer, iAmTyping, s, sendMessage, set, typingIn, userName } from "../store";
import { preview } from "../rich";
import { Avatar } from "./Avatar";
import { EmojiPicker } from "./EmojiPicker";

function typingLine(names: string[]): string {
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

export default function Composer() {
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [pick, setPick] = createSignal(0);
  const [emoji, setEmoji] = createSignal(false);
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

  /** Insert text at the caret (used by the emoji picker). */
  const insertAtCaret = (t: string) => {
    const start = ta.selectionStart ?? text().length;
    const end = ta.selectionEnd ?? start;
    const next = text().slice(0, start) + t + text().slice(end);
    setText(next);
    ta.value = next;
    const c = start + t.length;
    ta.focus();
    ta.setSelectionRange(c, c);
    setCaret(c);
    resize();
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
      <div class="compose-row">
      <textarea
        ref={ta}
        rows={1}
        maxLength={4000}
        placeholder={s.replyTo ? `Reply in ${name()}` : `Write in ${name()}`}
        onInput={(e) => { setText(e.currentTarget.value); setCaret(e.currentTarget.selectionStart); setPick(0); resize(); if (e.currentTarget.value.trim()) iAmTyping(); }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKey}
        autofocus
      />
      <button class="emoji-btn" classList={{ on: emoji() }} title="Emoji" aria-label="Insert emoji" onClick={() => setEmoji((v) => !v)}>
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6" /><circle cx="7.2" cy="8" r="1.2" fill="currentColor" /><circle cx="12.8" cy="8" r="1.2" fill="currentColor" /><path d="M6.4 11.6c.9 1.6 2.1 2.4 3.6 2.4s2.7-.8 3.6-2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <Show when={emoji()}>
        <EmojiPicker class="for-composer" pick={(e, keep) => { insertAtCaret(e); if (!keep) setEmoji(false); }} close={() => setEmoji(false)} />
      </Show>
      </div>
      <div class="typing" aria-live="polite">{typingLine(typingIn(s.selChannel))}</div>
    </div>
  );
}
