// Right-hand games panel. The game itself is a native child webview that
// the core positions over `.game-host`; it is created on open and destroyed
// on close so it costs nothing while closed.
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { call } from "../ipc";
import { s, toast } from "../store";
import { GAMES, type GameId } from "../games";

export default function GamesPanel(p: { close: () => void }) {
  const [game, setGame] = createSignal<GameId>((() => { try { return (localStorage.getItem("game") as GameId) || "wordle"; } catch { return "wordle"; } })());
  let host!: HTMLDivElement;
  const rect = () => {
    const r = host.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const open = (g: GameId) => {
    setGame(g);
    try { localStorage.setItem("game", g); } catch {}
    call("games_open", { game: g, serverId: s.selServer ?? "0", ...rect() }).catch((e) => toast(String(e)));
  };
  onMount(() => {
    requestAnimationFrame(() => open(game()));
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
