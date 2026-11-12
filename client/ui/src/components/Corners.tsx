import { createSignal, onCleanup, Show } from "solid-js";
import { call } from "../ipc";
import { s, toast } from "../store";
import { Avatar } from "./Avatar";

/** Bottom-left: microphone and sound toggles as stacked text pills. */
export function AudioToggles() {
  const err = (e: unknown) => toast(String(e));
  return (
    <div class="toggles">
      <span class="me">{s.user && <Avatar id={s.user.id} size={30} />}<span class="me-name">{s.user?.name}</span></span>
      <button class="tog" classList={{ off: s.voice.muted }} aria-pressed={!s.voice.muted}
        onClick={() => call("voice_mute", { muted: !s.voice.muted }).catch(err)}>
        {s.voice.muted ? "Mic off" : "Mic on"}
      </button>
      <button class="tog" classList={{ off: s.voice.deafened }} aria-pressed={!s.voice.deafened}
        onClick={() => call("voice_deafen", { deafened: !s.voice.deafened }).catch(err)}>
        {s.voice.deafened ? "Sound off" : "Sound on"}
      </button>
    </div>
  );
}

/** Minute clock: one timer per minute boundary, nothing ticking in between. */
function useClock() {
  const fmt = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const [t, setT] = createSignal(fmt());
  let h = 0;
  const arm = () => { h = window.setTimeout(() => { setT(fmt()); arm(); }, 60_000 - (Date.now() % 60_000) + 50); };
  arm();
  onCleanup(() => clearTimeout(h));
  return t;
}

/** Bottom-right: live status line. */
export function Status(p: { compact?: boolean }) {
  const clock = useClock();
  const voiceName = () => s.servers.flatMap((x) => x.channels).find((c) => c.id === s.voice.channelId)?.name;
  return (
    <div class="status" classList={{ compact: !!p.compact }}>
      <Show when={s.voice.channelId}>
        <span class="status-voice">{s.voice.state === "connected" ? "Live" : s.voice.state === "reconnecting" ? "Reconnecting" : "Joining"} · {voiceName()}</span>
      </Show>
      <span classList={{ warn: s.conn.state !== "online" }}>
        {s.conn.state === "online" ? (s.conn.rttMs != null ? (s.conn.rttMs < 1 ? "<1 ms" : `${s.conn.rttMs.toFixed(0)} ms`) : "Online") : s.conn.state === "connecting" ? "Connecting" : s.conn.state === "incompatible" ? "Update needed" : "Offline"}
      </span>
      <span>{clock()}</span>
      <span class="live-dot" classList={{ idle: !s.voice.channelId && s.conn.state === "online", warn: s.conn.state !== "online" }} />
    </div>
  );
}
