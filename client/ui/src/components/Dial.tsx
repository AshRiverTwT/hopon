// Rotary channel dial. Channels sit on an arc around the server monogram; the
// item under the cursor is in the pill. Wheel / arrow keys turn the dial, and
// it settles on (selects) the channel under the cursor after a short pause.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { currentServer, isUnread, realServers, s, selectChannel, selectServer, showStage } from "../store";
import type { Channel } from "../types";
import { VoiceGlyph } from "./icons";

const STEP_DEG = 11;
const RADIUS = 300;
const VISIBLE = 6;

/** The selected pill starts just right of the server monogram (measured, so
 *  any initials fit) and the pills narrow with the column: nothing overlaps
 *  or runs off the edge in a small window. */
function geometry(w: number, monoRight: number) {
  // Room between the monogram and the pills for the encoder's tick scale.
  const x0 = Math.max(monoRight + 34, Math.min(160, w * 0.42));
  return { centerX: x0 - RADIUS, maxW: Math.max(72, w - x0 - 8) };
}

/** Radius of the encoder's arc: the server rail lives inside it. */
const SCALE_R = RADIUS - 10;

/** The encoder's scale: a tick per channel (the selected one long and lit),
 *  minor ticks between, on an arc just inside the pills. Turns with the dial. */
