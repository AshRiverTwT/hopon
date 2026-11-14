// Voice room view: who is here, who is speaking, join / leave.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { attachLocalPreview, cameraTrack, disconnectScreens, QUALITIES, screen, SELF, setCameraEnabled, setFullscreen, setLowResourceMode, setScreen, setScreenContext, setViewingCameras, startShare, stopShare, viewerCount, watch, type Quality } from "../screen";
import { StreamTiles, Viewers } from "./Streams";
import { CameraIcon, FullIcon, MicIcon, PipIcon, ScreenIcon, SpeakerIcon, VoiceGlyph } from "./icons";
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

function ShareControls() {
  const [quality, setQuality] = createSignal<Quality>(screen.lowResource ? "720p30" : "1080p60");
  const [audio, setAudio] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [bigPreview, setBigPreview] = createSignal(false);
  const lowResource = () => screen.lowResource;
  let preview: HTMLVideoElement | undefined;
  const start = async () => {
    setBusy(true);
    try {
      await startShare(quality(), audio());
      queueMicrotask(() => preview && attachLocalPreview(preview));
      // Windows only shares sound along with a whole screen, not a window.
      if (audio() && !screen.sharingAudio) toast("Sharing without sound: Windows only includes audio when you share a whole screen.");
    }
    catch (e) { const m = String(e); if (!/NotAllowed|Permission|denied|AbortError/i.test(m)) toast(m); }
    finally { setBusy(false); }
  };
  return (
    <div class="share">
      <Show when={screen.sharing} fallback={
        <div class="share-row">
          <button class="pill" disabled={busy()} onClick={start}><ScreenIcon /> {busy() ? "Starting…" : "Share screen"}</button>
          <div class="seg" role="radiogroup" aria-label="Quality">
            <For each={Object.keys(QUALITIES) as Quality[]}>
              {(q) => <button role="radio" aria-checked={quality() === q} classList={{ on: quality() === q }} onClick={() => setQuality(q)}>{QUALITIES[q].label}</button>}
            </For>
          </div>
          <label class="check" title="Shares your computer's sound too. Voice chat may echo for viewers on speakers.">
            <input type="checkbox" checked={audio()} onChange={(e) => setAudio(e.currentTarget.checked)} /> Include audio <span class="muted small">(whole screen only)</span>
          </label>
          <label class="check" title="Use 720p30 and watch one screen stream at a time.">
            <input type="checkbox" checked={lowResource()} onChange={(e) => {
              setLowResourceMode(e.currentTarget.checked);
              if (e.currentTarget.checked) setQuality("720p30");
            }} /> Low resource
          </label>
        </div>
      }>
        <div class="share-row">
          <span class="live-badge">LIVE</span>
          <span>You're sharing your screen{screen.sharingAudio ? " and sound" : ""}</span>
          <Show when={s.user}><Viewers userId={s.user!.id} /></Show>
          <button class="pill" onClick={() => stopShare()}>Stop sharing</button>
        </div>
        <div class="share-preview" classList={{ big: bigPreview() }}>
          <video ref={(el) => { preview = el; attachLocalPreview(el); }} autoplay playsinline muted onDblClick={() => setFullscreen(SELF)} />
          <div class="preview-actions">
            <button class="icon-btn" title={bigPreview() ? "Smaller preview" : "Bigger preview"} aria-label="Preview size" onClick={() => setBigPreview((v) => !v)}><PipIcon /></button>
            <button class="icon-btn" title="View your screen fullscreen" aria-label="Fullscreen" onClick={() => setFullscreen(SELF)}><FullIcon /></button>
          </div>
        </div>
      </Show>
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
  const [viewBusy, setViewBusy] = createSignal(false);
  const err = (e: unknown) => toast(String(e));
  const join = async (video: boolean) => {
    const channelId = s.stage;
    const userId = s.user?.id;
    if (!channelId || !userId || joining()) return;
    openAudio();
    setJoining(true);
    try {
      if (s.voice.channelId && s.voice.channelId !== channelId) void disconnectScreens(true);
      await call("voice_join", { channelId });
      if (video && online() && s.user?.id === userId) {
        setScreenContext(channelId, userId);
        await setCameraEnabled(true);
        if (screen.cameraOn) await setViewingCameras(true);
      }
    } catch (error) { err(error); }
    finally { setJoining(false); }
  };
  const toggleCamera = async () => {
    setCameraBusy(true);
    try {
      const enable = !screen.cameraOn;
      await setCameraEnabled(enable);
      if (enable && screen.cameraOn && !screen.viewingCameras) await setViewingCameras(true);
    } catch (error) { err(error); }
    finally { setCameraBusy(false); }
  };
  const toggleViewing = async () => {
    setViewBusy(true);
    try { await setViewingCameras(!screen.viewingCameras); }
    catch (error) { err(error); }
    finally { setViewBusy(false); }
  };
  const localMedia = () => screen.channelId === s.stage;
  const sharing = (u: string) => s.media.screen[u] === s.stage || (localMedia() &&
    (screen.shares.some((x) => x.userId === u) || (u === s.user?.id && screen.sharing)));
  return (
    <section class="stage">
      <header class="head stage-head">
        <div>
          <div class="eyebrow"><VoiceGlyph /> Voice room</div>
          <h1 class="display title" title={ch()?.name}>{ch()?.name}</h1>
          <Show when={ch()?.topic}><p class="muted stage-topic">{ch()?.topic}</p></Show>
        </div>
        <span class="stage-status" classList={{ connected: connected() }} aria-live="polite">
          <span class="stage-status-dot" />
          {connected() ? "Connected" : joined() && s.voice.state === "reconnecting" ? "Reconnecting…" : joining() || joined() ? "Joining…" : `${here().length} in room`}
        </span>
      </header>
      <div class="stage-actions" role="group" aria-label="Call controls">
        <Show when={joined()} fallback={<>
          <button class="pill solid" onClick={() => void join(false)} disabled={!online() || joining()}>{s.voice.channelId ? "Switch room" : "Join voice"}</button>
          <button class="pill" onClick={() => void join(true)} disabled={!online() || joining()}><CameraIcon /> Join with camera</button>
        </>}>
          <button class="pill" aria-pressed={!s.voice.muted} onClick={() => call("voice_mute", { muted: !s.voice.muted }).catch(err)}><MicIcon /> {s.voice.muted ? "Mic off" : "Mic on"}</button>
          <button class="pill" aria-pressed={!s.voice.deafened} onClick={() => call("voice_deafen", { deafened: !s.voice.deafened }).catch(err)}><SpeakerIcon /> {s.voice.deafened ? "Sound off" : "Sound on"}</button>
          <button class="pill" aria-pressed={screen.cameraOn} disabled={!connected() || cameraBusy() || joining()} onClick={() => void toggleCamera()}><CameraIcon /> {cameraBusy() ? "Working…" : screen.cameraOn ? "Turn camera off" : "Turn camera on"}</button>
          <button class="pill" aria-pressed={screen.viewingCameras} disabled={!connected() || viewBusy() || joining()} onClick={() => void toggleViewing()}>{screen.viewingCameras ? "Hide cameras" : "Show cameras"}</button>
          <button class="pill danger stage-leave" disabled={s.voice.state === "connecting"} onClick={() => {
            void disconnectScreens(true);
            void call("voice_leave").catch(err);
          }}>Leave call</button>
        </Show>
      </div>
      <Show when={joined()}>
        <StreamTiles />
        <Show when={screen.popped && screen.watching.length}>
          <p class="muted small">Playing in the mini player. <button class="link inline" onClick={() => setScreen("popped", false)}>Put it back here</button></p>
        </Show>
        <Show when={connected()}><ShareControls /></Show>
      </Show>
      <section class="stage-participants" aria-label="Participants">
        <h2>Participants <span class="muted">{here().length}</span></h2>
        <ul class="stage-grid">
        <For each={here()} fallback={<li class="stage-empty muted">Nobody is here yet.</li>}>
          {(id) => {
            const own = () => id === s.user?.id;
            const presence = () => own() ? s.voice : s.presence[id];
            const speaking = () => s.speaking.includes(id);
            const camera = () => s.media.camera[id] === s.stage || (own() && localMedia() && screen.cameraOn);
            return <li class="stage-person" classList={{ speaking: speaking() }}>
              <div class="stage-video">
                <Show when={joined() && localMedia() && cameraTrack(id)} fallback={<Avatar id={id} size={54} class={speaking() ? "speaking" : ""} />}>
                  <CameraVideo userId={id} own={own()} />
                </Show>
                <Show when={camera()}><span class="stage-video-badge"><CameraIcon /> Camera on</span></Show>
              </div>
              <div class="stage-person-info">
                <div class="stage-person-name">
                  <strong title={userName(id)}>{userName(id)}</strong>
                  <Show when={own()}><span class="muted small">You</span></Show>
                  <Show when={sharing(id)}><span class="live-badge">Sharing</span><Show when={localMedia() && viewerCount(id)}><Viewers userId={id} /></Show></Show>
                </div>
                <span class="muted small">{[presence()?.muted && "Mic off", presence()?.deafened && "Sound off", speaking() && "Speaking"].filter(Boolean).join(" · ")}</span>
                <Show when={joined() && !own()}>
                  <div class="stage-person-actions">
                    <VolumeSlider userId={id} />
                    <Show when={connected() && sharing(id) && !screen.watching.includes(id)}><button class="pill" onClick={() => void watch(id).catch(err)}>Watch screen</button></Show>
                  </div>
                </Show>
              </div>
            </li>;
          }}
        </For>
        </ul>
      </section>
    </section>
  );
}
