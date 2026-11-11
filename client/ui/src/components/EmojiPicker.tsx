// Emoji picker shared by the composer and reactions: search, recent, and
// categories. Built only while open.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { CATEGORIES, searchEmoji } from "../emoji";
import { prefs, setPrefs } from "../prefs";

export function noteRecent(e: string) {
  setPrefs({ recentEmoji: [e, ...prefs.recentEmoji.filter((x) => x !== e)].slice(0, 24) });
}

export function EmojiPicker(p: { pick: (e: string, keepOpen: boolean) => void; close: () => void; class?: string }) {
  let el!: HTMLDivElement;
  let input!: HTMLInputElement;
  let grid!: HTMLDivElement;
  const [q, setQ] = createSignal("");
  const results = createMemo(() => searchEmoji(q()));
  // Shift-click keeps the picker open to add several emoji.
  const choose = (e: string, keepOpen = false) => { noteRecent(e); p.pick(e, keepOpen); };

  onMount(() => {
    const away = (e: MouseEvent) => { if (!el.contains(e.target as Node)) p.close(); };
    setTimeout(() => document.addEventListener("mousedown", away), 0);
    onCleanup(() => document.removeEventListener("mousedown", away));
    input.focus({ preventScroll: true });
  });
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); p.close(); }
    if (e.key === "Enter") { e.preventDefault(); const first = q() ? results()[0]?.e : prefs.recentEmoji[0]; if (first) choose(first); }
  };
  const jump = (name: string) => grid.querySelector(`[data-cat="${name}"]`)?.scrollIntoView({ block: "start" });

  return (
    <div class={`emoji-picker ${p.class ?? ""}`} ref={el} role="dialog" aria-label="Emoji" onKeyDown={onKey}>
      <input ref={input} class="emoji-search" placeholder="Search emoji" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <Show when={!q()}>
        <nav class="emoji-tabs">
          <Show when={prefs.recentEmoji.length}><button title="Recent" onClick={() => jump("Recent")}>🕘</button></Show>
          <For each={CATEGORIES}>{(c) => <button title={c.name} onClick={() => jump(c.name)}>{c.list[0].e}</button>}</For>
        </nav>
      </Show>
      <div class="emoji-grid" ref={grid}>
        <Show when={q()} fallback={
          <>
            <Show when={prefs.recentEmoji.length}>
              <div class="emoji-cat" data-cat="Recent">Recent</div>
              <div class="emoji-cells"><For each={prefs.recentEmoji}>{(e) => <button class="pick" onClick={(ev) => choose(e, ev.shiftKey)}>{e}</button>}</For></div>
            </Show>
            <For each={CATEGORIES}>
              {(c) => (
                <>
                  <div class="emoji-cat" data-cat={c.name}>{c.name}</div>
                  <div class="emoji-cells">
                    <For each={c.list}>{(x) => <button class="pick" title={x.k.split(" ")[0]} onClick={(ev) => choose(x.e, ev.shiftKey)}>{x.e}</button>}</For>
                  </div>
                </>
              )}
            </For>
          </>
        }>
          <Show when={results().length} fallback={<div class="emoji-none">No emoji match "{q()}"</div>}>
            <div class="emoji-cells"><For each={results()}>{(x) => <button class="pick" title={x.k.split(" ")[0]} onClick={(ev) => choose(x.e, ev.shiftKey)}>{x.e}</button>}</For></div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
