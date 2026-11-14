// Voice room view: who is here, who is speaking, join / leave.
// Two ways to look at the room: the list (default; names, volume, Watch) and
// tiles (everyone as a picture: their screen, else their camera, else their
// avatar). Controls stay minimal: Leave, Camera, Stream.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { attachLocalPreview, cameraTrack, disconnectScreens, QUALITIES, screen, SELF, setCameraEnabled, setFullscreen, setScreen, setViewingCameras, startShare, stopShare, unwatch, viewerCount, watch, type Quality } from "../screen";
import { StreamTiles, StreamVideo, Viewers } from "./Streams";
import { CameraIcon, FullIcon, ListIcon, MicOffIcon, PipIcon, ScreenIcon, TilesIcon } from "./icons";
import { call } from "../ipc";
import { currentServer, s, toast, userName } from "../store";
import { Avatar } from "./Avatar";
import { openAudio } from "../sounds";
import { prefs, setPrefs } from "../prefs";

/** 0–200 %, remembered per person (follows your account). */
function VolumeSlider(p: { userId: string }) {
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

const err = (e: unknown) => { const m = String(e); if (!/NotAllowed|Permission|denied|AbortError/i.test(m)) toast(m); };

/** Stream button: pick a quality, then it becomes Stop streaming. */
function StreamButton(p: { disabled: boolean }) {
  const [menu, setMenu] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let box!: HTMLDivElement;
  const close = (e: PointerEvent) => { if (!box.contains(e.target as Node)) setMenu(false); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
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
    catch (e) { err(e); }
    finally { setBusy(false); }
  };
  return (
    <div class="stream-btn" ref={box}>
      <Show when={screen.sharing} fallback={
        <button class="pill" aria-haspopup="menu" aria-expanded={menu()} disabled={p.disabled || busy()} onClick={() => setMenu((v) => !v)}>
          <ScreenIcon /> {busy() ? "Starting…" : "Stream"}
        </button>
      }>
        <button class="pill on" onClick={() => void stopShare()}><span class="live-dot" /> Stop streaming</button>
      </Show>
      <Show when={menu()}>
        <div class="quality-menu" role="menu" aria-label="Stream quality">
          <div class="eyebrow">Stream quality</div>
          <For each={Object.keys(QUALITIES) as Quality[]}>
            {(q) => (
              <button role="menuitem" class="quality-opt" classList={{ last: prefs.streamQuality === q }} onClick={() => { setPrefs({ streamQuality: q }); void start(q); }}>
                <span class="quality-name">{QUALITIES[q].label}</span>
                <span class="quality-note">{QUALITIES[q].note}</span>
              </button>
            )}
          </For>
          <p class="quality-foot">Sound is shared too when you pick a whole screen.</p>
        </div>
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
          <button class="icon-btn" title={big() ? "Smaller preview" : "Bigger preview"} aria-label="Preview size" onClick={() => setBig((v) => !v)}><PipIcon /></button>
          <button class="icon-btn" title="View your screen fullscreen" aria-label="Fullscreen" onClick={() => setFullscreen(SELF)}><FullIcon /></button>
        </div>
      </div>
    </div>
  );
}

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

export default function Stage() {
  const ch = () => currentServer()?.channels.find((c) => c.id === s.stage);
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
  const tiles = () => prefs.voiceTiles;
  const join = async () => {
    if (!s.stage || joining()) return;
    openAudio();
    setJoining(true);
    try {
      if (s.voice.channelId && s.voice.channelId !== s.stage) void disconnectScreens(true);
      await call("voice_join", { channelId: s.stage });
    } catch (e) { err(e); }
    finally { setJoining(false); }
  };
  const leave = () => { void disconnectScreens(true); void call("voice_leave").catch(err); };
  const toggleCamera = async () => {
    setCameraBusy(true);
    try { await setCameraEnabled(!screen.cameraOn); }
    catch (e) { err(e); }
    finally { setCameraBusy(false); }
  };
  const localMedia = () => screen.channelId === s.stage;
  const sharing = (u: string) => s.media.screen[u] === s.stage || (localMedia() &&
    (screen.shares.some((x) => x.userId === u) || (u === s.user?.id && screen.sharing)));
  const camera = (u: string) => s.media.camera[u] === s.stage || (u === s.user?.id && screen.cameraOn);

  // Tiles view shows everyone's pictures: subscribe to cameras and watch every
  // screen while it's open, and give back only what the view itself started.
  const autoWatched = new Set<string>();
  createEffect(on(() => [tiles(), connected()] as const, ([t, c]) => {
    if (!c) return;
    if (t) void setViewingCameras(true).catch(() => {});
    else {
      void setViewingCameras(false).catch(() => {});
      for (const u of autoWatched) unwatch(u);
      autoWatched.clear();
    }
  }));
  createEffect(() => {
    if (!tiles() || !connected()) return;
    for (const u of here()) {
      if (u === s.user?.id || !sharing(u) || screen.watching.includes(u) || screen.pending.includes(u) || autoWatched.has(u)) continue;
      autoWatched.add(u);
      void watch(u).catch(() => autoWatched.delete(u));
    }
  });
  onCleanup(() => {
    for (const u of autoWatched) unwatch(u);
    if (screen.viewingCameras) void setViewingCameras(false).catch(() => {});
  });

  const status = (u: string) => {
    const p = u === s.user?.id ? s.voice : s.presence[u];
    return [p?.muted && "Mic off", p?.deafened && "Sound off"].filter(Boolean).join(" · ");
  };

  return (
    <section class="stage">
      <header class="head stage-head">
        <div>
          <div class="eyebrow">Voice room</div>
          <h1 class="display title" title={ch()?.name}>{ch()?.name}</h1>
        </div>
        <div class="view-toggle" role="radiogroup" aria-label="Room view">
          <button role="radio" aria-checked={!tiles()} classList={{ on: !tiles() }} title="List" aria-label="List" onClick={() => setPrefs({ voiceTiles: false })}><ListIcon /></button>
          <button role="radio" aria-checked={tiles()} classList={{ on: tiles() }} title="Tiles: everyone's screen, camera or picture" aria-label="Tiles" onClick={() => setPrefs({ voiceTiles: true })}><TilesIcon /></button>
        </div>
      </header>

      <Show when={!tiles()} fallback={
        <ul class="room-tiles">
          <For each={here()} fallback={<li class="muted lede">Nobody is here yet.</li>}>
            {(id) => {
              const own = () => id === s.user?.id;
              const speaking = () => s.speaking.includes(id);
              const showScreen = () => joined() && (own() ? screen.sharing : screen.watching.includes(id));
              const showCam = () => joined() && localMedia() && camera(id) && !!cameraTrack(id);
              return (
                <li class="room-tile" classList={{ speaking: speaking() }}>
                  <Show when={showScreen()} fallback={
                    <Show when={showCam()} fallback={<div class="room-tile-av"><Avatar id={id} size={72} class={speaking() ? "speaking" : ""} /></div>}>
                      <CameraVideo userId={id} own={own()} />
                    </Show>
                  }>
                    <StreamVideo userId={own() ? SELF : id} onDblClick={() => setFullscreen(own() ? SELF : id)} />
                    <Show when={showCam()}><div class="room-tile-inset"><CameraVideo userId={id} own={own()} /></div></Show>
                  </Show>
                  <div class="room-tile-name">
                    <Show when={status(id)}><span class="room-tile-mic" title={status(id)}><MicOffIcon /></span></Show>
                    <span>{userName(id)}</span>
                    <Show when={sharing(id)}><span class="live-badge">LIVE</span></Show>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      }>
        <ol class="index people">
          <For each={here()} fallback={<li class="muted lede">Nobody is here yet.</li>}>
            {(id) => (
              <li class="index-row static" classList={{ speaking: s.speaking.includes(id) }}>
                <span class="index-name">
                  <Avatar id={id} size={40} class={s.speaking.includes(id) ? "speaking" : ""} />
                  {userName(id)}
                  <Show when={s.speaking.includes(id)}><span class="live-dot" /></Show>
                  <Show when={camera(id)}><span class="cam-mark" title="Camera on"><CameraIcon /></span></Show>
                  <Show when={sharing(id)}><span class="live-badge">LIVE</span><Show when={localMedia() && viewerCount(id)}><Viewers userId={id} /></Show></Show>
                </span>
                <span class="index-meta">
                  <Show when={connected() && id !== s.user?.id && sharing(id) && !screen.watching.includes(id)}>
                    <button class="pill" disabled={screen.pending.includes(id)} onClick={() => void watch(id).catch(err)}>
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
      </Show>

      <Show when={joined()}>
        <Show when={!tiles()}>
          <StreamTiles />
          <Show when={screen.popped && screen.watching.length}>
            <p class="muted small">Playing in the mini player. <button class="link inline" onClick={() => setScreen("popped", false)}>Put it back here</button></p>
          </Show>
        </Show>
        <Show when={screen.sharing && !tiles()}><SharePreview /></Show>
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
