import type { JSX } from "solid-js";

export function Modal(p: { title: string; close: () => void; children: JSX.Element }) {
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && p.close()} onKeyDown={(e) => e.key === "Escape" && p.close()}>
      <div class="modal" role="dialog" aria-label={p.title}>
        <header><h2>{p.title}</h2><button class="ghost" onClick={p.close} aria-label="Close">✕</button></header>
        {p.children}
      </div>
    </div>
  );
}
