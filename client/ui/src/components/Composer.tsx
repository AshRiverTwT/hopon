import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { currentServer, iAmTyping, rememberMentionCandidates, s, sendMessage, serverUsers, set, toast, typingIn, userName } from "../store";
import { call } from "../ipc";
import { fmtSize } from "../media";
import type { Attachment, User } from "../types";
import { GifPicker } from "./GifPicker";
import { preview } from "../rich";
import { Avatar } from "./Avatar";
import { EmojiPicker } from "./EmojiPicker";

const MAX_FILES = 10;

interface Pending { key: number; name: string; size: number; thumb: string | null; att: Attachment | null; error: string | null }

/** Drop/paste targets elsewhere in the window hand files to the composer. */
let addFilesHook: ((files: File[]) => void) | null = null;
export const addFilesToComposer = (files: File[]) => addFilesHook?.(files);

async function pixelSize(f: File): Promise<[number, number]> {
  if (!f.type.startsWith("image/")) return [0, 0];
  try { const b = await createImageBitmap(f); const r: [number, number] = [b.width, b.height]; b.close(); return r; } catch { return [0, 0]; }
}

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
  const [gif, setGif] = createSignal(false);
  const [files, setFiles] = createSignal<Pending[]>([]);
  const [searchResults, setSearchResults] = createSignal<User[]>([]);
  let ta!: HTMLTextAreaElement;
  let fileInput!: HTMLInputElement;
  let seq = 0;

  const patch = (key: number, p: Partial<Pending>) => setFiles((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const drop = (key: number) => setFiles((l) => { const x = l.find((y) => y.key === key); if (x?.thumb) URL.revokeObjectURL(x.thumb); return l.filter((y) => y.key !== key); });
  const addFiles = (list: File[]) => {
    if (!s.selChannel) return;
    const room = MAX_FILES - files().length;
    if (list.length > room) toast(`Up to ${MAX_FILES} files per message`);
    for (const f of list.slice(0, Math.max(0, room))) {
      const key = ++seq;
      const thumb = f.type.startsWith("image/") ? URL.createObjectURL(f) : null;
      setFiles((l) => [...l, { key, name: f.name || "file", size: f.size, thumb, att: null, error: null }]);
      (async () => {
        try {
          const [w, h] = await pixelSize(f);
          const bytes = new Uint8Array(await f.arrayBuffer());
          const att = await call<Attachment>("upload_file", bytes, { headers: { "x-name": encodeURIComponent(f.name || "file"), "x-w": String(w), "x-h": String(h) } });
          patch(key, { att });
        } catch (e) {
          patch(key, { error: String(e) });
        }
      })();
    }
    ta.focus();
  };
  onMount(() => { addFilesHook = addFiles; onCleanup(() => { if (addFilesHook === addFiles) addFilesHook = null; }); });
  onCleanup(() => files().forEach((f) => f.thumb && URL.revokeObjectURL(f.thumb)));
  const uploading = () => files().some((f) => !f.att && !f.error);
  const name = () => currentServer()?.channels.find((c) => c.id === s.selChannel)?.name ?? "";

  // "@que" right before the caret → member suggestions.
  const query = createMemo(() => {
    const before = text().slice(0, caret());
    const m = before.match(/(^|[\s(])@([^\s@<>]{0,32})$/);
    return m ? m[2] : null;
  });
  let searchSeq = 0;
  createEffect(() => {
    const q = query();
    const serverId = currentServer()?.id;
    if (!q || !serverId) { searchSeq++; setSearchResults([]); return; }
    const seq = ++searchSeq;
    const timer = window.setTimeout(() => {
      call<User[]>("member_search", { serverId, query: q })
        .then((users) => {
          if (seq !== searchSeq) return;
          setSearchResults(users);
          rememberMentionCandidates(serverId, users);
        }).catch(() => {});
    }, 130);
    onCleanup(() => clearTimeout(timer));
  });
  const matches = createMemo(() => {
    const q = query();
    if (q === null) return [];
    const ql = q.toLowerCase();
    const merged = new Map(serverUsers(currentServer()).map((m) => [m.id, m]));
    for (const m of searchResults()) merged.set(m.id, m);
    return [...merged.values()].filter((m) => m.name.toLowerCase().startsWith(ql)).slice(0, 6);
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
      const ready = files().filter((f) => f.att).map((f) => f.att!);
      if (uploading()) { toast("Still uploading…"); return; }
      if (v.trim() || ready.length) {
        sendMessage(v, ready);
        setText("");
        ta.value = "";
        files().forEach((f) => f.thumb && URL.revokeObjectURL(f.thumb));
        setFiles([]);
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
      <Show when={files().length}>
        <ul class="pending-files">
          <For each={files()}>
            {(f) => (
              <li classList={{ failed: !!f.error, busy: !f.att && !f.error }} title={f.error ?? f.name}>
                <Show when={f.thumb} fallback={<span class="pf-icon">{(f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE"}</span>}>
                  <img src={f.thumb!} alt="" />
                </Show>
                <span class="pf-name">{f.name}</span>
                <span class="pf-state">{f.error ? "Failed" : f.att ? fmtSize(f.size) : "Uploading…"}</span>
                <button class="pf-x" aria-label={`Remove ${f.name}`} onClick={() => drop(f.key)}>×</button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="compose-row">
      <button class="attach-btn" title="Attach files" aria-label="Attach files" onClick={() => fileInput.click()}>
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
      </button>
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ""; }} />
      <textarea
        ref={ta}
        rows={1}
        maxLength={4000}
        placeholder={s.replyTo ? `Reply in ${name()}` : `Write in ${name()}`}
        onInput={(e) => { setText(e.currentTarget.value); setCaret(e.currentTarget.selectionStart); setPick(0); resize(); if (e.currentTarget.value.trim()) iAmTyping(); }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKey}
        onPaste={(e) => { const f = [...(e.clipboardData?.files ?? [])]; if (f.length) { e.preventDefault(); addFiles(f); } }}
        autofocus
      />
      <button class="gif-btn" classList={{ on: gif() }} title="GIFs" aria-label="GIFs" onClick={() => { setEmoji(false); setGif((v) => !v); }}>GIF</button>
      <Show when={gif()}>
        <GifPicker pick={(g) => { setGif(false); sendMessage("", [], [g]); ta.focus(); }} close={() => setGif(false)} />
      </Show>
      <button class="emoji-btn" classList={{ on: emoji() }} title="Emoji" aria-label="Insert emoji" onClick={() => { setGif(false); setEmoji((v) => !v); }}>
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
