import { batch, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { call, markPainted, now, randomNonce } from "./ipc";
import { findId, mergeMsgs, trimTop } from "./merge";
import { cmpId, SYSTEM_USER, type Attachment, type Channel, type Friend, type Gif, type Msg, type Presence, type Server, type UiEvent, type User } from "./types";
import { chime, closeAudio } from "./sounds";
import { encodeMentions } from "./rich";
import { applyPrefs, prefs, resetPrefs, setPrefs } from "./prefs";
import { loadMediaBase } from "./media";
import { clearBanners, onMessages } from "./notify";

/** The open channel holds at most this many messages in the DOM model. */
const OPEN_CAP = 5000;

export interface VoiceState { channelId: string | null; state: string; muted: boolean; deafened: boolean; detail: string | null }

export const [s, set] = createStore({
  conn: { state: "connecting" as string, rttMs: null as number | null },
  ready: false,
  user: null as User | null,
  servers: [] as Server[],
  users: {} as Record<string, User>,
  mentionCandidates: {} as Record<string, User[]>,
  memberLoaded: {} as Record<string, number>,
  presence: {} as Record<string, Presence & { serverId: string }>,
  speaking: [] as string[],
  media: { screen: {} as Record<string, string>, camera: {} as Record<string, string> },
  voice: { channelId: null, state: "idle", muted: false, deafened: false, detail: null } as VoiceState,
  selServer: null as string | null,
  selChannel: null as string | null,
  /** Friends mode: the friends home, or a DM when the selected server is one. */
  friendsOpen: false,
  /** Your unique login name (friends add you by it). */
  username: "",
  friends: [] as Friend[],
  /** Voice channel shown on the stage (null = show the text channel). */
  stage: null as string | null,
  /** channel → last read message id (yours, from the server + live). */
  reads: {} as Record<string, string>,
  /** users currently online */
  online: {} as Record<string, boolean>,
  /** the open list is scrolled to the newest message */
  atBottom: true,
  /** message being replied to in the composer */
  replyTo: null as Msg | null,
  /** unseen @mentions per channel (this session) */
  mentions: {} as Record<string, number>,
  /** message to scroll to and flash */
  jump: null as string | null,
  /** read marker when the open channel was opened ("new messages" divider) */
  dividerAfter: null as string | null,
  msgs: [] as Msg[],
  more: true,
  loadingOlder: false,
  channelLoading: false,
  channelError: null as string | null,
  toast: null as string | null,
  editing: null as string | null,
});

export const userName = (id: string) => {
  if (id === SYSTEM_USER) return "HopOn";
  return s.users[id]?.name ?? "unknown";
};
export const currentServer = () => s.servers.find((x) => x.id === s.selServer) ?? null;
/** Servers you see in the server list (DMs live under Friends). */
export const realServers = () => s.servers.filter((x) => !x.dmWith);
export const isDmServer = (id: string | null) => !!id && !!s.servers.find((x) => x.id === id)?.dmWith;
export const currentDm = () => { const sv = currentServer(); return sv?.dmWith ? sv : null; };
export const dmWith = (userId: string) => s.servers.find((x) => x.dmWith === userId) ?? null;
export const friendOf = (userId: string) => s.friends.find((f) => f.user.id === userId) ?? null;
/** The DM a channel belongs to, if it is one. */
export const dmOfChannel = (channelId: string) => s.servers.find((x) => x.dmWith && x.channels.some((c) => c.id === channelId)) ?? null;
export function serverUsers(server: Server | null | undefined, includeSearch = false): User[] {
  if (!server) return [];
  const users = new Map(server.memberIds.map((id) => s.users[id]).filter((u): u is User => !!u).map((u) => [u.id, u]));
  if (includeSearch) for (const u of s.mentionCandidates[server.id] ?? []) users.set(u.id, u);
  return [...users.values()];
}
export const currentServerUsers = (includeSearch = false) => serverUsers(currentServer(), includeSearch);
const memberLoads = new Set<string>();
export function loadMoreMembers(serverId: string) {
  const server = s.servers.find((x) => x.id === serverId);
  if (!server || memberLoads.has(serverId)) return;
  const offset = s.memberLoaded[serverId] ?? 0;
  if (offset >= server.memberCount) return;
  memberLoads.add(serverId);
  call("load_members", { serverId, offset }).catch((e) => toast(String(e))).finally(() => memberLoads.delete(serverId));
}
export function rememberMentionCandidates(serverId: string, users: User[]) {
  set("mentionCandidates", serverId, users);
}
export const isOwner = () => !!s.user && currentServer()?.ownerId === s.user.id;

function clearChannelMedia(channelId: string) {
  for (const source of ["camera", "screen"] as const) {
    for (const [userId, channel] of Object.entries(s.media[source])) {
      if (channel === channelId) set("media", source, userId, undefined!);
    }
  }
}

// ---------- typing ----------
// Separate signal (not the store) so typing churn never touches the list.

const TYPING_MS = 6000;
const typers = new Map<string, Map<string, number>>(); // channel → user → expires
const [typingTick, setTypingTick] = createSignal(0);
let typingTimer = 0;

function sweepTyping() {
  typingTimer = 0;
  const now = Date.now();
  let next = Infinity;
  for (const [ch, users] of typers) {
    for (const [u, exp] of users) if (exp <= now) users.delete(u); else next = Math.min(next, exp);
    if (!users.size) typers.delete(ch);
  }
  setTypingTick((n) => n + 1);
  // Only keep a timer while someone is typing (idle CPU stays at zero).
  if (next !== Infinity) typingTimer = window.setTimeout(sweepTyping, next - now + 20);
}

function noteTyping(ch: string, user: string, on: boolean) {
  let users = typers.get(ch);
  if (on) {
    if (!users) typers.set(ch, (users = new Map()));
    users.set(user, Date.now() + TYPING_MS);
  } else if (!users?.delete(user)) return;
  setTypingTick((n) => n + 1);
  if (!typingTimer) typingTimer = window.setTimeout(sweepTyping, TYPING_MS + 20);
}

/** Names typing in a channel (re-evaluates as the set changes). */
export function typingIn(ch: string | null): string[] {
  typingTick();
  if (!ch) return [];
  return [...(typers.get(ch)?.keys() ?? [])].map(userName);
}

let lastTypingSent = 0;
let lastTypingCh = "";
/** Composer input: tell others, at most every 3 s per channel. */
export function iAmTyping() {
  const ch = s.selChannel;
  if (!ch) return;
  const now = Date.now();
  if (ch === lastTypingCh && now - lastTypingSent < 3000) return;
  lastTypingSent = now;
  lastTypingCh = ch;
  call("typing", { channelId: ch }).catch(() => {});
}

// ---------- read state ----------

function setRead(channelId: string, id: string) {
  const cur = s.reads[channelId];
  if (!cur || cmpId(id, cur) > 0) set("reads", channelId, id);
}

function absorbServers(servers: Server[], replace: boolean) {
  const reads: Record<string, string> = replace ? {} : { ...s.reads };
  const online: Record<string, boolean> = replace ? {} : { ...s.online };
  for (const sv of servers) {
    for (const [c, r] of Object.entries(sv.reads ?? {})) if (!reads[c] || cmpId(r, reads[c]) > 0) reads[c] = r;
    for (const u of sv.online ?? []) online[u] = true;
  }
  if (s.user) online[s.user.id] = true;
  set("reads", reconcile(reads));
  set("online", reconcile(online));
}

/** Track the newest id per channel; your own messages count as read. */
function bumpLastId(channelId: string, msgs: Msg[]) {
  for (let i = 0; i < s.servers.length; i++) {
    const j = s.servers[i].channels.findIndex((c) => c.id === channelId);
    if (j < 0) continue;
    for (const m of msgs) {
      if (m.id.startsWith("p") || m.state < 2) continue;
      if (cmpId(m.id, s.servers[i].channels[j].lastId) > 0) set("servers", i, "channels", j, "lastId", m.id);
      if (m.authorId === s.user?.id) setRead(channelId, m.id);
    }
    return;
  }
}

export const isUnread = (c: Channel) => !c.voice && c.lastId !== "0" && cmpId(c.lastId, s.reads[c.id] ?? "0") > 0;

let markTimer = 0;
/** Mark the open channel read when it is actually being looked at. */
export function maybeMarkRead() {
  clearTimeout(markTimer);
  markTimer = window.setTimeout(() => {
    const ch = s.selChannel;
    if (!ch || s.stage || !s.atBottom || !document.hasFocus() || document.hidden) return;
    let newest = "";
    for (let i = s.msgs.length - 1; i >= 0; i--) if (!s.msgs[i].id.startsWith("p") && s.msgs[i].state === 2) { newest = s.msgs[i].id; break; }
    if (!newest || (s.reads[ch] && cmpId(newest, s.reads[ch]) <= 0)) return;
    setRead(ch, newest);
    call("mark_read", { channelId: ch, messageId: newest }).catch(() => {});
  }, 500);
}

let toastTimer = 0;
export function toast(m: string) {
  set("toast", m);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => set("toast", null), 4000);
}

