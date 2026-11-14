// Your status, from your name in the bottom-left: online / do not disturb /
// invisible, a custom status that can clear itself, and Edit profile.
// Idle is automatic (10 minutes away), so it isn't a choice here.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { clearCustom, customOf, openProfileEditor, setMode, setStatus, untilFor } from "../profile";
import { s } from "../store";
import type { StatusMode } from "../types";
import { Avatar } from "./Avatar";
import { EmojiPicker } from "./EmojiPicker";
import { PresenceDot, StatusLine } from "./PresenceDot";
import { CloseIcon, SmileIcon } from "./icons";

const MODES: { m: StatusMode; label: string }[] = [
  { m: "online", label: "Online" },
  { m: "dnd", label: "Do not disturb" },
  { m: "invisible", label: "Invisible" },
];
const CLEARS: { k: string; label: string }[] = [
  { k: "", label: "Don't clear" },
  { k: "1h", label: "1 hour" },
  { k: "4h", label: "4 hours" },
  { k: "today", label: "Today" },
];

/** Your picture and name (bottom-left); click for your status. */
export function MeButton() {
  const [open, setOpen] = createSignal(false);
  let btn!: HTMLButtonElement;
  return (
    <>
      <button class="me" ref={btn} title="Your status" aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen((v) => !v)}>
        <Show when={s.user}><span class="rail-av"><Avatar id={s.user!.id} size={30} /><PresenceDot id={s.user!.id} /></span></Show>
        <span class="me-name">{s.user?.name}</span>
      </button>
      <Show when={open()}><StatusMenu anchor={btn} close={() => setOpen(false)} /></Show>
    </>
  );
}

function StatusMenu(p: { anchor: HTMLElement; close: () => void }) {
  let el!: HTMLDivElement;
  const cur = () => customOf(s.user?.id ?? "");
  const [emoji, setEmoji] = createSignal(cur()?.emoji ?? "");
  const [text, setText] = createSignal(cur()?.text ?? "");
  const [clear, setClear] = createSignal("");
  const [picker, setPicker] = createSignal(false);
  const dirty = () => emoji() !== (cur()?.emoji ?? "") || text().trim() !== (cur()?.text ?? "");
  const save = () => { void setStatus({ emoji: emoji(), text: text().trim(), until: untilFor(clear()) }); p.close(); };
  const r = p.anchor.getBoundingClientRect();
  const away = (e: PointerEvent) => { if (!el.contains(e.target as Node) && !p.anchor.contains(e.target as Node)) p.close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !picker()) { e.stopPropagation(); p.close(); } };
  setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  document.addEventListener("keydown", key, true);
  onCleanup(() => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); });

  return (
    <Portal>
      <div class="status-menu" ref={el} role="dialog" aria-label="Your status" style={{ left: `${Math.max(8, r.left)}px`, bottom: `${window.innerHeight - r.top + 10}px` }}>
        <div class="status-me">
          <span class="rail-av"><Avatar id={s.user?.id ?? ""} size={36} /><PresenceDot id={s.user?.id ?? ""} /></span>
          <span class="status-who"><span class="status-name">{s.user?.name}</span><span class="muted small">@{s.username}</span></span>
          <button class="link" onClick={() => { p.close(); openProfileEditor(); }}>Edit profile</button>
        </div>

        <div class="status-custom">
          <div class="status-input">
            <button class="status-emoji-btn" title="Pick an emoji" aria-label="Status emoji" onClick={() => setPicker((v) => !v)}>
              <Show when={emoji()} fallback={<SmileIcon />}>{emoji()}</Show>
            </button>
            <input class="line" placeholder="What's up?" maxLength={80} value={text()} spellcheck={false}
              onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") save(); }} />
            <Show when={emoji() || text()}>
              <button class="icon-btn" title="Clear status" aria-label="Clear status" onClick={() => { setEmoji(""); setText(""); if (cur()) { void clearCustom(); } }}><CloseIcon /></button>
            </Show>
          </div>
          <Show when={picker()}>
            <EmojiPicker class="for-status" pick={(e) => { setEmoji(e); setPicker(false); }} close={() => setPicker(false)} />
          </Show>
          <Show when={dirty() && (emoji() || text().trim())}>
            <div class="status-clears" role="radiogroup" aria-label="Clear after">
              <For each={CLEARS}>{(c) => <button role="radio" aria-checked={clear() === c.k} classList={{ on: clear() === c.k }} onClick={() => setClear(c.k)}>{c.label}</button>}</For>
            </div>
            <button class="pill solid status-save" onClick={save}>Set status</button>
          </Show>
          <Show when={!dirty() && cur()?.until}>
            <p class="muted small status-until">Clears {new Date(cur()!.until).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</p>
          </Show>
        </div>

        <ul class="status-modes" role="radiogroup" aria-label="Presence">
          <For each={MODES}>
            {(x) => (
              <li>
                <button role="radio" aria-checked={s.myStatus.mode === x.m} classList={{ on: s.myStatus.mode === x.m }} onClick={() => { void setMode(x.m); p.close(); }}>
                  <i class={`mode-dot ${x.m}`} aria-hidden="true" />{x.label}
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show when={cur()}>{(c) => <div class="status-now muted small">Now: <StatusLine emoji={c().emoji} text={c().text} /></div>}</Show>
      </div>
    </Portal>
  );
}
