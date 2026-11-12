// Voice room view: who is here, who is speaking, join / leave.
import { For, Show } from "solid-js";
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

export default function Stage() {
  const ch = () => currentServer()?.channels.find((c) => c.id === s.stage);
  const here = () => Object.values(s.presence).filter((p) => p.channelId === s.stage);
  const joined = () => s.voice.channelId === s.stage;
  const join = () => { openAudio(); return call("voice_join", { channelId: s.stage }); };
  const joinNow = () => join().catch((e) => toast(String(e)));
  const leave = () => call("voice_leave").catch((e) => toast(String(e)));
  return (
    <section class="stage">
      <header class="head">
        <div class="eyebrow">Voice room · {currentServer()?.name}</div>
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
              </span>
              <span class="index-meta">
                {[p.muted && "Mic off", p.deafened && "Sound off"].filter(Boolean).join(" · ")}
                <Show when={joined() && p.userId !== s.user?.id}><VolumeSlider userId={p.userId} /></Show>
              </span>
            </li>
          )}
        </For>
      </ol>
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
