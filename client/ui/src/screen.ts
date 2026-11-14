// Camera and screen sharing run in the webview with LiveKit's JS SDK on their own
// connection ("<user>:screen") to the voice room you're in, so capture,
// hardware encode and decode use the browser engine (GPU H.264). The native
// voice connection subscribes to microphones only, never to screens.
//
// Watching is opt-in per stream (nothing is downloaded until you click Watch)
// and is independent of what's on screen: the voice room tile, the floating
// mini player and fullscreen are all just slots. Each watched stream has ONE
// <video> element that moves into whichever slot is on top. A new element
// would stay black until the sharer's screen changes (a still desktop sends
// no new frames); moving the same element keeps the picture it has.
//
// The SDK is loaded on the first video action.
import { createStore, produce } from "solid-js/store";
import { createSignal } from "solid-js";
import { call } from "./ipc";
import { prefs, setPrefs } from "./prefs";
import type { MediaSource } from "./types";
import type { LocalTrack, LocalVideoTrack, RemoteAudioTrack, RemoteTrack, RemoteVideoTrack, Room } from "livekit-client";

export type Quality = "720p30" | "720p60" | "1080p60";
export const QUALITIES: Record<Quality, { label: string; width: number; height: number; fps: number; bitrate: number }> = {
  "720p30": { label: "720p · 30 fps · Low resource", width: 1280, height: 720, fps: 30, bitrate: 2_000_000 },
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
  cameraOn: false,
  viewingCameras: false,
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
  /** Prefer 720p30 sharing and keep only one remote stream subscribed. */
  lowResource: (() => { try { return localStorage.getItem("hopon.lowResource") === "1"; } catch { return false; } })(),
});

let lk: typeof import("livekit-client") | null = null;
let room: Room | null = null;
let connecting: Promise<Room | null> | null = null;
let closing = Promise.resolve();
let local: LocalTrack[] = [];
let camera: LocalVideoTrack | null = null;
let shareStarting: number | null = null;
let cameraStarting: number | null = null;
let watchRequests = 0;
let generation = 0;
let myUser = "";
let voiceChannel: string | null = null;
/** The one <video> per watched stream, and the slots that want it (last = on top). */
const players = new Map<string, HTMLVideoElement>();
const slots = new Map<string, HTMLElement[]>();
/** Hidden parking spot while no slot shows a stream: still in the document
 * (so it isn't paused and keeps its picture), not visible (so adaptive stream
 * pauses the download). */
let park: HTMLDivElement | null = null;
/** Channel connectScreens is (being) connected to; set synchronously so
 * overlapping calls don't open duplicate connections. */
let target: string | null = null;
const audios = new Map<string, RemoteAudioTrack>();
/** The screen participant, rather than the same user's separate voice participant. */
const watchedParticipants = new Map<string, string>();
type CameraTrack = LocalVideoTrack | RemoteVideoTrack;
const [cameraTracks, setCameraTracks] = createSignal<Record<string, CameraTrack>>({});

export const cameraTrack = (userId: string) => cameraTracks()[userId];

function showCamera(userId: string, track: CameraTrack) {
  if (cameraTrack(userId) === track) return;
  setCameraTracks((tracks) => ({ ...tracks, [userId]: track }));
}

function hideCamera(userId: string, track?: RemoteTrack) {
  const current = cameraTrack(userId);
  if (!current || (track && current !== track)) return;
  setCameraTracks(({ [userId]: _removed, ...tracks }) => tracks);
}

function advertise(channelId: string, source: MediaSource, active: boolean) {
  return call("media_presence", { channelId, source, active });
}

function disconnectIfIdle() {
  if (room && !local.length && !camera && !screen.viewingCameras && !screen.watching.length
      && shareStarting === null && cameraStarting === null && !watchRequests) {
    void disconnectScreens();
  }
}

const userOf = (identity: string) => identity.split(":")[0];

export const viewerCount = (userId: string) => (screen.viewers[userId] ?? []).length;
export const streamVolume = (userId: string) => prefs.streamVolumes[userId] ?? 100;

