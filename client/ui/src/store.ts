import { batch } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { call, markPainted, now, randomNonce } from "./ipc";
import { findId, mergeMsgs, trimTop } from "./merge";
import type { Msg, Presence, Server, UiEvent, User } from "./types";
import { chime, closeAudio } from "./sounds";

/** The open channel holds at most this many messages in the DOM model. */
const OPEN_CAP = 5000;

export interface VoiceState { channelId: string | null; state: string; muted: boolean; deafened: boolean; detail: string | null }

export const [s, set] = createStore({
  conn: { state: "connecting" as string, rttMs: null as number | null },
  ready: false,
  user: null as User | null,
  servers: [] as Server[],
  presence: {} as Record<string, Presence & { serverId: string }>,
  speaking: [] as string[],
  voice: { channelId: null, state: "idle", muted: false, deafened: false, detail: null } as VoiceState,
  selServer: null as string | null,
  selChannel: null as string | null,
  /** Voice channel shown on the stage (null = show the text channel). */
  stage: null as string | null,
  unread: {} as Record<string, boolean>,
  msgs: [] as Msg[],
  more: true,
  loadingOlder: false,
  toast: null as string | null,
  editing: null as string | null,
});

export const userName = (id: string) => {
  for (const sv of s.servers) for (const m of sv.members) if (m.id === id) return m.name;
  return "unknown";
};
export const currentServer = () => s.servers.find((x) => x.id === s.selServer) ?? null;
export const isOwner = () => !!s.user && currentServer()?.ownerId === s.user.id;

let toastTimer = 0;
export function toast(m: string) {
  set("toast", m);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => set("toast", null), 4000);
}

// ---------- event intake: queued, applied once per animation frame ----------

let queue: UiEvent[] = [];
let scheduled = false;
export function onEvent(e: UiEvent) {
  queue.push(e);
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
}

function flush() {
  scheduled = false;
  const q = queue;
  queue = [];
  const painted: string[] = [];
  batch(() => {
    for (const e of q) apply(e, painted);
  });
  markPainted(painted);
}

function apply(e: UiEvent, painted: string[]) {
  switch (e.t) {
    case "conn":
      set("conn", { state: e.state, rttMs: e.rttMs ?? s.conn.rttMs });
      break;
    case "session": {
      set("ready", true);
      const changedUser = s.user?.id !== e.user?.id;
      set("user", e.user);
      set("servers", reconcile(e.servers, { key: "id" }));
      const pres: Record<string, Presence & { serverId: string }> = {};
      for (const p of e.voice) {
        const sv = e.servers.find((x) => x.channels.some((c) => c.id === p.channelId));
        if (sv) pres[p.userId] = { ...p, serverId: sv.id };
      }
      set("presence", reconcile(pres));
      if (changedUser) {
        set({ selServer: null, selChannel: null, stage: null, msgs: [], unread: {} });
      }
      if (e.user && !s.selServer && e.servers.length) selectServer(e.servers[0].id);
      break;
    }
    case "server": {
      const i = s.servers.findIndex((x) => x.id === e.server.id);
      if (i >= 0) set("servers", i, reconcile(e.server));
      else set("servers", s.servers.length, e.server);
      break;
    }
    case "channelCreated": {
      const i = s.servers.findIndex((x) => x.id === e.channel.serverId);
      if (i >= 0 && !s.servers[i].channels.some((c) => c.id === e.channel.id))
        set("servers", i, "channels", (c) => [...c, e.channel]);
      break;
    }
    case "memberJoined": {
      const i = s.servers.findIndex((x) => x.id === e.serverId);
      if (i >= 0 && !s.servers[i].members.some((m) => m.id === e.user.id))
        set("servers", i, "members", (m) => [...m, e.user]);
      break;
    }
    case "serverRemoved": {
      const name = s.servers.find((x) => x.id === e.serverId)?.name ?? "the server";
      set("servers", (l) => l.filter((x) => x.id !== e.serverId));
      if (s.selServer === e.serverId) {
        set({ selServer: null, selChannel: null, stage: null, msgs: [] });
        if (s.servers.length) queueMicrotask(() => selectServer(s.servers[0].id));
      }
      if (e.reason === "kicked") toast(`You were removed from ${name}`);
      else if (e.reason === "deleted") toast(`${name} was deleted`);
      break;
    }
    case "channelDeleted": {
      if (s.stage === e.channelId) set("stage", null);
      if (s.selChannel === e.channelId) {
        set({ selChannel: null, msgs: [] });
        const next = s.servers.find((x) => x.id === e.serverId)?.channels.find((c) => !c.voice && c.id !== e.channelId);
        if (next) queueMicrotask(() => selectChannel(next.id));
      }
      break;
    }
    case "userUpdated": {
      const u = e.user;
      if (s.user?.id === u.id) set("user", "avatarV", u.avatarV);
      s.servers.forEach((sv, i) => {
        const j = sv.members.findIndex((m) => m.id === u.id);
        if (j >= 0) set("servers", i, "members", j, { name: u.name, avatarV: u.avatarV });
      });
      break;
    }
    case "messages":
      if (e.channelId === s.selChannel) {
        const r = mergeMsgs([...s.msgs], e.msgs);
        set("msgs", reconcile(trimTop(r.list, OPEN_CAP), { key: "id", merge: false }));
        painted.push(...r.changed);
      } else if (e.msgs.some((m) => m.authorId !== s.user?.id)) {
        set("unread", e.channelId, true);
      }
      break;
    case "msgState":
      if (e.channelId === s.selChannel) {
        const i = findId(s.msgs, e.id);
        if (i >= 0) set("msgs", i, "state", (st) => Math.max(st, e.state));
      }
      break;
    case "edited":
      if (e.channelId === s.selChannel) {
        const i = findId(s.msgs, e.id);
        if (i >= 0) set("msgs", i, { content: e.content, editedAt: e.editedAt });
      }
      break;
    case "deleted":
      if (e.channelId === s.selChannel) {
        const i = findId(s.msgs, e.id);
        if (i >= 0) set("msgs", produce((l) => void l.splice(i, 1)));
      }
      break;
    case "presence": {
      // Chime when someone else enters or leaves the room you are in.
      const mine = s.voice.channelId;
      const prev = s.presence[e.presence.userId]?.channelId ?? null;
      const next = e.presence.channelId;
      if (mine && e.presence.userId !== s.user?.id && prev !== next) {
        if (next === mine) chime("join", s.voice.deafened);
        else if (prev === mine) chime("leave", s.voice.deafened);
      }
    }
      if (e.presence.channelId) set("presence", e.presence.userId, { ...e.presence, serverId: e.serverId });
      else set("presence", produce((p) => void delete p[e.presence.userId]));
      break;
    case "voice": {
      const was = s.voice.state;
      if (e.state === "connected" && was !== "connected" && was !== "reconnecting") chime("join", e.deafened);
      if (e.state === "idle" && was !== "idle") {
        if (was === "connected" || was === "reconnecting") chime("leave", e.deafened);
        closeAudio();
      }
    }
      set("voice", { channelId: e.channelId, state: e.state, muted: e.muted, deafened: e.deafened, detail: e.detail });
      if (e.detail) toast(e.detail);
      if (e.state === "idle") set("speaking", []);
      break;
    case "speaking":
      set("speaking", e.userIds);
      break;
    case "error":
      toast(e.message);
      break;
  }
}

