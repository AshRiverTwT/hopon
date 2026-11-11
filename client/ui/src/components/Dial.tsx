// Rotary channel dial. Channels sit on an arc around the server monogram; the
// item under the cursor is in the pill. Wheel / arrow keys turn the dial, and
// it settles on (selects) the channel under the cursor after a short pause.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { currentServer, s, selectChannel, showStage } from "../store";
import type { Channel } from "../types";
import { VoiceGlyph } from "./icons";

const STEP_DEG = 11;
const RADIUS = 300;
const CENTER_X = -150;
const VISIBLE = 6;

type Item = { kind: "ch"; ch: Channel } | { kind: "new"; voice: boolean };

export default function Dial(p: { onNewChannel: (voice: boolean) => void; onServers: () => void }) {
  const sv = currentServer;
  const items = createMemo<Item[]>(() => {
    const server = sv();
    if (!server) return [];
    const list: Item[] = [
      ...server.channels.filter((c) => !c.voice).map((ch) => ({ kind: "ch" as const, ch })),
      ...server.channels.filter((c) => c.voice).map((ch) => ({ kind: "ch" as const, ch })),
    ];
    if (server.ownerId === s.user?.id) list.push({ kind: "new", voice: false }, { kind: "new", voice: true });
    return list;
  });
  const selectedIndex = () => {
    const id = s.stage ?? s.selChannel;
    const i = items().findIndex((it) => it.kind === "ch" && it.ch.id === id);
    return i < 0 ? 0 : i;
  };
  const [pos, setPos] = createSignal(0);
  createEffect(on(selectedIndex, (i) => setPos(i)));

  let settle = 0;
  const activate = (i: number, immediate: boolean) => {
    const it = items()[i];
    if (!it) return;
    clearTimeout(settle);
    const go = () => {
      if (it.kind === "new") { if (immediate) p.onNewChannel(it.voice); return; }
      if (it.ch.voice) showStage(it.ch.id);
      else if (s.selChannel !== it.ch.id || s.stage) selectChannel(it.ch.id);
    };
    if (immediate) go(); else settle = window.setTimeout(go, 320);
  };
  onCleanup(() => clearTimeout(settle));

  const move = (d: number) => {
    const n = Math.max(0, Math.min(items().length - 1, pos() + d));
    if (n !== pos()) { setPos(n); activate(n, false); }
  };
  let acc = 0;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    acc += e.deltaY;
    while (Math.abs(acc) >= 60) { move(Math.sign(acc)); acc -= Math.sign(acc) * 60; }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); activate(pos(), true); }
  };

  const occupants = (c: Channel) => Object.values(s.presence).filter((x) => x.channelId === c.id);
  const monogram = () => (sv()?.name ?? "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 3).toUpperCase() || "—";

  return (
    <nav class="dial" onWheel={onWheel} onKeyDown={onKey} tabIndex={0} role="listbox" aria-label="Channels">
      <button class="monogram display" title="Switch server" onClick={p.onServers}>{monogram()}</button>
      <For each={items()}>
        {(it, i) => {
          const off = () => i() - pos();
          const theta = () => off() * STEP_DEG;
          const style = () => {
            const r = (theta() * Math.PI) / 180;
            const x = CENTER_X + RADIUS * Math.cos(r);
            const y = RADIUS * Math.sin(r);
            return {
              transform: `translate(${x}px, calc(${y}px - 50%)) rotate(${theta()}deg)`,
              opacity: String(Math.max(0, 1 - Math.abs(off()) * 0.17)),
              visibility: Math.abs(off()) > VISIBLE ? "hidden" : "visible",
            } as const;
          };
          const label = () => {
            if (it.kind === "new") return it.voice ? "+ Voice room" : "+ Channel";
            return it.ch.name;
          };
          const speaking = () => it.kind === "ch" && it.ch.voice && occupants(it.ch).some((o) => s.speaking.includes(o.userId));
          return (
            <button
              class="dial-item"
              role="option"
              aria-selected={off() === 0}
              classList={{ cursor: off() === 0, add: it.kind === "new" }}
              style={style()}
              tabIndex={-1}
              onClick={() => { setPos(i()); activate(i(), true); }}
            >
              <Show when={it.kind === "ch" && it.ch.voice}><VoiceGlyph /></Show>
              <span>{label()}</span>
              <Show when={it.kind === "ch" && it.ch.voice && occupants(it.ch).length}>
                <span class="count">{it.kind === "ch" ? occupants(it.ch).length : ""}</span>
              </Show>
              <Show when={(it.kind === "ch" && !!s.unread[it.ch.id]) || speaking()}><span class="live-dot" /></Show>
            </button>
          );
        }}
      </For>
    </nav>
  );
}
