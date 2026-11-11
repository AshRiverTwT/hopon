// Voice room view: who is here, who is speaking, join / leave.
import { For, Show } from "solid-js";
import { call } from "../ipc";
import { currentServer, s, toast, userName } from "../store";

export default function Stage() {
  const ch = () => currentServer()?.channels.find((c) => c.id === s.stage);
  const here = () => Object.values(s.presence).filter((p) => p.channelId === s.stage);
  const joined = () => s.voice.channelId === s.stage;
  const join = () => call("voice_join", { channelId: s.stage }).catch((e) => toast(String(e)));
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
                <Show when={s.speaking.includes(p.userId)} fallback={<span class="live-dot ghost" />}><span class="live-dot" /></Show>
                {userName(p.userId)}
              </span>
              <span class="index-meta">{[p.muted && "Mic off", p.deafened && "Sound off"].filter(Boolean).join(" · ")}</span>
            </li>
          )}
        </For>
      </ol>
      <div class="stage-actions">
        <Show when={joined()} fallback={
          <button class="pill solid big" onClick={join} disabled={!!s.voice.channelId && s.voice.state !== "connected" && s.voice.state !== "idle"}>
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
