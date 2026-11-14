// Voice room view: who is here, who is speaking, join / leave. Controls stay
// minimal (Leave, Camera, Stream); the fullscreen call view (CallView.tsx)
// shows everyone as tiles or one picture big.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { attachLocalPreview, disconnectScreens, GRID, popOut, QUALITIES, screen, SELF, setCameraEnabled, setFullscreen, setScreen, startShare, stopShare, viewerCount, watch, type Quality } from "../screen";
import { StreamTiles, Viewers } from "./Streams";
import { CameraIcon, FullIcon, GrowIcon, PipIcon, ScreenIcon, ShrinkIcon } from "./icons";
import { call } from "../ipc";
import { currentServer, s, toast, userName } from "../store";
import { Avatar } from "./Avatar";
import { FitTitle } from "./FitTitle";
import { openProfile } from "../profile";
import { openAudio } from "../sounds";
import { prefs, setPrefs } from "../prefs";

/** 0–200 %, remembered per person (follows your account). */
export function VolumeSlider(p: { userId: string }) {
  const v = () => prefs.userVolumes[p.userId] ?? 100;
  const set = (n: number) => {
    setPrefs({ userVolumes: { ...prefs.userVolumes, [p.userId]: n } });
    call("voice_volume", { userId: p.userId, volume: n / 100 }).catch(() => {});
  };
  return (
    <label class="vol" title="Volume (double-click to reset)" onDblClick={() => set(100)}>
      <input type="range" min="0" max="200" step="5" value={v()} aria-label={`Volume for ${userName(p.userId)}`}
        onInput={(e) => set(Number(e.currentTarget.value))} style={{ "--pct": `${v() / 2}%` }} />
      <span class="vol-n">{v()}%</span>
    </label>
  );
}

export const mediaErr = (e: unknown) => { const m = String(e); if (!/NotAllowed|Permission|denied|AbortError/i.test(m)) toast(m); };

/** Stream button: pick a quality, then it becomes Stop streaming. */
export function StreamButton(p: { disabled: boolean; round?: boolean }) {
  const [menu, setMenuOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // The menu lives at the window level (a scrolling or contained column would
  // clip it), anchored to the button: above it if there's room, else below.
  const [at, setAt] = createSignal<Record<string, string>>({});
  const MENU_H = 330, MENU_W = 270;
  const setMenu = (v: boolean | ((x: boolean) => boolean)) => {
    const open = typeof v === "function" ? v(menu()) : v;
    if (open) {
      const r = box.getBoundingClientRect();
      const left = `${Math.max(8, Math.min(window.innerWidth - MENU_W - 8, r.right - MENU_W))}px`;
      const below = window.innerHeight - r.bottom >= MENU_H + 16;
      setAt(below || r.top < MENU_H + 16 ? { left, top: `${r.bottom + 8}px` } : { left, bottom: `${window.innerHeight - r.top + 8}px` });
    }
    setMenuOpen(open);
  };
  let box!: HTMLDivElement;
  let menuEl: HTMLDivElement | undefined;
  const close = (e: PointerEvent) => { if (!box.contains(e.target as Node) && !menuEl?.contains(e.target as Node)) setMenu(false); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(false); } };
  createEffect(() => {
    if (!menu()) return;
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", key, true); });
  });
  const start = async (q: Quality) => {
    setMenu(false);
    setBusy(true);
    try { await startShare(q); }
    catch (e) { mediaErr(e); }
    finally { setBusy(false); }
  };
  return (
    <div class="stream-btn" ref={box}>
      <Show when={screen.sharing} fallback={
        <Show when={p.round} fallback={
          <button class="pill" aria-haspopup="menu" aria-expanded={menu()} disabled={p.disabled || busy()} onClick={() => setMenu((v) => !v)}>
            <ScreenIcon /> {busy() ? "Starting…" : "Stream"}
          </button>
        }>
          <button class="call-btn" title="Stream your screen" aria-label="Stream" aria-haspopup="menu" aria-expanded={menu()} disabled={p.disabled || busy()} onClick={() => setMenu((v) => !v)}><ScreenIcon /></button>
        </Show>
      }>
        <Show when={p.round} fallback={<button class="pill on" onClick={() => void stopShare()}><span class="live-dot" /> Stop streaming</button>}>
          <button class="call-btn on" title="Stop streaming" aria-label="Stop streaming" onClick={() => void stopShare()}><ScreenIcon /></button>
        </Show>
      </Show>
      <Show when={menu()}>
        <Portal>
        <div class="quality-menu" ref={menuEl} role="menu" aria-label="Stream quality" style={at()}>
          <div class="eyebrow">Stream quality</div>
          <For each={Object.keys(QUALITIES) as Quality[]}>
            {(q) => (
              <button role="menuitem" class="quality-opt" classList={{ last: prefs.streamQuality === q }} onClick={() => { setPrefs({ streamQuality: q }); void start(q); }}>
                <span class="quality-name">{QUALITIES[q].label}</span>
              </button>
            )}
          </For>
        </div>
        </Portal>
      </Show>
    </div>
  );
}

