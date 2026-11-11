import { Show, createSignal } from "solid-js";
import { call } from "../ipc";
import { s, toast } from "../store";
import Settings from "./Settings";

export default function VoicePanel() {
  const [settings, setSettings] = createSignal(false);
  const chName = () => s.servers.flatMap((x) => x.channels).find((c) => c.id === s.voice.channelId)?.name;
  const err = (e: unknown) => toast(String(e));
  return (
    <div class="voicepanel">
      <Show when={s.voice.channelId}>
        <div class="vstatus">
          <span class="vdot" classList={{ ok: s.voice.state === "connected", warn: s.voice.state !== "connected" }} />
          <div>
            <div class="vstate">{s.voice.state === "connected" ? "Voice connected" : s.voice.state === "reconnecting" ? "Reconnecting…" : "Connecting…"}</div>
            <div class="muted small">{chName()}</div>
          </div>
          <button class="ghost" title="Leave voice" onClick={() => call("voice_leave").catch(err)}>Leave</button>
        </div>
      </Show>
      <div class="me">
        <div class="mename">
          <span classList={{ speaking: !!s.user && s.speaking.includes(s.user.id) }}>{s.user?.name}</span>
          <span class="conn" classList={{ [s.conn.state]: true }} title={`Chat socket ${s.conn.state}`}>
            {s.conn.state === "online" && s.conn.rttMs != null ? `${s.conn.rttMs.toFixed(0)} ms` : s.conn.state}
          </span>
        </div>
        <button class="icon" classList={{ on: s.voice.muted }} title={s.voice.muted ? "Unmute" : "Mute"} onClick={() => call("voice_mute", { muted: !s.voice.muted }).catch(err)}>
          {s.voice.muted ? "Unmute" : "Mute"}
        </button>
        <button class="icon" classList={{ on: s.voice.deafened }} title={s.voice.deafened ? "Undeafen" : "Deafen"} onClick={() => call("voice_deafen", { deafened: !s.voice.deafened }).catch(err)}>
          {s.voice.deafened ? "Undeafen" : "Deafen"}
        </button>
        <button class="icon" title="Settings" onClick={() => setSettings(true)}>⚙</button>
      </div>
      <Show when={settings()}><Settings close={() => setSettings(false)} /></Show>
    </div>
  );
}