export function setLowResourceMode(enabled: boolean) {
  setScreen("lowResource", enabled);
  try { localStorage.setItem("hopon.lowResource", enabled ? "1" : "0"); } catch {}
  if (enabled) for (const user of [...screen.watching].slice(1)) unwatch(user);
}

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
  for (const u of ended) {
    watchedParticipants.delete(u);
    dropViews(u);
  }
  if (ended.length) {
    setScreen("watching", (w) => w.filter((u) => !ended.includes(u)));
    publishWatching();
  }
  if (screen.full && screen.full !== SELF && !out.some((s) => s.userId === screen.full)) setFullscreen(null);
  if (!screen.watching.length && screen.popped) setScreen("popped", false);
  recountViewers();
  if (ended.length) disconnectIfIdle();
}

function updateCameraSubscriptions() {
  if (!room || !lk) return;
  for (const participant of room.remoteParticipants.values()) {
    const publication = participant.getTrackPublication(lk.Track.Source.Camera);
    if (!publication) continue;
    if (publication.isDesired !== screen.viewingCameras) publication.setSubscribed(screen.viewingCameras);
    const userId = userOf(participant.identity);
    if (screen.viewingCameras && publication.track instanceof lk.RemoteVideoTrack) showCamera(userId, publication.track);
    else hideCamera(userId);
  }
}

