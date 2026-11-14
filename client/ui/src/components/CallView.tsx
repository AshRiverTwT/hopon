// Fullscreen call view. The window goes fullscreen and shows the voice room
// either as a grid (everyone as a tile: their stream if you're watching it,
// else their camera, else their avatar) or focused on one picture with
// everyone else in a strip. One switch (top right) flips between the two.
// Controls along the bottom: Camera, Stream, Mic, Leave; on the right the
// stream's volume, picture in picture and Exit.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { cameraTrack, disconnectScreens, GRID, popOut, screen, SELF, setCameraEnabled, setFullscreen, setScreen, setViewingCameras, watch } from "../screen";
import { StreamVideo, StreamVolume } from "./Streams";
import { mediaErr, StreamButton } from "./Stage";
import { CameraIcon, ExitFullIcon, FocusIcon, MicIcon, MicOffIcon, PhoneOffIcon, PipIcon, TilesIcon } from "./icons";
import { Avatar } from "./Avatar";
import { call } from "../ipc";
import { s, userName } from "../store";

function CameraVideo(p: { userId: string; own: boolean }) {
  let video!: HTMLVideoElement;
  createEffect(() => {
    const track = cameraTrack(p.userId);
    if (!track) return;
    track.attach(video);
    void video.play().catch(() => {});
    onCleanup(() => { track.detach(video); video.srcObject = null; });
  });
  return <video ref={video} classList={{ mirrored: p.own }} autoplay playsinline muted aria-label={`Camera for ${userName(p.userId)}`} />;
}