// ---------- actions ----------

export function selectServer(id: string) {
  set({ selServer: id, stage: null });
  const sv = s.servers.find((x) => x.id === id);
  const first = sv?.channels.find((c) => !c.voice);
  if (first) selectChannel(first.id);
}

let openSeq = 0;
export async function selectChannel(id: string) {
  const seq = ++openSeq;
  batch(() => {
    set({ selChannel: id, stage: null, msgs: [], more: true, loadingOlder: false, editing: null });
    set("unread", id, false);
  });
  const msgs = await call<Msg[]>("open_channel", { channelId: id });
  if (seq !== openSeq) return;
  const r = mergeMsgs([...s.msgs], msgs);
  set("msgs", reconcile(r.list, { key: "id", merge: false }));
}

export function showStage(id: string) {
  set("stage", id);
  call("voice_prepare", { channelId: id }).catch(() => {});
}

export async function loadOlder() {
  const ch = s.selChannel;
  const oldest = s.msgs.find((m) => !m.id.startsWith("p"));
  if (!ch || !oldest || s.loadingOlder || !s.more) return;
  set("loadingOlder", true);
  try {
    const page = await call<{ msgs: Msg[]; more: boolean }>("load_older", { channelId: ch, before: oldest.id });
    if (ch !== s.selChannel) return;
    batch(() => {
      const r = mergeMsgs([...s.msgs], page.msgs);
      set("msgs", reconcile(r.list, { key: "id", merge: false }));
      set("more", page.more);
    });
  } finally {
    set("loadingOlder", false);
  }
}

export function sendMessage(content: string) {
  const ch = s.selChannel;
  const me = s.user;
  const text = content.trim();
  if (!ch || !me || !text) return;
  const tInput = now();
  const nonce = randomNonce();
  const pending: Msg = { id: "p" + nonce, channelId: ch, authorId: me.id, content: text, editedAt: null, ts: Date.now(), nonce, state: 0 };
  // Optimistic copy painted this frame; the core only transmits.
  set("msgs", s.msgs.length, pending);
  markPainted([pending.id]);
  call("send_message", { channelId: ch, content: text, nonce, tInputMs: tInput }).catch((err) => {
    const i = s.msgs.findIndex((m) => m.id === pending.id);
    if (i >= 0) set("msgs", i, "state", 3);
    toast(String(err));
  });
}

export async function editMessage(id: string, content: string) {
  set("editing", null);
  if (!s.selChannel) return;
  await call("edit_message", { channelId: s.selChannel, id, content }).catch((e) => toast(String(e)));
}

export async function deleteMessage(id: string) {
  if (!s.selChannel) return;
  await call("delete_message", { channelId: s.selChannel, id }).catch((e) => toast(String(e)));
}