// Capture is only restarted by an explicit user action. Presence is refreshed
// by the media session if LiveKit reconnects while the chat socket stays up.
function refreshLocalMedia(channelId: string) {
  if (screen.sharing) void advertise(channelId, "screen", true).catch(() => {});
  if (screen.cameraOn) void advertise(channelId, "camera", true).catch(() => {});
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

function playerFor(userId: string) {
  let el = players.get(userId);
  if (!el) {
    el = document.createElement("video");
    el.autoplay = true;
    el.playsInline = true;
    el.muted = true; // stream sound plays through its own element (volume control)
    players.set(userId, el);
    place(userId);
  }
  return el;
}

/** Put the stream's <video> in its top slot, or park it. */
function place(userId: string) {
  const el = players.get(userId);
  if (!el) return;
  const top = slots.get(userId)?.at(-1);
  if (!park) {
    park = document.createElement("div");
    park.style.display = "none";
    document.body.appendChild(park);
  }
  const into = top ?? park;
  if (el.parentElement !== into) into.appendChild(el);
  if (el.paused && el.srcObject) void el.play().catch(() => {});
}

function attach(track: RemoteTrack, identity: string) {
  const user = userOf(identity);
  // Stop Watching may race with a subscription already in flight.
  if (watchedParticipants.get(user) !== identity) { detachTrack(track); return; }
  if (track.kind === "video") {
    if (!screen.watching.includes(user)) return;
    track.attach(playerFor(user));
    place(user);
    setScreen("live", user, true);
  } else {
    track.attach(); // stream audio plays through its own hidden element
    const a = track as RemoteAudioTrack;
    audios.set(user, a);
    a.setVolume(streamVolume(user) / 100);
  }
}

function detachTrack(track: RemoteTrack) {
  for (const element of track.detach()) {
    element.pause();
    element.srcObject = null;
    if (track.kind === "audio") element.remove();
  }
}

function dropViews(userId: string) {
  const el = players.get(userId);
  if (el) { el.srcObject = null; el.remove(); }
  players.delete(userId);
  const audio = audios.get(userId);
  if (audio) detachTrack(audio);
  audios.delete(userId);
  setScreen("live", produce((l) => void delete l[userId]));
}

/** Track voice context without opening the optional screen-media connection. */
export function setScreenContext(channelId: string, me: string) {
  if (voiceChannel !== null && (voiceChannel !== channelId || myUser !== me)) void disconnectScreens();
  voiceChannel = channelId;
  myUser = me;
}

/** Voice alone doesn't open a second connection. */
async function connectScreens(channelId: string) {
  if (target === channelId) return connecting ?? room;
  target = channelId;
  const request = generation;
  const current = () => request === generation && target === channelId;
  const job = (async () => {
    let connected: Room | undefined;
    try {
      await closing;
      if (!current()) return null;
      const sdk = lk ??= await import("livekit-client");
      const [url, token] = await call<[string, string]>("screen_grant", { channelId });
      if (!current()) return null;
      const r = connected = new sdk.Room({ adaptiveStream: true, dynacast: true });
      const E = sdk.RoomEvent;
      const changed = () => {
        if (room !== r) return;
        refresh();
        updateCameraSubscriptions();
      };
      r.on(E.TrackPublished, changed).on(E.TrackUnpublished, (pub, participant) => {
        if (room !== r) return;
        if (pub.source === sdk.Track.Source.Camera) hideCamera(userOf(participant.identity));
        changed();
      }).on(E.ParticipantConnected, changed).on(E.ParticipantDisconnected, (participant) => {
        if (room !== r) return;
        hideCamera(userOf(participant.identity));
        changed();
      }).on(E.ParticipantAttributesChanged, () => { if (room === r) recountViewers(); })
        .on(E.Reconnected, () => { if (room === r) { changed(); refreshLocalMedia(channelId); } })
        .on(E.TrackSubscribed, (track, pub, participant) => {
          if (room !== r) return;
          if (pub.source === sdk.Track.Source.Camera) {
            if (screen.viewingCameras && track instanceof sdk.RemoteVideoTrack) showCamera(userOf(participant.identity), track);
          } else {
            attach(track, participant.identity);
          }
        }).on(E.TrackUnsubscribed, (track, pub, participant) => {
          if (room !== r) return;
          const user = userOf(participant.identity);
          if (pub.source === sdk.Track.Source.Camera) {
            hideCamera(user, track);
          } else {
            detachTrack(track);
            if (track.kind === "video") setScreen("live", produce((l) => void delete l[user]));
            else audios.delete(user);
          }
        }).on(E.Disconnected, () => { if (room === r) void disconnectScreens(); });
      await r.connect(url, token, { autoSubscribe: false });
      if (!current()) { await r.disconnect(); return null; }
      room = r;
      setScreen({ channelId, connected: true });
      changed();
      return r;
    } catch (e) {
      if (current()) target = null;
      await connected?.disconnect().catch(() => {});
      throw e;
    }
  })().finally(() => { if (connecting === job) connecting = null; });
  connecting = job;
  return job;
}

function resetState(channelId: string | null) {
  for (const u of [...players.keys()]) dropViews(u);
  audios.clear();
  if (screen.full) setFullscreen(null);
  setCameraTracks({});
  watchedParticipants.clear();
  setScreen({ channelId, connected: false, sharing: false, sharingAudio: false, cameraOn: false, viewingCameras: false, shares: [], watching: [], live: {}, viewers: {}, popped: false });
}

export function disconnectScreens(clearContext = false) {
  if (clearContext) { voiceChannel = null; myUser = ""; }
  generation++;
  target = null;
  const r = room;
  const pending = connecting;
  connecting = null;
  const channelId = screen.channelId;
  const wasSharing = local.length > 0;
  const hadCamera = !!camera;
  const previousClosing = closing;
  for (const track of local) track.stop();
  camera?.stop();
  camera = null;
  local = [];
  shareStarting = null;
  cameraStarting = null;
  room = null;
  resetState(null);
  closing = Promise.allSettled([
    previousClosing, pending, r?.disconnect(),
    channelId && wasSharing ? advertise(channelId, "screen", false) : undefined,
    channelId && hadCamera ? advertise(channelId, "camera", false) : undefined,
  ]).then(() => {});
  return closing;
}

/** Pick a screen/window (the system picker) and stream it. */
export async function startShare(quality: Quality, audio: boolean) {
  const channelId = voiceChannel;
  if (!channelId) throw new Error("Join voice first");
  if (local.length || shareStarting !== null) return;
  const request = shareStarting = generation;
  let stream: MediaStream | undefined;
  let tracks: LocalTrack[] = [];
  let publisher: Room | null = null;
  try {
    const q = QUALITIES[quality];
    // The picker needs the click's activation, even on the first SDK load.
    const options = {
      audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 } : false,
      systemAudio: audio ? "include" : "exclude",
      video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: q.fps },
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    };
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing is unavailable in this webview");
    stream = await navigator.mediaDevices.getDisplayMedia(options);
    if (request !== generation) return;
    const sdk = lk ??= await import("livekit-client");
    if (request !== generation) return;
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    if (!videoTrack) throw new Error("The screen picker did not return video");
    videoTrack.contentHint = "motion";
    tracks = [new sdk.LocalVideoTrack(videoTrack, undefined, false)];
    if (audioTrack) tracks.push(new sdk.LocalAudioTrack(audioTrack, undefined, false));
    local = tracks;
    for (const track of tracks) {
      track.mediaStreamTrack.addEventListener("ended", () => {
        if (local === tracks) void stopShare();
      }, { once: true });
    }
    publisher = await connectScreens(channelId);
    if (!publisher || request !== generation || local !== tracks) return;
    const enc = { maxBitrate: q.bitrate, maxFramerate: q.fps };
    for (const t of tracks) {
      if (t.kind === "video") {
        await publisher.localParticipant.publishTrack(t, {
          source: sdk.Track.Source.ScreenShare,
          videoCodec: "h264",
          backupCodec: false,
          simulcast: false,
          screenShareEncoding: enc,
          videoEncoding: enc,
          degradationPreference: "maintain-framerate",
        });
      } else {
        t.mediaStreamTrack.contentHint = "music";
        await publisher.localParticipant.publishTrack(t, {
          source: sdk.Track.Source.ScreenShareAudio,
          audioPreset: { maxBitrate: AUDIO_BITRATE },
          forceStereo: true,
          dtx: false,
          red: false,
        });
      }
      if (request !== generation || local !== tracks) return;
    }
    if (local !== tracks || tracks.some((track) => track.mediaStreamTrack.readyState === "ended")) return;
    await advertise(channelId, "screen", true);
    if (request !== generation || local !== tracks) return;
    setScreen({ sharing: true, sharingAudio: tracks.some((t) => t.kind === "audio") });
  } finally {
    if (shareStarting === request) shareStarting = null;
    if (local !== tracks || !screen.sharing) stream?.getTracks().forEach((track) => track.stop());
    if (local === tracks && !screen.sharing) await stopShare();
    else if (local !== tracks) {
      for (const track of tracks) {
        track.stop();
        await publisher?.localParticipant.unpublishTrack(track).catch(() => {});
      }
    }
    disconnectIfIdle();
  }
}