// ---------- event intake: queued, applied once per animation frame ----------

let queue: UiEvent[] = [];
let scheduled = false;
const notifyCtx = {
  get me() { return s.user?.id ?? null; },
  get openChannel() { return s.stage ? null : s.selChannel; },
  channelName: (id: string) => { const dm = dmOfChannel(id); return dm ? "Direct message" : `#${s.servers.flatMap((x) => x.channels).find((c) => c.id === id)?.name ?? "channel"}`; },
  serverName: (id: string) => (dmOfChannel(id) ? "" : s.servers.find((x) => x.channels.some((c) => c.id === id))?.name ?? ""),
  userName: (id: string) => userName(id),
};

export function onEvent(e: UiEvent) {
  // Notifications are decided on arrival: the frame queue below doesn't run
  // while the window is hidden (tray), and that's exactly when they matter.
  if (e.t === "incomingMessage") {
    onMessages(e.channelId, [e.msg], notifyCtx);
    return;
  }
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
      loadMediaBase(); // the server address may have changed at sign-in
      const changedUser = s.user?.id !== e.user?.id;
      const loggingOut = !e.user && !!s.user;
      set("user", e.user);
      for (const source of ["screen", "camera"] as const) {
        set("media", source, reconcile(Object.fromEntries(e.media.filter((p) => p.active && p.source === source).map((p) => [p.userId, p.channelId]))));
      }
      set("servers", reconcile(e.servers, { key: "id" }));
      const users = Object.fromEntries(e.users.map((u) => [u.id, u]));
      set("users", reconcile(users));
      set("mentionCandidates", {});
      set("memberLoaded", {});
      const pres: Record<string, Presence & { serverId: string }> = {};
      for (const p of e.voice) {
        const sv = e.servers.find((x) => x.channels.some((c) => c.id === p.channelId));
        if (sv) pres[p.userId] = { ...p, serverId: sv.id };
      }
      set("presence", reconcile(pres));
      set("username", e.username ?? "");
      set("friends", reconcile(e.friends ?? []));
      for (const f of e.friends ?? []) set("users", f.user.id, f.user);
      absorbServers(e.servers, true);
      if (loggingOut) resetPrefs();
      if (changedUser) {
        set({ selServer: null, selChannel: null, stage: null, msgs: [] });
      }
      const real = e.servers.filter((x) => !x.dmWith);
      if (e.user && !s.selServer && real.length) {
        const last = prefs.lastServer;
        selectServer(last && real.some((x) => x.id === last) ? last : real[0].id);
      }
      break;
    }
    case "friend": {
      set("users", e.friend.user.id, e.friend.user);
      const i = s.friends.findIndex((f) => f.user.id === e.friend.user.id);
      if (i >= 0) set("friends", i, reconcile(e.friend));
      else set("friends", s.friends.length, e.friend);
      break;
    }
    case "friendRemoved":
      set("friends", (l) => l.filter((f) => f.user.id !== e.userId));
      break;
    case "server": {
      absorbServers([e.server], false);
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
      set("users", e.user.id, e.user);
      if (i >= 0 && !s.servers[i].memberIds.includes(e.user.id)) {
        set("servers", i, "memberIds", (ids) => [...ids, e.user.id]);
        set("servers", i, "memberCount", (n) => n + 1);
      }
      set("online", e.user.id, true);
      break;
    }
    case "memberPage": {
      const i = s.servers.findIndex((x) => x.id === e.serverId);
      for (const u of e.users) set("users", u.id, u);
      if (i >= 0) {
        set("servers", i, "memberIds", (ids) => [...new Set([...ids, ...e.users.map((u) => u.id)])]);
        set("memberLoaded", e.serverId, Math.max(s.memberLoaded[e.serverId] ?? 0, e.offset + e.users.length));
        for (const u of e.users) set("online", u.id, e.online.includes(u.id));
        set("servers", i, "activities", (a) => ({ ...a, ...e.activities }));
      }
      break;
    }
    case "memberSearch":
      for (const u of e.users) set("users", u.id, u);
      set("mentionCandidates", e.serverId, e.users);
      break;
    case "reaction": {
      if (e.channelId !== s.selChannel) break;
      const i = findId(s.msgs, e.messageId);
      if (i < 0) break;
      set("msgs", i, "reactions", produce((rs: { emoji: string; users: string[] }[]) => {
        const r = rs.find((x) => x.emoji === e.emoji);
        if (e.add) {
          if (!r) rs.push({ emoji: e.emoji, users: [e.userId] });
          else if (!r.users.includes(e.userId)) r.users.push(e.userId);
        } else if (r) {
          r.users = r.users.filter((u) => u !== e.userId);
          if (!r.users.length) rs.splice(rs.indexOf(r), 1);
        }
      }));
      break;
    }
    case "prefs":
      applyPrefs(e.json);
      break;
    case "typing":
      noteTyping(e.channelId, e.userId, true);
      break;
    case "mentioned":
      if (e.channelId !== s.selChannel || !s.atBottom || !document.hasFocus())
        set("mentions", e.channelId, (n) => (n ?? 0) + 1);
      break;
    case "readUpdated":
      setRead(e.channelId, e.lastRead);
      break;
    case "channelActivity": {
      for (let i = 0; i < s.servers.length; i++) {
        const j = s.servers[i].channels.findIndex((c) => c.id === e.channelId);
        if (j >= 0 && cmpId(e.lastId, s.servers[i].channels[j].lastId) > 0)
          set("servers", i, "channels", j, "lastId", e.lastId);
      }
      break;
    }
    case "userPresence":
      set("online", e.userId, e.online);
      break;
    case "activity":
      s.servers.forEach((sv, i) => {
        if (!sv.memberIds.includes(e.userId)) return;
        set("servers", i, "activities", produce((a: Record<string, string>) => { if (e.game) a[e.userId] = e.game; else delete a[e.userId]; }));
      });
      break;
    case "serverRemoved": {
      const server = s.servers.find((x) => x.id === e.serverId);
      const name = server?.name ?? "the server";
      for (const channel of server?.channels ?? []) {
        if (channel.voice) clearChannelMedia(channel.id);
      }
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
      clearChannelMedia(e.channelId);
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
      if (s.user?.id === u.id) set("user", u);
      set("users", u.id, u);
      for (const [server, candidates] of Object.entries(s.mentionCandidates)) {
        if (candidates.some((candidate) => candidate.id === u.id)) {
          set("mentionCandidates", server, candidates.map((candidate) => candidate.id === u.id ? u : candidate));
        }
      }
      break;
    }
    case "messages":
      if (e.channelId === s.selChannel) {
        const r = mergeMsgs([...s.msgs], e.msgs);
        set("msgs", reconcile(trimTop(r.list, OPEN_CAP), { key: "id", merge: false }));
        painted.push(...r.changed);
        maybeMarkRead();
      }
      bumpLastId(e.channelId, e.msgs);
      for (const m of e.msgs) noteTyping(e.channelId, m.authorId, false);
      break;
    case "msgState":
      if (e.channelId === s.selChannel) {
        const i = findId(s.msgs, e.id);
        if (i >= 0) {
          set("msgs", i, "state", (st) => Math.max(st, e.state));
          if (e.state === 2) {
            if (s.msgs[i].authorId === s.user?.id) setRead(e.channelId, e.id);
            else maybeMarkRead();
          }
        }
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
    case "openChannel": {
      // A Windows notification was clicked.
      const id = e.channelId;
      const sv = s.servers.find((x) => x.channels.some((c) => c.id === id));
      if (sv) queueMicrotask(() => { if (s.selServer !== sv.id) selectServer(sv.id); if (s.selChannel !== id || s.stage) void selectChannel(id); });
      break;
    }
    case "mediaPresence": {
      const { source, userId, channelId, active } = e.media;
      if (active) set("media", source, userId, channelId);
      else if (s.media[source][userId] === channelId) set("media", source, userId, undefined!);
      break;
    }
    case "error":
      toast(e.message);
      break;
  }
}

