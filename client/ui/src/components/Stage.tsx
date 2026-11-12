// Voice room view: who is here, who is speaking, join / leave.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { attachLocalPreview, QUALITIES, screen, setScreen, startShare, stopShare, unwatch, watch, type Quality } from "../screen";
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

/** One stream you're watching (big, with fullscreen). */
function StreamTile(p: { userId: string }) {
  let v!: HTMLVideoElement;
  onMount(() => watch(p.userId, v));
  onCleanup(() => unwatch(p.userId));
  return (
    <figure class="stream">
      <video ref={v} autoplay playsinline />
      <Show when={!screen.live[p.userId]}><div class="stream-wait muted">Connecting to {userName(p.userId)}'s stream…</div></Show>
      <figcaption>
        <span class="live-badge">LIVE</span> {userName(p.userId)}
        <span class="stream-actions">
          <button class="link" onClick={() => v.requestFullscreen?.().catch(() => {})}>Fullscreen</button>
          <button class="link" onClick={() => unwatch(p.userId)}>Stop watching</button>
        </span>
      </figcaption>
    </figure>
  );
}

function ShareControls() {
  const [quality, setQuality] = createSignal<Quality>("1080p60");
  const [audio, setAudio] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let preview: HTMLVideoElement | undefined;
  const start = async () => {
    setBusy(true);
    try { await startShare(quality(), audio()); queueMicrotask(() => preview && attachLocalPreview(preview)); }
    catch (e) { const m = String(e); if (!/NotAllowed|Permission|denied|AbortError/i.test(m)) toast(m); }
    finally { setBusy(false); }
  };
  return (
    <div class="share">
      <Show when={screen.sharing} fallback={
        <div class="share-row">
          <button class="pill solid" disabled={busy() || !screen.connected} onClick={start}>{screen.connected ? "Share screen" : "Connecting…"}</button>
          <div class="seg" role="radiogroup" aria-label="Quality">
            <For each={Object.keys(QUALITIES) as Quality[]}>
              {(q) => <button role="radio" aria-checked={quality() === q} classList={{ on: quality() === q }} onClick={() => setQuality(q)}>{QUALITIES[q].label}</button>}
            </For>
          </div>
          <label class="check" title="Shares your computer's sound too. Voice chat may echo for viewers on speakers.">
            <input type="checkbox" checked={audio()} onChange={(e) => setAudio(e.currentTarget.checked)} /> Include audio
          </label>
        </div>
      }>
        <div class="share-row">
          <span class="live-badge">LIVE</span>
          <span>You're sharing your screen</span>
          <button class="pill" onClick={() => stopShare()}>Stop sharing</button>
        </div>
        <video class="share-preview" ref={(el) => { preview = el; attachLocalPreview(el); }} autoplay playsinline muted />
      </Show>
    </div>
  );
}

export default function Stage() {
  const ch = () => currentServer()?.channels.find((c) => c.id === s.stage);
  const here = () => Object.values(s.presence).filter((p) => p.channelId === s.stage);
  const joined = () => s.voice.channelId === s.stage;
  const join = () => { openAudio(); return call("voice_join", { channelId: s.stage }); };
  const joinNow = () => join().catch((e) => toast(String(e)));
  const leave = () => call("voice_leave").catch((e) => toast(String(e)));
  // Adds a tile; the tile itself subscribes when it mounts.
  const setWatching = (u: string) => setScreen("watching", (w) => (w.includes(u) ? w : [...w, u]));
  return (
    <section class="stage">
      <header class="head">
        <div class="eyebrow">Voice room</div>
        <h1 class="display title" title={ch()?.name}>{ch()?.name}</h1>
      </header>
      <ol class="index people">
        <For each={here()} fallback={<li class="muted lede">Nobody is here yet.</li>}>
          {(p) => (
            <li class="index-row static" classList={{ speaking: s.speaking.includes(p.userId) }}>
              <span class="index-name">
                <Avatar id={p.userId} size={40} class={s.speaking.includes(p.userId) ? "speaking" : ""} />
                {userName(p.userId)}
                <Show when={s.speaking.includes(p.userId)}><span class="live-dot" /></Show>
                <Show when={screen.shares.some((x) => x.userId === p.userId) || (p.userId === s.user?.id && screen.sharing)}><span class="live-badge">LIVE</span></Show>
              </span>
              <span class="index-meta">
                <Show when={joined() && screen.shares.some((x) => x.userId === p.userId) && !screen.watching.includes(p.userId)}>
                  <button class="pill" onClick={() => setWatching(p.userId)}>Watch</button>
                </Show>
                {[p.muted && "Mic off", p.deafened && "Sound off"].filter(Boolean).join(" · ")}
                <Show when={joined() && p.userId !== s.user?.id}><VolumeSlider userId={p.userId} /></Show>
              </span>
            </li>
          )}
        </For>
      </ol>
      <Show when={joined()}>
        <For each={screen.watching}>{(u) => <StreamTile userId={u} />}</For>
        <ShareControls />
      </Show>
      <div class="stage-actions">
        <Show when={joined()} fallback={
          <button class="pill solid big" onClick={joinNow} disabled={!!s.voice.channelId && s.voice.state !== "connected" && s.voice.state !== "idle"}>
            {s.voice.channelId ? "Switch to this room" : "Join"}
          </button>
        }>
          <button class="pill big" onClick={leave}>Leave</button>
          <span class="muted">{s.voice.state === "connected" ? "You're live" : s.voice.state === "reconnecting" ? "Reconnecting…" : "Joining…"}</span>
        </Show>
      </div>
    </section>
  );
}
