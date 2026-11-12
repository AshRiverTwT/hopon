// Right-hand games panel. The game itself is a native child webview that
// the core positions over `.game-host`; it is created on open and destroyed
// on close so it costs nothing while closed.
import { createEffect, createSignal, For, on, onCleanup, onMount } from "solid-js";
import { call } from "../ipc";
import { s, toast } from "../store";
import { GAMES, type GameId } from "../games";
import { prefs, setPrefs } from "../prefs";

export default function GamesPanel(p: { close: () => void }) {
  const [game, setGame] = createSignal<GameId>((GAMES.some((g) => g.id === prefs.game) ? prefs.game : "wordle") as GameId);
  let host!: HTMLDivElement;
  const rect = () => {
    // CSS px → window px: the page may be zoomed (Settings → Display → Scale).
    const r = host.getBoundingClientRect();
    const k = prefs.scale || 1;
    return { x: Math.round(r.left * k), y: Math.round(r.top * k), w: Math.round(r.width * k), h: Math.round(r.height * k) };
  };
  const open = (g: GameId) => {
    setGame(g);
    if (prefs.game !== g) setPrefs({ game: g });
    call("games_open", { game: g, serverId: s.selServer ?? "0", ...rect() }).catch((e) => toast(String(e)));
  };
  // Results go to the server you are looking at.
  createEffect(on(() => s.selServer, (id) => { if (id) call("games_server", { serverId: id }).catch(() => {}); }, { defer: true }));
  createEffect(on(() => prefs.scale, () => requestAnimationFrame(() => call("games_bounds", rect()).catch(() => {})), { defer: true }));
  onMount(() => {
    // The column slides open first; the native game view (drawn on top of the
    // page, positioned over IPC) appears once it has settled.
    const t = window.setTimeout(() => open(game()), 340);
    onCleanup(() => clearTimeout(t));
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => call("games_bounds", rect()).catch(() => {}));
    });
    ro.observe(host);
    onCleanup(() => { ro.disconnect(); call("games_close").catch(() => {}); });
  });
  return (
    <aside class="games">
      <header class="games-head">
        <nav class="games-tabs">
          <For each={GAMES}>
            {(g) => <button classList={{ on: game() === g.id }} onClick={() => game() !== g.id && open(g.id)}>{g.name}</button>}
          </For>
        </nav>
        <div class="games-actions">
          <button class="link" onClick={() => call("games_open_external", { game: game() }).catch((e) => toast(String(e)))}>Open in browser</button>
          <button class="link" onClick={p.close}>Close</button>
        </div>
        <p class="games-note">Hit Share when you finish: your result posts to general.</p>
      </header>
      <div class="game-host" ref={host}><span class="muted">Loading {GAMES.find((g) => g.id === game())?.name}…</span></div>
    </aside>
  );
}