// ---------- actions ----------

export function selectServer(id: string) {
  const dm = isDmServer(id);
  set({ selServer: id, stage: null, selChannel: null, msgs: [], channelError: null, channelLoading: false, friendsOpen: dm });
  if (!dm && prefs.lastServer !== id) setPrefs({ lastServer: id });
  const sv = s.servers.find((x) => x.id === id);
  const last = prefs.lastChannel[id];
  const ch = sv?.channels.find((c) => c.id === last && !c.voice) ?? sv?.channels.find((c) => !c.voice);
  if (ch) selectChannel(ch.id);
  else set({ stage: null, selChannel: null, msgs: [], more: false, channelLoading: false });
}

let openSeq = 0;
export async function selectChannel(id: string) {
  const seq = ++openSeq;
  batch(() => {
    set({ selChannel: id, stage: null, msgs: [], more: true, loadingOlder: false, channelLoading: true, channelError: null, editing: null, replyTo: null, jump: null, dividerAfter: s.reads[id] ?? null });
    set("mentions", id, 0);
    clearBanners(id);
    const sv = s.servers.find((x) => x.channels.some((c) => c.id === id));
    if (sv && prefs.lastChannel[sv.id] !== id) setPrefs({ lastChannel: { ...prefs.lastChannel, [sv.id]: id } });
  });
  try {
    const msgs = await call<Msg[]>("open_channel", { channelId: id });
    if (seq !== openSeq || s.selChannel !== id) return;
    const r = mergeMsgs([...s.msgs], msgs);
    set("msgs", reconcile(r.list, { key: "id", merge: false }));
    set("channelLoading", false);
    maybeMarkRead();
  } catch (error) {
    if (seq === openSeq && s.selChannel === id) set({ channelError: String(error), channelLoading: false });
  }
}

