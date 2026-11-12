// Views of screen shares you're watching: the tile in the voice room, the
// floating mini player (picture in picture) while you're elsewhere in HopOn,
// and fullscreen. All three only bind a <video> to a stream that stays
// subscribed (screen.ts), so switching between them is instant.
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { bindVideo, screen, SELF, setFullscreen, setScreen, setStreamVolume, streamVolume, unbindVideo, unwatch, viewerCount } from "../screen";
import { s, showStage, userName } from "../store";
import { prefs } from "../prefs";
import { CloseIcon, DockIcon, EyeIcon, ExitFullIcon, FullIcon, PipIcon, SpeakerIcon } from "./icons";

export function StreamVideo(p: { userId: string; onDblClick?: () => void }) {
  let v!: HTMLVideoElement;
  onMount(() => bindVideo(p.userId, v));
  onCleanup(() => unbindVideo(p.userId, v));
  return <video ref={v} autoplay playsinline muted={p.userId === SELF} onDblClick={p.onDblClick} />;
}

/** Eye + number of people watching `userId`'s stream (names on hover). */
export function Viewers(p: { userId: string }) {
  const names = () => (screen.viewers[p.userId] ?? []).map((u) => (u === s.user?.id ? "you" : userName(u))).join(", ");
  return (
    <span class="viewers" title={viewerCount(p.userId) ? `Watching: ${names()}` : "Nobody is watching yet"} aria-label={`${viewerCount(p.userId)} watching`}>
      <EyeIcon />{viewerCount(p.userId)}
    </span>
  );
}

/** Stream sound, 0–100 % (only when the stream has sound). */
export function StreamVolume(p: { userId: string }) {
  const has = () => screen.shares.find((x) => x.userId === p.userId)?.hasAudio;
  const v = () => streamVolume(p.userId);
  return (
    <Show when={has()}>
      <label class="vol stream-vol" title="Stream volume (double-click: 100 %)" onDblClick={() => setStreamVolume(p.userId, 100)}>
        <button class="icon-btn" aria-label={v() ? "Mute stream" : "Unmute stream"} classList={{ off: !v() }}
          onClick={(e) => { e.preventDefault(); setStreamVolume(p.userId, v() ? 0 : 100); }}><SpeakerIcon /></button>
        <input type="range" min="0" max="100" step="1" value={v()} aria-label={`Stream volume for ${userName(p.userId)}`}
          onInput={(e) => setStreamVolume(p.userId, Number(e.currentTarget.value))} style={{ "--pct": `${v()}%` }} />
        <span class="vol-n">{v()}%</span>
      </label>
    </Show>
  );
}

const nameOf = (u: string) => (u === SELF ? "You" : userName(u));

/** A stream in the voice room, with its controls. */
export function StreamTile(p: { userId: string }) {
  return (
    <figure class="stream">
      <div class="stream-frame">
        <StreamVideo userId={p.userId} onDblClick={() => setFullscreen(p.userId)} />
        <Show when={!screen.live[p.userId]}><div class="stream-wait muted">Connecting to {userName(p.userId)}'s stream…</div></Show>
      </div>
      <figcaption>
        <span class="live-badge">LIVE</span>
        <span class="stream-name">{userName(p.userId)}</span>
        <Viewers userId={p.userId} />
        <span class="stream-actions">
          <StreamVolume userId={p.userId} />
          <button class="icon-btn" title="Picture in picture" aria-label="Picture in picture" onClick={() => setScreen("popped", true)}><PipIcon /></button>
          <button class="icon-btn" title="Fullscreen (double-click the picture)" aria-label="Fullscreen" onClick={() => setFullscreen(p.userId)}><FullIcon /></button>
          <button class="link" onClick={() => unwatch(p.userId)}>Stop watching</button>
        </span>
      </figcaption>
    </figure>
  );
}