export async function stopShare() {
  const tracks = local;
  const publisher = room;
  const channelId = screen.channelId;
  const request = generation;
  local = [];
  if (screen.full === SELF) setFullscreen(null);
  setScreen({ sharing: false, sharingAudio: false });
  if (!tracks.length) return;
  for (const track of tracks) track.stop();
  await Promise.allSettled([
    ...tracks.map((track) => publisher?.localParticipant.unpublishTrack(track)),
    channelId ? advertise(channelId, "screen", false) : undefined,
  ]);
  if (generation === request) disconnectIfIdle();
}

export async function setCameraEnabled(enabled: boolean) {
  if (!enabled) {
    const track = camera;
    const publisher = room;
    const channelId = screen.channelId;
    if (!track) return;
    camera = null;
    hideCamera(myUser);
    setScreen("cameraOn", false);
    track.stop();
    await Promise.allSettled([
      publisher?.localParticipant.unpublishTrack(track),
      channelId ? advertise(channelId, "camera", false) : undefined,
    ]);
    disconnectIfIdle();
    return;
  }
  const channelId = voiceChannel;
  if (!channelId) throw new Error("Join voice first");
  if (camera || cameraStarting !== null) return;
  const request = cameraStarting = generation;
  let track: LocalVideoTrack | undefined;
  let publisher: Room | null = null;
  try {
    const sdk = lk ??= await import("livekit-client");
    if (request !== generation) return;
    track = await sdk.createLocalVideoTrack({ resolution: { width: 640, height: 360, frameRate: 24 } });
    if (request !== generation) return;
    const captured = track;
    camera = captured;
    captured.mediaStreamTrack.addEventListener("ended", () => {
      if (camera === captured) void setCameraEnabled(false);
    }, { once: true });
    publisher = await connectScreens(channelId);
    if (!publisher || request !== generation || camera !== captured) return;
    await publisher.localParticipant.publishTrack(captured, { source: sdk.Track.Source.Camera });
    if (request !== generation || camera !== captured || captured.mediaStreamTrack.readyState === "ended") return;
    await advertise(channelId, "camera", true);
    if (request !== generation || camera !== captured) return;
    showCamera(myUser, captured);
    setScreen("cameraOn", true);
  } finally {
    if (cameraStarting === request) cameraStarting = null;
    if (track && camera === track && !screen.cameraOn) await setCameraEnabled(false);
    else if (track && camera !== track) {
      track.stop();
      await publisher?.localParticipant.unpublishTrack(track).catch(() => {});
    }
    disconnectIfIdle();
  }
}

