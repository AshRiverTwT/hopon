import { batch, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { call, markPainted, now, randomNonce } from "./ipc";
import { findId, mergeMsgs, trimTop } from "./merge";
import { cmpId, SYSTEM_USER, type Attachment, type Channel, type Gif, type Msg, type Presence, type Server, type UiEvent, type User } from "./types";
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
  screenShares: {} as Record<string, string>,
  voice: { channelId: null, state: "idle", muted: false, deafened: false, detail: null } as VoiceState,
  selServer: null as string | null,
  selChannel: null as string | null,
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
  toast: null as string | null,
  editing: null as string | null,
});

export const userName = (id: string) => {
  if (id === SYSTEM_USER) return "HopOn";
  return s.users[id]?.name ?? "unknown";
};
export const currentServer = () => s.servers.find((x) => x.id === s.selServer) ?? null;
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
  channelName: (id: string) => s.servers.flatMap((x) => x.channels).find((c) => c.id === id)?.name ?? "channel",
  serverName: (id: string) => s.servers.find((x) => x.channels.some((c) => c.id === id))?.name ?? "",
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
      absorbServers(e.servers, true);
      if (loggingOut) resetPrefs();
      if (changedUser) {
        set({ selServer: null, selChannel: null, stage: null, msgs: [], screenShares: {} });
      }
      if (e.user && !s.selServer && e.servers.length) {
        const last = prefs.lastServer;
        selectServer(last && e.servers.some((x) => x.id === last) ? last : e.servers[0].id);
      }
      break;
    }
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
      set("users", u.id, u);
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
    case "screenShare":
      if (e.active) set("screenShares", e.userId, e.channelId);
      else if (s.screenShares[e.userId] === e.channelId) set("screenShares", e.userId, undefined!);
      break;
    case "error":
      toast(e.message);
      break;
  }
}

// ---------- actions ----------

export function selectServer(id: string) {
  set({ selServer: id, stage: null });
  if (prefs.lastServer !== id) setPrefs({ lastServer: id });
  const sv = s.servers.find((x) => x.id === id);
  const last = prefs.lastChannel[id];
  const ch = sv?.channels.find((c) => c.id === last && !c.voice) ?? sv?.channels.find((c) => !c.voice);
  if (ch) selectChannel(ch.id);
}

let openSeq = 0;
export async function selectChannel(id: string) {
  const seq = ++openSeq;
  batch(() => {
    set({ selChannel: id, stage: null, msgs: [], more: true, loadingOlder: false, editing: null, replyTo: null, jump: null, dividerAfter: s.reads[id] ?? null });
    set("mentions", id, 0);
    clearBanners(id);
    const sv = s.servers.find((x) => x.channels.some((c) => c.id === id));
    if (sv && prefs.lastChannel[sv.id] !== id) setPrefs({ lastChannel: { ...prefs.lastChannel, [sv.id]: id } });
  });
  const msgs = await call<Msg[]>("open_channel", { channelId: id });
  if (seq !== openSeq) return;
  const r = mergeMsgs([...s.msgs], msgs);
  set("msgs", reconcile(r.list, { key: "id", merge: false }));
  maybeMarkRead();
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
  if (s.servers.length < 2) return;
  const at = Math.max(0, s.servers.findIndex((x) => x.id === s.selServer));
  selectServer(s.servers[(at + dir + s.servers.length) % s.servers.length].id);
}

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