/** Mini player: shown while you watch and aren't looking at the voice room. */
export function MiniPlayer() {
  const onStage = () => s.stage === screen.channelId;
  const shown = () => screen.watching.length > 0 && !screen.full && (screen.popped || (prefs.autoPip && !onStage()));
  const [pick, setPick] = createSignal<string | null>(null);
  const cur = () => (pick() && screen.watching.includes(pick()!) ? pick()! : screen.watching[0]);
  // Position: offset from the bottom-right corner, kept inside the window.
  const [pos, setPos] = createSignal({ x: 24, y: 88 });
  const [width, setWidth] = createSignal(360);
  let box!: HTMLDivElement;
  const clamp = (x: number, y: number) => ({
    x: Math.max(8, Math.min(window.innerWidth - (box?.offsetWidth ?? 320) - 8, x)),
    y: Math.max(8, Math.min(window.innerHeight - (box?.offsetHeight ?? 180) - 8, y)),
  });
  const onResize = () => setPos((p) => clamp(p.x, p.y));
  onMount(() => window.addEventListener("resize", onResize));
  onCleanup(() => window.removeEventListener("resize", onResize));

  const back = () => {
    setScreen("popped", false);
    if (screen.channelId && !onStage()) showStage(screen.channelId);
  };
  // Drag anywhere on the picture; a press without movement is a click (back to the room).
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, label")) return;
    const start = { cx: e.clientX, cy: e.clientY, ...pos() };
    let moved = false;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.cx, dy = m.clientY - start.cy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      setPos(clamp(start.x - dx, start.y - dy));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (!moved) back();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  // Resize from the top-left corner (the player is anchored bottom-right).
  const grip = (e: PointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX, sw = width();
    const move = (m: PointerEvent) => setWidth(Math.max(240, Math.min(window.innerWidth * 0.7, sw + (sx - m.clientX))));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); onResize(); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <Show when={shown()}>
      <div ref={box} class="pip" style={{ right: `${pos().x}px`, bottom: `${pos().y}px`, width: `${width()}px` }} onPointerDown={down}
        title={screen.popped && onStage() ? "Click to put it back in the room" : "Click to open the voice room · drag to move"}>
        <Show when={cur()} keyed>{(u) => <StreamVideo userId={u} onDblClick={() => setFullscreen(u)} />}</Show>
        <Show when={!screen.live[cur()]}><div class="stream-wait muted">Connecting…</div></Show>
        <div class="pip-bar">
          <span class="live-badge">LIVE</span>
          <span class="stream-name">{userName(cur())}</span>
          <Viewers userId={cur()} />
          <Show when={screen.watching.length > 1}>
            <button class="icon-btn" title="Next stream" aria-label="Next stream"
              onClick={() => setPick(screen.watching[(screen.watching.indexOf(cur()) + 1) % screen.watching.length])}>›</button>
          </Show>
          <span class="stream-actions">
            <button class="icon-btn" title="Back to the voice room" aria-label="Back to the voice room" onClick={back}><DockIcon /></button>
            <button class="icon-btn" title="Fullscreen" aria-label="Fullscreen" onClick={() => setFullscreen(cur())}><FullIcon /></button>
            <button class="icon-btn" title="Stop watching" aria-label="Stop watching" onClick={() => unwatch(cur())}><CloseIcon /></button>
          </span>
        </div>
        <div class="pip-vol"><StreamVolume userId={cur()} /></div>
        <div class="pip-grip" title="Drag to resize" onPointerDown={grip} />
      </div>
    </Show>
  );
}

/** Fullscreen stream: the window goes fullscreen; Esc or the button leaves. */
export function FullStream() {
  const [idle, setIdle] = createSignal(false);
  let t = 0;
  const poke = () => { setIdle(false); clearTimeout(t); t = window.setTimeout(() => setIdle(true), 2500); };
  const key = (e: KeyboardEvent) => {
    if (!screen.full) return;
    if (e.key === "Escape" || e.key === "f" || e.key === "F") { e.preventDefault(); e.stopPropagation(); setFullscreen(null); }
  };
  onMount(() => { window.addEventListener("keydown", key, true); poke(); });
  onCleanup(() => { window.removeEventListener("keydown", key, true); clearTimeout(t); });
  createEffect(on(() => screen.full, poke));
  return (
    <Show when={screen.full} keyed>
      {(u) => (
        <div class="fullstream" classList={{ idle: idle() }} onPointerMove={poke} role="dialog" aria-label={`${nameOf(u)} fullscreen`}>
          <StreamVideo userId={u} onDblClick={() => setFullscreen(null)} />
          <div class="full-bar">
            <span class="live-badge">LIVE</span>
            <span class="stream-name">{u === SELF ? "Your screen" : userName(u)}</span>
            <Viewers userId={u === SELF ? s.user?.id ?? "" : u} />
            <span class="stream-actions">
              <Show when={u !== SELF}><StreamVolume userId={u} /></Show>
              <button class="icon-btn" title="Exit fullscreen (Esc)" aria-label="Exit fullscreen" onClick={() => setFullscreen(null)}><ExitFullIcon /></button>
              <Show when={u !== SELF}>
                <button class="link" onClick={() => unwatch(u)}>Stop watching</button>
              </Show>
            </span>
          </div>
        </div>
      )}
    </Show>
  );
}

/** Stage list of tiles (hidden while the mini player is popped out). */
export function StreamTiles() {
  return (
    <Show when={!screen.popped}>
      <For each={screen.watching}>{(u) => <StreamTile userId={u} />}</For>
    </Show>
  );
}
