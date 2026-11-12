// Screen share. Runs in the webview with LiveKit's JS SDK on its own
// connection ("<user>:screen") to the voice room you're in, so capture,
// hardware encode and decode use the browser engine (GPU H.264). The native
// voice connection subscribes to microphones only, never to screens.
//
// Watching is opt-in per stream (nothing is downloaded until you click Watch)
// and is independent of what's on screen: the voice room tile, the floating
// mini player and fullscreen are all just views that bind a <video> to a
// stream you're already watching. Leaving the room view never drops the
// stream, so coming back shows the picture straight away.
//
// The SDK is loaded on first use, so it costs nothing until you're in voice.
import { createStore, produce } from "solid-js/store";
import { call } from "./ipc";
import { prefs, setPrefs } from "./prefs";
import type { LocalTrack, RemoteAudioTrack, RemoteTrack, Room } from "livekit-client";

export type Quality = "720p60" | "1080p60";
export const QUALITIES: Record<Quality, { label: string; width: number; height: number; fps: number; bitrate: number }> = {
  "720p60": { label: "720p · 60 fps", width: 1280, height: 720, fps: 60, bitrate: 4_500_000 },
  "1080p60": { label: "1080p · 60 fps", width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};

/** Stream audio: stereo Opus at a music bitrate (the default is ~32 kb/s speech). */
const AUDIO_BITRATE = 192_000;

/** Your own stream, in places that take a user id (fullscreen). */
export const SELF = "self";

export interface Share { userId: string; identity: string; hasAudio: boolean }

export const [screen, setScreen] = createStore({
  /** voice channel the screen connection is in */
  channelId: null as string | null,
  connected: false,
  sharing: false,
  /** your stream includes computer sound */
  sharingAudio: false,
  /** who is sharing right now (not you) */
  shares: [] as Share[],
  /** user ids you're watching */
  watching: [] as string[],
  /** streams whose video has arrived (user id → true) */
  live: {} as Record<string, boolean>,
  /** sharer's user id → user ids watching them (you included) */
  viewers: {} as Record<string, string[]>,
  /** user id (or SELF) shown fullscreen */
  full: null as string | null,
  /** the floating mini player was opened by hand (shows even in the voice room) */
  popped: false,
});

let lk: typeof import("livekit-client") | null = null;
let room: Room | null = null;
let connecting: Promise<void> | null = null;
let local: LocalTrack[] = [];
let myUser = "";
/** Video elements showing each watched stream (several views may bind at once). */
const views = new Map<string, Set<HTMLVideoElement>>();
const audios = new Map<string, RemoteAudioTrack>();

const userOf = (identity: string) => identity.split(":")[0];

export const viewerCount = (userId: string) => (screen.viewers[userId] ?? []).length;
export const streamVolume = (userId: string) => prefs.streamVolumes[userId] ?? 100;

function refresh() {
  if (!room || !lk) return;
  const out: Share[] = [];
  for (const p of room.remoteParticipants.values()) {
    if (p.getTrackPublication(lk.Track.Source.ScreenShare)) {
      out.push({ userId: userOf(p.identity), identity: p.identity, hasAudio: !!p.getTrackPublication(lk.Track.Source.ScreenShareAudio) });
    }
  }
  setScreen("shares", out);
  // Stop watching streams that ended.
  const ended = screen.watching.filter((u) => !out.some((s) => s.userId === u));
  for (const u of ended) dropViews(u);
  if (ended.length) {
    setScreen("watching", (w) => w.filter((u) => !ended.includes(u)));
    publishWatching();
  }
  if (screen.full && screen.full !== SELF && !out.some((s) => s.userId === screen.full)) setFullscreen(null);
  if (!screen.watching.length && screen.popped) setScreen("popped", false);
  recountViewers();
}

/** Viewers announce what they watch as a participant attribute; count them per stream. */
function recountViewers() {
  if (!room) return;
  const v: Record<string, string[]> = {};
  const add = (sharer: string, viewer: string) => (v[sharer] ??= []).includes(viewer) || v[sharer].push(viewer);
  for (const p of room.remoteParticipants.values()) {
    for (const u of (p.attributes?.watching ?? "").split(",").filter(Boolean)) add(u, userOf(p.identity));
  }
  for (const u of screen.watching) add(u, myUser);
  setScreen("viewers", v);
}

function publishWatching() {
  recountViewers();
  room?.localParticipant.setAttributes({ watching: screen.watching.join(",") }).catch(() => {
    // Older servers don't let screen connections set attributes: no counts, nothing else breaks.
  });
}

function attach(track: RemoteTrack, identity: string) {
  const user = userOf(identity);
  if (track.kind === "video") {
    for (const el of views.get(user) ?? []) track.attach(el);
    setScreen("live", user, true);
  } else {
    track.attach(); // stream audio plays through its own hidden element
    const a = track as RemoteAudioTrack;
    audios.set(user, a);
    a.setVolume(streamVolume(user) / 100);
  }
}

function dropViews(userId: string) {
  views.delete(userId);
  audios.delete(userId);
  setScreen("live", produce((l) => void delete l[userId]));
}

/** Join the voice room's screen connection (called when voice connects). */
export async function connectScreens(channelId: string, me: string) {
  myUser = me;
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
      .on(E.ParticipantAttributesChanged, recountViewers)
      .on(E.TrackSubscribed, (t, _pub, p) => attach(t, p.identity))
      .on(E.TrackUnsubscribed, (t, _pub, p) => {
        t.detach();
        const u = userOf(p.identity);
        if (t.kind === "video") setScreen("live", produce((l) => void delete l[u]));
        else audios.delete(u);
      })
      .on(E.LocalTrackUnpublished, () => { if (!local.length) setScreen({ sharing: false, sharingAudio: false }); })
      .on(E.Disconnected, () => {
        views.clear();
        audios.clear();
        if (screen.full) setFullscreen(null);
        setScreen({ connected: false, sharing: false, sharingAudio: false, shares: [], watching: [], live: {}, viewers: {}, popped: false });
      });
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
  views.clear();
  audios.clear();
  if (screen.full) setFullscreen(null);
  setScreen({ channelId: null, connected: false, sharing: false, sharingAudio: false, shares: [], watching: [], live: {}, viewers: {}, popped: false });
  await r?.disconnect().catch(() => {});
}

/** Pick a screen/window (the system picker) and stream it. */
export async function startShare(quality: Quality, audio: boolean) {
  if (connecting) await connecting;
  if (!room || !lk) throw new Error("Join voice first");
  const q = QUALITIES[quality];
  const tracks = await room.localParticipant.createScreenTracks({
    // Computer sound as-is: no voice processing (it would duck and smear
    // music and game audio), stereo at 48 kHz.
    audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 } : false,
    systemAudio: audio ? "include" : "exclude",
    resolution: { width: q.width, height: q.height, frameRate: q.fps },
    contentHint: "motion", // games and video: keep the frame rate up
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  });
  const enc = { maxBitrate: q.bitrate, maxFramerate: q.fps };
  for (const t of tracks) {
    if (t.kind === "video") {
      await room.localParticipant.publishTrack(t, {
        source: lk.Track.Source.ScreenShare,
        videoCodec: "h264", // hardware encode on Windows; the SDK falls back if unavailable
        backupCodec: false,
        simulcast: false,
        screenShareEncoding: enc,
        videoEncoding: enc,
        degradationPreference: "maintain-framerate",
      });
    } else {
      // Music, not speech: high bitrate, stereo, no DTX (it gates quiet
      // passages), no RED (doubles the bitrate for loss recovery we don't need).
      t.mediaStreamTrack.contentHint = "music";
      await room.localParticipant.publishTrack(t, {
        source: lk.Track.Source.ScreenShareAudio,
        audioPreset: { maxBitrate: AUDIO_BITRATE },
        forceStereo: true,
        dtx: false,
        red: false,
      });
    }
    // "Stop sharing" in the system UI ends the track.
    t.mediaStreamTrack.addEventListener("ended", () => void stopShare());
  }
  local = tracks;
  setScreen({ sharing: true, sharingAudio: tracks.some((t) => t.kind === "audio") });
  return tracks.find((t) => t.kind === "video") ?? null;
}