/** Your own stream, small, while you share (like before). */
function SharePreview() {
  const [big, setBig] = createSignal(false);
  return (
    <div class="share">
      <div class="share-row">
        <span class="live-badge">LIVE</span>
        <span>You're streaming your screen{screen.sharingAudio ? " and sound" : ""}</span>
        <Show when={s.user}><Viewers userId={s.user!.id} /></Show>
      </div>
      <div class="share-preview" classList={{ big: big() }}>
        <video ref={(el) => attachLocalPreview(el)} autoplay playsinline muted onDblClick={() => setFullscreen(SELF)} />
        <div class="preview-actions">
          <button class="icon-btn" title={big() ? "Smaller preview" : "Bigger preview"} aria-label="Preview size" onClick={() => setBig((v) => !v)}><Show when={big()} fallback={<GrowIcon />}><ShrinkIcon /></Show></button>
          <button class="icon-btn" title="Picture in picture: your stream floats over other windows" aria-label="Picture in picture" onClick={() => void popOut(SELF)}><PipIcon /></button>
          <button class="icon-btn" title="View your screen fullscreen" aria-label="Fullscreen" onClick={() => setFullscreen(SELF)}><FullIcon /></button>
        </div>
      </div>
    </div>
  );
}

/** Voice room header (drawn in the top row): name, plus the fullscreen call view. */
export function StageHeader() {
  const ch = () => currentServer()?.channels.find((c) => c.id === s.stage);
  const connected = () => s.conn.state === "online" && s.voice.channelId === s.stage && s.voice.state === "connected";
  return (
    <>
      <div class="eyebrow">Voice room</div>
      <div class="head-row">
        <FitTitle text={ch()?.name ?? ""} reserve={50} />
        <Show when={connected()}>
          <button class="icon-btn" title="Fullscreen call view: everyone as tiles, or one picture big" aria-label="Open call view" onClick={() => setFullscreen(GRID)}><FullIcon /></button>
        </Show>
      </div>
    </>
  );
}