function Scale(p: { count: number; pos: number; centerX: number }) {
  const R = SCALE_R;
  const S = R + 4;
  const ticks = () => {
    const out: { a: number; major: boolean; i: number }[] = [];
    for (let i = 0; i < p.count; i++) {
      out.push({ a: i * STEP_DEG, major: true, i });
      if (i < p.count - 1) for (let k = 1; k < 4; k++) out.push({ a: i * STEP_DEG + (k * STEP_DEG) / 4, major: false, i });
    }
    return out;
  };
  return (
    <svg class="dial-scale" aria-hidden="true" width={S * 2} height={S * 2} viewBox={`${-S} ${-S} ${S * 2} ${S * 2}`}
      style={{ left: `${p.centerX - S}px`, top: `calc(var(--dial-y, 50%) - ${S}px)`, transform: `rotate(${-p.pos * STEP_DEG}deg)` }}>
      <circle r={R} class="scale-arc" />
      <circle r={R - 26} class="scale-arc inner" />
      {ticks().map((t) => {
        const r = (t.a * Math.PI) / 180;
        const on = t.major && t.i === p.pos;
        const len = on ? 20 : t.major ? 11 : 5;
        return <line class={on ? "tick on" : t.major ? "tick major" : "tick"} x1={Math.cos(r) * (R - len)} y1={Math.sin(r) * (R - len)} x2={Math.cos(r) * R} y2={Math.sin(r) * R} />;
      })}
    </svg>
  );
}

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
  const [box, setBox] = createSignal({ w: 300, mono: 110 });
  let nav!: HTMLElement;
  /** Vertical centre of the dial (px from the top of this column). */
  let dialY = 0;
  let mono!: HTMLButtonElement;
  onMount(() => {
    // Centre on the window, not on this row: the header above changes height
    // between views (voice label, fitted titles, topics), and the monogram and
    // the selected pill must not move when you switch channels.
    const centre = () => {
      const frame = nav.parentElement?.getBoundingClientRect();
      const r = nav.getBoundingClientRect();
      if (frame) { dialY = Math.round(frame.top + frame.height / 2 - r.top); nav.style.setProperty("--dial-y", `${dialY}px`); }
    };
    const measure = () => { setBox({ w: nav.clientWidth, mono: mono.offsetLeft + mono.offsetWidth }); centre(); };
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    ro.observe(mono);
    onCleanup(() => ro.disconnect());
  });
  const geo = createMemo(() => geometry(box().w, box().mono));
  createEffect(on(selectedIndex, (i) => setPos(i)));

  // ----- servers: a straight rail through the monogram (previous above, next below) -----
  const servers = createMemo(() => realServers());
  const curServer = () => Math.max(0, servers().findIndex((x) => x.id === s.selServer));
  const [spos, setSpos] = createSignal(0);
  const [dir, setDir] = createSignal<1 | -1>(1);
  createEffect(on(curServer, (i, prev) => { if (prev !== undefined && i !== prev) setDir(i > prev ? 1 : -1); setSpos(i); }));
  let serverSettle = 0;
  const goServer = (i: number, immediate: boolean) => {
    const target = servers()[i];
    if (!target) return;
    if (i !== spos()) setDir(i > spos() ? 1 : -1);
    setSpos(i);
    clearTimeout(serverSettle);
    const go = () => { if (target.id !== s.selServer) selectServer(target.id); };
    if (immediate) go(); else serverSettle = window.setTimeout(go, 360);
  };
  const moveServer = (d: number) => {
    const n = Math.max(0, Math.min(servers().length - 1, spos() + d));
    if (n !== spos()) goServer(n, false);
  };
  onCleanup(() => clearTimeout(serverSettle));
  const RAIL_Y = [0, 84, 146, 196];
  const RAIL_SCALE = [1, 0.5, 0.36, 0.28];
  const serverUnread = (id: string) => !!s.servers.find((x) => x.id === id)?.channels.some((c) => isUnread(c));
  const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 3).toUpperCase() || "—";

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
  let sacc = 0;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Inside the scale's arc (the half-circle around the monogram) the wheel
    // turns the server rail; outside it, the channels.
    const r = nav.getBoundingClientRect();
    if (Math.hypot(e.clientX - r.left - geo().centerX, e.clientY - r.top - (dialY || r.height / 2)) < SCALE_R) {
      sacc += e.deltaY;
      while (Math.abs(sacc) >= 60) { moveServer(Math.sign(sacc)); sacc -= Math.sign(sacc) * 60; }
      return;
    }
    acc += e.deltaY;
    while (Math.abs(acc) >= 60) { move(Math.sign(acc)); acc -= Math.sign(acc) * 60; }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); activate(pos(), true); }
  };

  const occupants = (c: Channel) => Object.values(s.presence).filter((x) => x.channelId === c.id);
  const monogram = () => initials(servers()[spos()]?.name ?? sv()?.name ?? "");

  return (
    <nav ref={nav} class="dial" onWheel={onWheel} onKeyDown={onKey} tabIndex={0} role="listbox" aria-label="Channels">
      <Scale count={items().length} pos={pos()} centerX={geo().centerX} />
      {/* Clipped to the arc: the rail never shows past the semicircle. */}
      <div class="server-rails" style={{ "clip-path": `circle(${SCALE_R - 4}px at ${geo().centerX}px var(--dial-y, 50%))` }}>
      <For each={servers()}>
        {(server, i) => {
          const off = () => i() - spos();
          const k = () => Math.min(3, Math.abs(off()));
          return (
            <button class="server-rail display" classList={{ hidden: off() === 0 || Math.abs(off()) > 3 }} tabIndex={-1}
              aria-label={`Switch to ${server.name}`} title={server.name} onClick={() => goServer(i(), true)}
              style={{ transform: `translateY(calc(-50% + ${Math.sign(off()) * (RAIL_Y[k()] ?? 240)}px)) scale(${RAIL_SCALE[k()] ?? 0.2})`, opacity: String(off() === 0 ? 0 : [1, 0.55, 0.3, 0.14][k()] ?? 0) }}>
              {initials(server.name)}<Show when={serverUnread(server.id) && server.id !== s.selServer}><i class="rail-unread" /></Show>
            </button>
          );
        }}
      </For>
      </div>
      <button ref={mono} class="monogram display" title="Switch server" onClick={() => (spos() !== curServer() ? goServer(spos(), true) : p.onServers())}>
        <Show when={monogram()} keyed>{(m) => <span class={`mono-txt ${dir() > 0 ? "from-below" : "from-above"}`}>{m}</span>}</Show>
      </button>
      <div class="dial-readout" aria-hidden="true">
        <span>{String(pos() + 1).padStart(2, "0")}</span><span class="of">/{String(items().length).padStart(2, "0")}</span>
        <span class="kind">{(() => { const it = items()[pos()]; return !it ? "" : it.kind === "new" ? "NEW" : it.ch.voice ? "VOX" : "TXT"; })()}</span>
      </div>
      <For each={items()}>
        {(it, i) => {
          const off = () => i() - pos();
          const theta = () => off() * STEP_DEG;
          const style = () => {
            const r = (theta() * Math.PI) / 180;
            const x = geo().centerX + RADIUS * Math.cos(r);
            const y = RADIUS * Math.sin(r);
            return {
              transform: `translate(${x}px, calc(${y}px - 50%)) rotate(${theta()}deg)`,
              opacity: String(Math.max(0, 1 - Math.abs(off()) * 0.17)),
              visibility: Math.abs(off()) > VISIBLE ? "hidden" : "visible",
              "max-width": `${geo().maxW}px`,
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
              data-k={Math.min(6, Math.abs(i() - pos()))}
              aria-selected={off() === 0}
              classList={{ cursor: off() === 0, add: it.kind === "new" }}
              style={style()}
              tabIndex={-1}
              onClick={() => { setPos(i()); activate(i(), true); }}
            >
              <Show when={it.kind === "ch" && it.ch.voice}><VoiceGlyph /></Show>
              <span class="dial-name">{label()}</span>
              <Show when={it.kind === "ch" && it.ch.voice && occupants(it.ch).length}>
                <span class="count">{it.kind === "ch" ? occupants(it.ch).length : ""}</span>
              </Show>
              <Show when={it.kind === "ch" && (s.mentions[it.ch.id] ?? 0) > 0} fallback={
                <Show when={(it.kind === "ch" && isUnread(it.ch) && s.selChannel !== it.ch.id) || speaking()}><span class="live-dot" /></Show>
              }>
                <span class="mention-badge">@{it.kind === "ch" ? s.mentions[it.ch.id] : ""}</span>
              </Show>
            </button>
          );
        }}
      </For>
    </nav>
  );
}