export async function stopShare() {
  const tracks = local;
  local = [];
  for (const t of tracks) {
    await room?.localParticipant.unpublishTrack(t).catch(() => {});
    t.stop();
  }
  if (screen.full === SELF) setFullscreen(null);
  setScreen({ sharing: false, sharingAudio: false });
}

/** Start watching someone's stream (subscribes; views bind with bindVideo). */
export function watch(userId: string) {
  if (!room || !lk) return;
  const p = [...room.remoteParticipants.values()].find((x) => userOf(x.identity) === userId && x.getTrackPublication(lk!.Track.Source.ScreenShare));
  if (!p) return;
  if (!screen.watching.includes(userId)) {
    setScreen("watching", (w) => [...w, userId]);
    publishWatching();
  }
  for (const src of [lk.Track.Source.ScreenShare, lk.Track.Source.ScreenShareAudio]) {
    const pub = p.getTrackPublication(src);
    if (!pub) continue;
    pub.setSubscribed(true);
    if (pub.track) attach(pub.track as RemoteTrack, p.identity);
  }
}

export function unwatch(userId: string) {
  if (screen.full === userId) setFullscreen(null);
  dropViews(userId);
  setScreen("watching", (w) => w.filter((u) => u !== userId));
  if (!screen.watching.length) setScreen("popped", false);
  publishWatching();
  if (!room || !lk) return;
  const p = [...room.remoteParticipants.values()].find((x) => userOf(x.identity) === userId);
  for (const src of [lk.Track.Source.ScreenShare, lk.Track.Source.ScreenShareAudio]) {
    const pub = p?.getTrackPublication(src);
    pub?.track?.detach();
    pub?.setSubscribed(false);
  }
}

function videoTrackOf(userId: string) {
  if (!room || !lk) return null;
  const p = [...room.remoteParticipants.values()].find((x) => userOf(x.identity) === userId);
  return p?.getTrackPublication(lk.Track.Source.ScreenShare)?.track ?? null;
}

/** A view (tile, mini player, fullscreen) shows a watched stream in `el`. */
export function bindVideo(userId: string, el: HTMLVideoElement) {
  if (userId === SELF) return attachLocalPreview(el);
  let set = views.get(userId);
  if (!set) views.set(userId, (set = new Set()));
  set.add(el);
  videoTrackOf(userId)?.attach(el);
}

export function unbindVideo(userId: string, el: HTMLVideoElement) {
  if (userId === SELF) { el.srcObject = null; return; }
  views.get(userId)?.delete(el);
  videoTrackOf(userId)?.detach(el);
}

/** Stream sound, 0–100 %, remembered per person. */
export function setStreamVolume(userId: string, pct: number) {
  setPrefs({ streamVolumes: { ...prefs.streamVolumes, [userId]: pct } });
  audios.get(userId)?.setVolume(pct / 100);
}

/** Fullscreen a stream: the window goes fullscreen with the stream filling it. */
export function setFullscreen(userId: string | null) {
  const was = screen.full;
  setScreen("full", userId);
  if (!!was !== !!userId) call("set_fullscreen", { on: !!userId }).catch(() => {});
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
