// Screen share. Runs in the webview with LiveKit's JS SDK on its own
// connection ("<user>:screen") to the voice room you're in, so capture,
// hardware encode and decode use the browser engine (GPU H.264). The native
// voice connection subscribes to microphones only, never to screens.
//
// Watching is opt-in per stream (nothing is downloaded until you click Watch).
// The SDK is loaded on first use, so it costs nothing until you're in voice.
import { createStore, produce } from "solid-js/store";
import { call } from "./ipc";
import type { LocalTrack, RemoteTrack, Room } from "livekit-client";

export type Quality = "720p60" | "1080p60";
export const QUALITIES: Record<Quality, { label: string; width: number; height: number; fps: number; bitrate: number }> = {
  "720p60": { label: "720p · 60 fps", width: 1280, height: 720, fps: 60, bitrate: 4_500_000 },
  "1080p60": { label: "1080p · 60 fps", width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};

export interface Share { userId: string; identity: string }

export const [screen, setScreen] = createStore({
  /** voice channel the screen connection is in */
  channelId: null as string | null,
  connected: false,
  sharing: false,
  /** who is sharing right now (not you) */
  shares: [] as Share[],
  /** user ids you're watching */
  watching: [] as string[],
  /** streams that started playing (user id → true) */
  live: {} as Record<string, boolean>,
});

let lk: typeof import("livekit-client") | null = null;
let room: Room | null = null;
let connecting: Promise<void> | null = null;
let local: LocalTrack[] = [];
/** Where each watched stream should play. */
const targets = new Map<string, HTMLVideoElement>();

const userOf = (identity: string) => identity.split(":")[0];

function refresh() {
  if (!room || !lk) return;
  const out: Share[] = [];
  for (const p of room.remoteParticipants.values()) {
    if (p.getTrackPublication(lk.Track.Source.ScreenShare)) out.push({ userId: userOf(p.identity), identity: p.identity });
  }
  setScreen("shares", out);
  // Stop watching streams that ended.
  setScreen("watching", (w) => w.filter((u) => out.some((s) => s.userId === u)));
}

function attach(track: RemoteTrack, identity: string) {
  const user = userOf(identity);
  if (track.kind === "video") {
    const el = targets.get(user);
    if (el) {
      track.attach(el);
      setScreen("live", user, true);
    }
  } else {
    track.attach(); // stream audio plays through its own hidden element
  }
}

/** Join the voice room's screen connection (called when voice connects). */
export async function connectScreens(channelId: string) {
  if (screen.channelId === channelId && (room || connecting)) return connecting ?? undefined;
  await disconnectScreens();
  setScreen("channelId", channelId);
  connecting = (async () => {
    lk ??= await import("livekit-client");
    const [url, token] = await call<[string, string]>("screen_grant", { channelId });
    if (screen.channelId !== channelId) return;
    const r = new lk.Room({ adaptiveStream: true, dynacast: true });
    const E = lk.RoomEvent;
    r.on(E.TrackPublished, refresh).on(E.TrackUnpublished, refresh)
      .on(E.ParticipantConnected, refresh).on(E.ParticipantDisconnected, refresh)
      .on(E.TrackSubscribed, (t, _pub, p) => attach(t, p.identity))
      .on(E.TrackUnsubscribed, (t, _pub, p) => { t.detach(); setScreen("live", produce((l) => void delete l[userOf(p.identity)])); })
      .on(E.LocalTrackUnpublished, () => { if (!local.length) setScreen("sharing", false); })
      .on(E.Disconnected, () => setScreen({ connected: false, sharing: false, shares: [], watching: [], live: {} }));
    await r.connect(url, token, { autoSubscribe: false });
    if (screen.channelId !== channelId) { await r.disconnect(); return; }
    room = r;
    setScreen("connected", true);
    refresh();
  })().finally(() => (connecting = null));
  return connecting;
}

export async function disconnectScreens() {
  await stopShare();
  const r = room;
  room = null;
  targets.clear();
  setScreen({ channelId: null, connected: false, sharing: false, shares: [], watching: [], live: {} });
  await r?.disconnect().catch(() => {});
}

/** Pick a screen/window (the system picker) and stream it. */
export async function startShare(quality: Quality, audio: boolean) {
  if (connecting) await connecting;
  if (!room || !lk) throw new Error("Join voice first");
  const q = QUALITIES[quality];
  const tracks = await room.localParticipant.createScreenTracks({
    audio,
    systemAudio: audio ? "include" : "exclude",
    resolution: { width: q.width, height: q.height, frameRate: q.fps },
    contentHint: "motion", // games and video: keep the frame rate up
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  });
  const enc = { maxBitrate: q.bitrate, maxFramerate: q.fps };
  for (const t of tracks) {
    await room.localParticipant.publishTrack(t, {
      source: t.kind === "video" ? lk.Track.Source.ScreenShare : lk.Track.Source.ScreenShareAudio,
      videoCodec: "h264", // hardware encode on Windows; the SDK falls back if unavailable
      backupCodec: false,
      simulcast: false,
      screenShareEncoding: enc,
      videoEncoding: enc,
      degradationPreference: "maintain-framerate",
    });
    // "Stop sharing" in the system UI ends the track.
    t.mediaStreamTrack.addEventListener("ended", () => void stopShare());
  }
  local = tracks;
  setScreen("sharing", true);
  return tracks.find((t) => t.kind === "video") ?? null;
}

export async function stopShare() {
  const tracks = local;
  local = [];
  for (const t of tracks) {
    await room?.localParticipant.unpublishTrack(t).catch(() => {});
    t.stop();
  }
  setScreen("sharing", false);
}

/** Start playing someone's stream into `el` (subscribes on demand). */
export function watch(userId: string, el: HTMLVideoElement) {
  if (!room || !lk) return;
  const p = [...room.remoteParticipants.values()].find((x) => userOf(x.identity) === userId && x.getTrackPublication(lk!.Track.Source.ScreenShare));
  if (!p) return;
  targets.set(userId, el);
  if (!screen.watching.includes(userId)) setScreen("watching", (w) => [...w, userId]);
  for (const src of [lk.Track.Source.ScreenShare, lk.Track.Source.ScreenShareAudio]) {
    const pub = p.getTrackPublication(src);
    if (!pub) continue;
    pub.setSubscribed(true);
    if (pub.track) attach(pub.track as RemoteTrack, p.identity);
  }
}

export function unwatch(userId: string) {
  if (!room || !lk) return;
  targets.delete(userId);
  setScreen("watching", (w) => w.filter((u) => u !== userId));
  setScreen("live", produce((l) => void delete l[userId]));
  const p = [...room.remoteParticipants.values()].find((x) => userOf(x.identity) === userId);
  for (const src of [lk.Track.Source.ScreenShare, lk.Track.Source.ScreenShareAudio]) p?.getTrackPublication(src)?.setSubscribed(false);
}

/** Your own stream's preview. */
export function attachLocalPreview(el: HTMLVideoElement) {
  const v = local.find((t) => t.kind === "video");
  if (v) { el.srcObject = new MediaStream([v.mediaStreamTrack]); el.muted = true; void el.play().catch(() => {}); }
}

/** Sender stats of your stream (resolution, fps, codec, what limits it). */
export async function shareStats() {
  const v = local.find((t) => t.kind === "video") as (LocalTrack & { getSenderStats?: () => Promise<unknown> }) | undefined;
  return v?.getSenderStats ? await v.getSenderStats() : null;
}