export default function Stage() {
  const here = createMemo(() => {
    const members = Object.values(s.presence).filter((p) => p.channelId === s.stage).map((p) => p.userId);
    if (s.user && s.voice.channelId === s.stage && !members.includes(s.user.id)) members.unshift(s.user.id);
    return members;
  });
  const joined = () => s.voice.channelId === s.stage;
  const online = () => s.conn.state === "online";
  const connected = () => online() && joined() && s.voice.state === "connected";
  const [joining, setJoining] = createSignal(false);
  const [cameraBusy, setCameraBusy] = createSignal(false);
  const join = async () => {
    if (!s.stage || joining()) return;
    openAudio();
    setJoining(true);
    try {
      if (s.voice.channelId && s.voice.channelId !== s.stage) void disconnectScreens(true);
      await call("voice_join", { channelId: s.stage });
    } catch (e) { mediaErr(e); }
    finally { setJoining(false); }
  };
  const leave = () => { void disconnectScreens(true); void call("voice_leave").catch(mediaErr); };
  const toggleCamera = async () => {
    setCameraBusy(true);
    try { await setCameraEnabled(!screen.cameraOn); }
    catch (e) { mediaErr(e); }
    finally { setCameraBusy(false); }
  };
  const localMedia = () => screen.channelId === s.stage;
  const sharing = (u: string) => s.media.screen[u] === s.stage || (localMedia() &&
    (screen.shares.some((x) => x.userId === u) || (u === s.user?.id && screen.sharing)));
  const camera = (u: string) => s.media.camera[u] === s.stage || (u === s.user?.id && screen.cameraOn);
  const status = (u: string) => {
    const p = u === s.user?.id ? s.voice : s.presence[u];
    return [p?.muted && "Mic off", p?.deafened && "Sound off"].filter(Boolean).join(" · ");
  };

  return (
    <section class="stage">
      <ol class="index people">
        <For each={here()} fallback={<li class="muted lede">Nobody is here yet.</li>}>
          {(id) => (
            <li class="index-row static" classList={{ speaking: s.speaking.includes(id) }}>
              <button class="index-name person" onClick={(e) => openProfile(id, e.currentTarget, e)}>
                <Avatar id={id} size={40} class={s.speaking.includes(id) ? "speaking" : ""} />
                {userName(id)}
                <Show when={s.speaking.includes(id)}><span class="live-dot" /></Show>
                <Show when={camera(id)}><span class="cam-mark" title="Camera on"><CameraIcon /></span></Show>
                <Show when={sharing(id)}><span class="live-badge">LIVE</span><Show when={localMedia() && viewerCount(id)}><Viewers userId={id} /></Show></Show>
              </button>
              <span class="index-meta">
                <Show when={connected() && id !== s.user?.id && sharing(id) && !screen.watching.includes(id)}>
                  <button class="pill" disabled={screen.pending.includes(id)} onClick={() => void watch(id).catch(mediaErr)}>
                    {screen.pending.includes(id) ? "Connecting…" : "Watch"}
                  </button>
                </Show>
                {status(id)}
                <Show when={joined() && id !== s.user?.id}><VolumeSlider userId={id} /></Show>
              </span>
            </li>
          )}
        </For>
      </ol>

      <Show when={joined()}>
        <StreamTiles />
        <Show when={screen.popped && screen.watching.length}>
          <p class="muted small">Playing in the mini player. <button class="link inline" onClick={() => setScreen("popped", false)}>Put it back here</button></p>
        </Show>
        <Show when={screen.sharing}><SharePreview /></Show>
      </Show>

      <div class="stage-actions">
        <Show when={joined()} fallback={
          <button class="pill solid big" onClick={() => void join()} disabled={!online() || joining() || (!!s.voice.channelId && s.voice.state !== "connected" && s.voice.state !== "idle")}>
            {s.voice.channelId ? "Switch to this room" : "Join"}
          </button>
        }>
          <button class="pill big" onClick={leave}>Leave</button>
          <span class="muted">{s.voice.state === "connected" ? "You're live" : s.voice.state === "reconnecting" ? "Reconnecting…" : "Joining…"}</span>
          <span class="stage-media">
            <button class="pill" classList={{ on: screen.cameraOn }} disabled={!connected() || cameraBusy()} onClick={() => void toggleCamera()}>
              <CameraIcon /> {cameraBusy() ? "…" : screen.cameraOn ? "Stop camera" : "Camera"}
            </button>
            <StreamButton disabled={!connected()} />
          </span>
        </Show>
      </div>
    </section>
  );
}