export function retryOpenChannel() {
  if (s.selChannel) void selectChannel(s.selChannel);
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

/** Send text and/or uploaded files and/or a GIF. */
export function sendMessage(content: string, files: Attachment[] = [], gifs: Gif[] = []) {
  const ch = s.selChannel;
  const me = s.user;
  const members = currentServerUsers(true);
  const text = encodeMentions(content.trim(), members);
  if (!ch || !me || (!text && !files.length && !gifs.length)) return;
  // Optimistic attachments: GIFs show their preview until the server copy lands.
  const attachments: Attachment[] = [
    ...files,
    ...gifs.map((g) => ({ id: g.id, name: g.title, mime: "image/webp", size: 0, width: g.width, height: g.height, url: g.preview, preview: g.preview })),
  ];
  const tInput = now();
  const nonce = randomNonce();
  const replyTo = s.replyTo?.id ?? null;
  set("replyTo", null);
  lastTypingSent = 0;
  const pending: Msg = { id: "p" + nonce, channelId: ch, authorId: me.id, content: text, editedAt: null, ts: Date.now(), nonce, state: 0, replyTo, reactions: [], attachments };
  // Optimistic copy painted this frame; the core only transmits.
  set("msgs", s.msgs.length, pending);
  markPainted([pending.id]);
  call("send_message", { channelId: ch, content: text, nonce, tInputMs: tInput, replyTo, files: files.map((f) => f.id), gifs: gifs.map((g) => g.id) }).catch((err) => {
    const i = s.msgs.findIndex((m) => m.id === pending.id);
    if (i >= 0) set("msgs", i, "state", 3);
    toast(String(err));
  });
}

// ---------- keyboard navigation ----------

/** Move to the next/previous text channel (optionally only unread ones). */
export function cycleChannel(dir: 1 | -1, unreadOnly = false) {
  const sv = currentServer();
  if (!sv) return;
  const list = sv.channels.filter((c) => !c.voice);
  if (!list.length) return;
  const at = Math.max(0, list.findIndex((c) => c.id === s.selChannel));
  for (let k = 1; k <= list.length; k++) {
    const c = list[(at + dir * k + list.length * k) % list.length];
    if (!unreadOnly || isUnread(c) || s.mentions[c.id]) {
      if (c.id !== s.selChannel || s.stage) selectChannel(c.id);
      return;
    }
  }
}

export function cycleServer(dir: 1 | -1) {
  const list = realServers();
  if (!list.length) return;
  const at = list.findIndex((x) => x.id === s.selServer);
  if (at < 0) { selectServer(list[0].id); return; }
  if (list.length < 2) return;
  selectServer(list[(at + dir + list.length) % list.length].id);
}

// ---------- friends ----------

/** Friends home (keeps your server selection to come back to). */
export function openFriends() {
  set("friendsOpen", true);
  if (isDmServer(s.selServer)) { set({ selServer: null, selChannel: null, stage: null, msgs: [] }); }
}

/** Back to your servers. */
export function closeFriends() {
  set("friendsOpen", false);
  if (!s.selServer || isDmServer(s.selServer)) {
    const real = realServers();
    const last = prefs.lastServer;
    const to = (last && real.some((x) => x.id === last) ? last : real[0]?.id) ?? null;
    if (to) selectServer(to); else set({ selServer: null, selChannel: null, stage: null, msgs: [] });
  }
}

export function openDm(userId: string) {
  const dm = dmWith(userId);
  if (dm) selectServer(dm.id);
}

/** Incoming requests + unread DMs: what the Friends button points at. */
export const friendsAttention = () =>
  s.friends.some((f) => f.state === "incoming") ||
  s.servers.some((x) => x.dmWith && x.channels.some((c) => isUnread(c) && x.id !== s.selServer));

export async function editMessage(id: string, content: string) {
  set("editing", null);
  if (!s.selChannel) return;
  const text = encodeMentions(content, currentServerUsers(true));
  await call("edit_message", { channelId: s.selChannel, id, content: text }).catch((e) => toast(String(e)));
}

export function toggleReaction(m: Msg, emoji: string) {
  if (!s.selChannel || !s.user || m.id.startsWith("p")) return;
  const mine = m.reactions.find((r) => r.emoji === emoji)?.users.includes(s.user.id) ?? false;
  call("react", { channelId: s.selChannel, messageId: m.id, emoji, add: !mine }).catch((e) => toast(String(e)));
}

/** Scroll to a message, paging older history (bounded) until it is loaded. */
export async function jumpTo(id: string) {
  const ch = s.selChannel;
  for (let page = 0; page < 20; page++) {
    if (ch !== s.selChannel) return;
    if (findId(s.msgs, id) >= 0) { set("jump", id); return; }
    if (!s.more) break;
    while (s.loadingOlder) await new Promise((r) => setTimeout(r, 50));
    await loadOlder();
  }
  toast("That message is too far back to jump to");
}

export async function deleteMessage(id: string) {
  if (!s.selChannel) return;
  await call("delete_message", { channelId: s.selChannel, id }).catch((e) => toast(String(e)));
}
