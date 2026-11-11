import { onCleanup, onMount, type JSX } from "solid-js";

/** Full-window sheet. Escape or "Close" dismisses. */
export function Overlay(p: { title: string; close: () => void; children: JSX.Element }) {
  onMount(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.close();
    window.addEventListener("keydown", k);
    onCleanup(() => window.removeEventListener("keydown", k));
  });
  return (
    <div class="sheet" role="dialog" aria-label={p.title}>
      <div class="sheet-bar">
        <span class="eyebrow">HopOn</span>
        <button class="pill" onClick={p.close}>Close</button>
      </div>
      <div class="sheet-body">
        <h1 class="display sheet-title">{p.title}</h1>
        {p.children}
      </div>
    </div>
  );
}