export async function setViewingCameras(enabled: boolean) {
  const channelId = voiceChannel;
  if (!channelId) throw new Error("Join voice first");
  const request = generation;
  setScreen("viewingCameras", enabled);
  try {
    if (enabled) await connectScreens(channelId);
    if (request !== generation) return;
    if (!enabled) {
      for (const userId of Object.keys(cameraTracks())) {
        if (userId !== myUser) hideCamera(userId);
      }
    }
    updateCameraSubscriptions();
  } catch (error) {
    if (request === generation) setScreen("viewingCameras", false);
    throw error;
  } finally {
    if (request === generation) disconnectIfIdle();
  }
}

/** Start watching someone's stream (subscribes; views bind with bindVideo). */
export async function watch(userId: string) {
  const channelId = voiceChannel;
  if (!channelId) throw new Error("Join voice first");
  const request = generation;
  watchRequests++;
  try {
    const viewer = await connectScreens(channelId);
    const sdk = lk;
    if (!viewer || !sdk || request !== generation) return;
    const findShare = () => [...viewer.remoteParticipants.values()].find((p) =>
      userOf(p.identity) === userId && p.getTrackPublication(sdk.Track.Source.ScreenShare));
    const deadline = Date.now() + 5000;
    let participant = findShare();
    while (!participant && Date.now() < deadline && request === generation) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      participant = findShare();
    }
    if (request !== generation) return;
    if (!participant) throw new Error("This screen share is no longer available");
    if (screen.lowResource) for (const user of [...screen.watching]) if (user !== userId) unwatch(user);
    watchedParticipants.set(userId, participant.identity);
    if (!screen.watching.includes(userId)) {
      setScreen("watching", (w) => [...w, userId]);
      publishWatching();
    }
    for (const source of [sdk.Track.Source.ScreenShare, sdk.Track.Source.ScreenShareAudio]) {
      const publication = participant.getTrackPublication(source);
      if (!publication) continue;
      publication.setSubscribed(true);
      if (publication.track) attach(publication.track, participant.identity);
    }
  } finally {
    watchRequests--;
    disconnectIfIdle();
  }
}

export function unwatch(userId: string) {
  if (screen.full === userId) setFullscreen(null);
  // Clear the watch first so late TrackSubscribed callbacks cannot restart audio.
  const identity = watchedParticipants.get(userId);
  watchedParticipants.delete(userId);
  dropViews(userId);
  setScreen("watching", (w) => w.filter((u) => u !== userId));
  if (!screen.watching.length) setScreen("popped", false);
  publishWatching();
  if (!room || !lk) return;
  const p = identity ? room.remoteParticipants.get(identity) : undefined;
  for (const src of [lk.Track.Source.ScreenShare, lk.Track.Source.ScreenShareAudio]) {
    const pub = p?.getTrackPublication(src);
    if (pub?.track) detachTrack(pub.track as RemoteTrack);
    pub?.setSubscribed(false);
  }
  disconnectIfIdle();
}

function videoTrackOf(userId: string) {
  if (!room || !lk) return null;
  const identity = watchedParticipants.get(userId);
  const p = identity ? room.remoteParticipants.get(identity) : undefined;
  return p?.getTrackPublication(lk.Track.Source.ScreenShare)?.track ?? null;
}

/** A view (tile, mini player, fullscreen) wants to show a watched stream in `slot`. */
export function bindVideo(userId: string, slot: HTMLElement) {
  const list = slots.get(userId) ?? [];
  slots.set(userId, [...list.filter((x) => x !== slot), slot]);
  const t = videoTrackOf(userId);
  if (t && screen.watching.includes(userId) && !players.has(userId)) t.attach(playerFor(userId));
  place(userId);
}

export function unbindVideo(userId: string, slot: HTMLElement) {
  const list = (slots.get(userId) ?? []).filter((x) => x !== slot);
  if (list.length) slots.set(userId, list);
  else slots.delete(userId);
  place(userId);
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
