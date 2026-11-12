// GIF search popover (Composer). Trending on open, debounced search, click
// sends. Results come through the chat server (the provider key stays there).
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { call } from "../ipc";
import type { Gif } from "../types";

interface Results { enabled: boolean; results: Gif[] }

export function GifPicker(p: { pick: (g: Gif) => void; close: () => void }) {
  const [q, setQ] = createSignal("");
  const [res, setRes] = createSignal<Results | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  let root!: HTMLDivElement;
  let input!: HTMLInputElement;
  let seq = 0;
  let timer = 0;

  const search = (query: string) => {
    const mine = ++seq;
    setBusy(true);
    setErr("");
    call<Results>("gif_search", { query })
      .then((r) => { if (mine === seq) setRes(r); })
      .catch((e) => { if (mine === seq) setErr(String(e)); })
      .finally(() => { if (mine === seq) setBusy(false); });
  };

  onMount(() => {
    search("");
    input.focus();
    const away = (e: MouseEvent) => { if (!root.contains(e.target as Node)) p.close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); p.close(); } };
    setTimeout(() => document.addEventListener("mousedown", away), 0);
    window.addEventListener("keydown", key, true);
    onCleanup(() => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); clearTimeout(timer); });
  });

  return (
    <div class="gif-picker" ref={root} role="dialog" aria-label="GIFs">
      <input ref={input} class="line" placeholder="Search GIFs" value={q()}
        onInput={(e) => { setQ(e.currentTarget.value); clearTimeout(timer); timer = window.setTimeout(() => search(q()), 300); }} />
      <div class="gif-results">
        <Show when={res()?.enabled !== false} fallback={
          <p class="muted small gif-note">GIFs aren't set up on this server yet. The server owner can add a free KLIPY key (see the README).</p>
        }>
          <Show when={!err()} fallback={<p class="muted small gif-note">{err()}</p>}>
            <Show when={res()?.results.length || busy()} fallback={<p class="muted small gif-note">No GIFs found.</p>}>
              <div class="gif-grid">
                <For each={res()?.results ?? []}>
                  {(g) => (
                    <button class="gif-cell" title={g.title} onClick={() => p.pick(g)}
                      style={{ "aspect-ratio": g.width && g.height ? `${g.width} / ${g.height}` : "4 / 3" }}>
                      <img src={g.preview} alt={g.title} loading="lazy" decoding="async" />
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
      <div class="gif-foot muted small">{busy() ? "Searching…" : q() ? "Results" : "Trending"} · Powered by KLIPY</div>
    </div>
  );
}
