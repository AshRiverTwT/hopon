// Small reaction picker: a fixed set of common reactions.
import { For, onCleanup, onMount } from "solid-js";

export const QUICK = ["👍", "❤️", "😂", "🔥", "🎉", "😮", "😢", "👀", "🙏", "💯", "✅", "❌", "👏", "🤔", "😎", "🥲", "💀", "🫡", "⚡", "🚀", "☕", "🍕", "🎮", "🏆"];

export function EmojiPicker(p: { pick: (e: string) => void; close: () => void }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const away = (e: MouseEvent) => { if (!el.contains(e.target as Node)) p.close(); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && p.close();
    setTimeout(() => document.addEventListener("mousedown", away), 0);
    document.addEventListener("keydown", esc);
    onCleanup(() => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); });
  });
  return (
    <div class="picker" ref={el} role="menu">
      <For each={QUICK}>{(e) => <button class="pick" onClick={() => p.pick(e)} aria-label={`React ${e}`}>{e}</button>}</For>
    </div>
  );
}