export default function CallView() {
  const me = () => s.user?.id ?? "";
  const room = () => s.voice.channelId;
  const roomName = () => s.servers.flatMap((x) => x.channels).find((c) => c.id === room())?.name ?? "Voice";
  const people = createMemo(() => {
    const list = Object.values(s.presence).filter((p) => p.channelId === room()).map((p) => p.userId);
    if (me() && room() && !list.includes(me())) list.unshift(me());
    return list;
  });
  const sharing = (u: string) => (u === me() ? screen.sharing : s.media.screen[u] === room() || screen.shares.some((x) => x.userId === u));
  const camOn = (u: string) => (u === me() ? screen.cameraOn : s.media.camera[u] === room()) && !!cameraTrack(u);
  const showsStream = (u: string) => (u === me() ? screen.sharing : screen.watching.includes(u));
  const muted = (u: string) => { const p = u === me() ? s.voice : s.presence[u]; return !!(p?.muted || p?.deafened); };
  const focus = () => (screen.full === GRID ? null : screen.full === SELF ? me() : screen.full);
  const [last, setLast] = createSignal<string | null>(null);
  createEffect(() => { const f = focus(); if (f) setLast(f); });

  // Cameras are only downloaded while a view shows them.
  onMount(() => void setViewingCameras(true).catch(() => {}));
  onCleanup(() => void setViewingCameras(false).catch(() => {}));
  // Left the voice room: nothing to show.
  createEffect(() => { if (!room()) setFullscreen(null); });

  // Controls fade out while the mouse rests.
  const [idle, setIdle] = createSignal(false);
  let t = 0;
  const poke = () => { setIdle(false); clearTimeout(t); t = window.setTimeout(() => setIdle(true), 2500); };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setFullscreen(null); }
  };
  onMount(() => { window.addEventListener("keydown", key, true); poke(); });
  onCleanup(() => { window.removeEventListener("keydown", key, true); clearTimeout(t); });
  createEffect(on(() => screen.full, poke));

  const focusOn = (u: string) => {
    if (u !== me() && sharing(u) && !screen.watching.includes(u)) void watch(u).catch(mediaErr);
    setScreen("full", u === me() ? SELF : u);
  };
  const toggleLayout = () => {
    if (focus()) { setScreen("full", GRID); return; }
    const pick = (last() && people().includes(last()!) ? last() : null)
      ?? screen.watching.find((u) => people().includes(u))
      ?? people().find((u) => u !== me() && sharing(u))
      ?? people().find((u) => u !== me()) ?? me();
    if (pick) focusOn(pick);
  };
  const [camBusy, setCamBusy] = createSignal(false);
  const toggleCamera = async () => {
    setCamBusy(true);
    try { await setCameraEnabled(!screen.cameraOn); } catch (e) { mediaErr(e); } finally { setCamBusy(false); }
  };
  const leave = () => { setFullscreen(null); void disconnectScreens(true); void call("voice_leave").catch(mediaErr); };
  // PiP: the focused stream floats over other apps (or HopOn's mini player), and fullscreen ends.
  const pip = () => { const f = screen.full; if (!f || f === GRID) return; void popOut(f); setFullscreen(null); };

  // Grid: the biggest 16:9 tiles that fit everyone.
  let stage!: HTMLDivElement;
  const [box, setBox] = createSignal({ w: 1280, h: 720 });
  onMount(() => {
    const ro = new ResizeObserver(() => setBox({ w: stage.clientWidth, h: stage.clientHeight }));
    ro.observe(stage);
    onCleanup(() => ro.disconnect());
  });
  const grid = createMemo(() => {
    const n = Math.max(1, people().length), gap = 10;
    let best = { cols: 1, w: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((box().w - gap * (cols - 1)) / cols, ((box().h - gap * (rows - 1)) / rows) * (16 / 9));
      if (w > best.w) best = { cols, w };
    }
    return { cols: best.cols, w: Math.floor(best.w) };
  });

  function Tile(p: { u: string; small?: boolean }) {
    const own = () => p.u === me();
    return (
      <li class="call-tile" classList={{ speaking: s.speaking.includes(p.u), small: p.small }} onClick={() => focusOn(p.u)}
        onDblClick={() => focus() === p.u && setScreen("full", GRID)} title={focus() === p.u ? "Double-click for everyone" : `Focus on ${userName(p.u)}`}>
        <Show when={showsStream(p.u)} fallback={
          <Show when={camOn(p.u)} fallback={<div class="call-av"><Avatar id={p.u} size={p.small ? 44 : 88} class={s.speaking.includes(p.u) ? "speaking" : ""} /></div>}>
            <CameraVideo userId={p.u} own={own()} />
          </Show>
        }>
          <StreamVideo userId={own() ? SELF : p.u} />
          <Show when={camOn(p.u) && !p.small}><div class="call-inset"><CameraVideo userId={p.u} own={own()} /></div></Show>
        </Show>
        <Show when={!own() && sharing(p.u) && !screen.watching.includes(p.u)}>
          <button class="call-watch" disabled={screen.pending.includes(p.u)} onClick={(e) => { e.stopPropagation(); void watch(p.u).catch(mediaErr); }}>
            {screen.pending.includes(p.u) ? "Connecting…" : "Watch stream"}
          </button>
        </Show>
        <div class="call-name">
          <Show when={muted(p.u)}><span class="call-mic"><MicOffIcon /></span></Show>
          <span>{userName(p.u)}</span>
          <Show when={sharing(p.u)}><span class="live-badge">LIVE</span></Show>
        </div>
      </li>
    );
  }

  return (
    <div class="call" classList={{ idle: idle() }} onPointerMove={poke} role="dialog" aria-label={`${roomName()} call`}>
      <header class="call-top">
        <span class="eyebrow">Voice room</span>
        <span class="call-title">{roomName()}</span>
        <div class="view-toggle" role="radiogroup" aria-label="Layout">
          <button role="radio" aria-checked={!focus()} classList={{ on: !focus() }} title="Everyone" aria-label="Everyone" onClick={() => focus() && toggleLayout()}><TilesIcon /></button>
          <button role="radio" aria-checked={!!focus()} classList={{ on: !!focus() }} title="Focus one picture" aria-label="Focus" onClick={() => !focus() && toggleLayout()}><FocusIcon /></button>
        </div>
      </header>

      <div class="call-stage" ref={stage}>
        <Show when={focus()} keyed fallback={
          <ul class="call-grid" style={{ "grid-template-columns": `repeat(${grid().cols}, ${grid().w}px)` }}>
            <For each={people()}>{(u) => <Tile u={u} />}</For>
          </ul>
        }>
          {(f) => (
            <div class="call-focus">
              <ul class="call-main"><Tile u={f} /></ul>
              <Show when={people().length > 1}>
                <ul class="call-strip"><For each={people().filter((u) => u !== f)}>{(u) => <Tile u={u} small />}</For></ul>
              </Show>
            </div>
          )}
        </Show>
      </div>

      <footer class="call-bar">
        <span class="call-bar-side" />
        <div class="call-controls">
          <button class="call-btn" classList={{ on: screen.cameraOn }} disabled={camBusy()} title={screen.cameraOn ? "Stop camera" : "Camera"} aria-label={screen.cameraOn ? "Stop camera" : "Camera"} onClick={() => void toggleCamera()}><CameraIcon /></button>
          <StreamButton disabled={s.voice.state !== "connected"} round />
          <button class="call-btn" classList={{ off: s.voice.muted }} title={s.voice.muted ? "Unmute" : "Mute"} aria-label={s.voice.muted ? "Unmute" : "Mute"} onClick={() => call("voice_mute", { muted: !s.voice.muted }).catch(mediaErr)}>
            <Show when={s.voice.muted} fallback={<MicIcon />}><MicOffIcon /></Show>
          </button>
          <button class="call-btn leave" title="Leave the room" aria-label="Leave" onClick={leave}><PhoneOffIcon /></button>
        </div>
        <span class="call-bar-side right">
          <Show when={focus() && focus() !== me() && screen.watching.includes(focus()!)}>
            <StreamVolume userId={focus()!} />
          </Show>
          <Show when={focus() && (focus() === me() ? screen.sharing : screen.watching.includes(focus()!))}>
            <button class="icon-btn" title="Picture in picture: keep watching while you use HopOn" aria-label="Picture in picture" onClick={pip}><PipIcon /></button>
          </Show>
          <button class="icon-btn" title="Exit fullscreen (Esc)" aria-label="Exit fullscreen" onClick={() => setFullscreen(null)}><ExitFullIcon /></button>
        </span>
      </footer>
    </div>
  );
}
