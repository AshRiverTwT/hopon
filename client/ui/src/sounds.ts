// Join/leave chimes, synthesized (no audio files). The AudioContext exists
// only while you are in a voice room: an open context keeps an audio thread
// alive, which would break the idle-CPU budget.

let ctx: AudioContext | null = null;
let closeTimer = 0;

import { prefs } from "./prefs";

export const soundsEnabled = () => prefs.sounds;

/** Call from the click that joins voice (satisfies autoplay rules). */
export function openAudio() {
  clearTimeout(closeTimer);
  if (!ctx || ctx.state === "closed") ctx = new AudioContext({ latencyHint: "interactive" });
  else if (ctx.state === "suspended") ctx.resume();
}

/** Close shortly after the last chime has finished. */
export function closeAudio(afterMs = 600) {
  clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => { ctx?.close(); ctx = null; }, afterMs);
}

function tone(freq: number, start: number, dur: number, gain: number) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export function chime(kind: "join" | "leave", muted: boolean) {
  if (!ctx || muted || !soundsEnabled()) return;
  if (kind === "join") { tone(659.3, 0, 0.16, 0.12); tone(987.8, 0.085, 0.22, 0.10); }
  else { tone(987.8, 0, 0.16, 0.10); tone(587.3, 0.085, 0.24, 0.10); }
}
