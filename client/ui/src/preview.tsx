// Dev-only design preview: mocks the Rust core and feeds a fake session.
// Not part of the production build (vite builds index.html only).
//   pnpm dev  →  http://localhost:5173/preview.html?s=chat|voice|login|empty
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Msg, Server } from "./types";

const scene = new URLSearchParams(location.search).get("s") ?? "chat";
// ?lk=<token>&lkurl=ws://…: screen share against a real LiveKit server (tests).
const lk = new URLSearchParams(location.search).get("lk");
const lkUrl = new URLSearchParams(location.search).get("lkurl") ?? "ws://127.0.0.1:7880";
const me = { id: "1001", name: "ash", avatarV: 1, accent: 1, status: "" };
const names = ["ash", "mira", "jun", "tobias", "nell", "kaito", "rosa", "ezra"];
const members = names.map((n, i) => ({ id: String(1001 + i), name: n, avatarV: i % 3 === 2 ? 0 : 1, accent: i === 0 ? 1 : (i * 3) % 9, status: "" }));
const server: Server = {
  id: "9001", name: "Night Shift", ownerId: new URLSearchParams(location.search).has("member") ? "1002" : "1001", memberIds: members.map((m) => m.id), memberCount: members.length,
  reads: { "7003": "1", "7001": "10001997" }, online: ["1001", "1002", "1003", "1005"], activities: { "1002": "VALORANT", "1005": "Counter-Strike 2" },
  statuses: { "1003": { mode: "idle", emoji: "", text: "", until: 0 }, "1004": { mode: "online", emoji: "📚", text: "studying, ping me later", until: 0 }, "1005": { mode: "dnd", emoji: "", text: "", until: 0 } },
  channels: [
    { id: "7001", serverId: "9001", name: "general", voice: false, topic: "Anything goes. Be kind.", lastId: "0" },
    { id: "7002", serverId: "9001", name: "design-crit", voice: false, topic: "", lastId: "0" },
    { id: "7003", serverId: "9001", name: "music", voice: false, topic: "", lastId: "99999999" },
    { id: "7004", serverId: "9001", name: "build-log", voice: false, topic: "", lastId: "0" },
    { id: "7101", serverId: "9001", name: "Lounge", voice: true, topic: "", lastId: "0" },
    { id: "7102", serverId: "9001", name: "Late Room", voice: true, topic: "", lastId: "0" },
  ],
};
const lines = [
  "anyone up for a quick call later?", "pushed the new build, installer is 9.3 MB",
  "the dial thing is growing on me", "latency overlay says 28 ms p95 on my end",
  "ok that's actually fast", "brb coffee",
  "I think the echo cancellation should default off for headsets.\nAt least make it obvious in settings.",
  "agreed", "can we get the invite link pinned somewhere", "lol", "shipping it",
];
function history(n: number): Msg[] {
  const out: Msg[] = [];
  let ts = Date.now() - n * 45_000;
  let author = 0;
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) author = (author + 1 + (i % 5)) % names.length;
    ts += 20_000 + ((i * 7919) % 90_000);
    out.push({ id: String(10_000_000 + i), channelId: "7001", authorId: members[author].id, content: lines[(i * 31) % lines.length],
      editedAt: i % 97 === 0 ? ts : null, ts, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] });
  }
  return out;
}
const hist = history(2000);
hist.push({ id: "10001998", channelId: "7001", authorId: "1003", content: "new build is up: https://github.com/AshRiverTwT/hopon — try **voice** with `echo off` on headsets", editedAt: null, ts: Date.now() - 120000, nonce: "", state: 2, replyTo: null, reactions: [{ emoji: "🔥", users: ["1001", "1002", "1004"] }, { emoji: "👀", users: ["1005"] }], attachments: [] });
hist.push({ id: "10001999", channelId: "7001", authorId: "1002", content: "<@1001> nice, the dial is _so_ smooth now", editedAt: null, ts: Date.now() - 90000, nonce: "", state: 2, replyTo: "10001998", reactions: [{ emoji: "👍", users: ["1003"] }], attachments: [] });
hist.push({ id: "10002000", channelId: "7001", authorId: "1002", content: "Wordle 1,234 3/6\n\n⬛🟨⬛⬛⬛\n🟩🟩⬛🟩⬛\n🟩🟩🟩🟩🟩", editedAt: null, ts: Date.now() - 60000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] });
hist.push({ id: "10002001", channelId: "7001", authorId: "0", content: "A wild <@1006> appeared!", editedAt: null, ts: Date.now() - 50000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] });
hist.push({ id: "10002002", channelId: "7001", authorId: "1004", content: "sunset from the roof", editedAt: null, ts: Date.now() - 40000, nonce: "", state: 2, replyTo: null, reactions: [{ emoji: "😍", users: ["1001", "1002"] }],
  attachments: [{ id: "AAAAAAAAAAAAAAAAAAAAAA", name: "roof.jpg", mime: "image/jpeg", size: 482113, width: 1600, height: 1000, url: "", preview: "" }] });
hist.push({ id: "10002003", channelId: "7001", authorId: "1004", content: "", editedAt: null, ts: Date.now() - 39000, nonce: "", state: 2, replyTo: null, reactions: [],
  attachments: [{ id: "BBBBBBBBBBBBBBBBBBBBBB", name: "patch-notes-0.2.pdf", mime: "application/pdf", size: 1288490, width: 0, height: 0, url: "", preview: "" }] });
hist.push({ id: "10002004", channelId: "7001", authorId: "1002", content: "", editedAt: null, ts: Date.now() - 30000, nonce: "", state: 2, replyTo: null, reactions: [],
  attachments: [{ id: "klipy:1", name: "cat dance", mime: "image/gif", size: 0, width: 320, height: 240, url: "https://media.example/cat.gif", preview: "" }] });
hist.push({ id: "10002005", channelId: "7001", authorId: me.id, content: "😄", editedAt: null, ts: Date.now() - 20000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] });
hist.push({ id: "10002006", channelId: "7001", authorId: me.id, content: "hi", editedAt: null, ts: Date.now() - 19000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] });
hist.push({ id: "p1", channelId: "7001", authorId: me.id, content: "this one is still sending", editedAt: null, ts: Date.now(), nonce: "1", state: 0, replyTo: null, reactions: [], attachments: [] });
hist.push({ id: "p2", channelId: "7001", authorId: me.id, content: "and this one failed", editedAt: null, ts: Date.now(), nonce: "2", state: 3, replyTo: null, reactions: [], attachments: [] });

function fakeAvatar(id: string): string {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!; const h = (Number(id) * 47) % 360;
  const gr = g.createLinearGradient(0, 0, 64, 64);
  gr.addColorStop(0, `hsl(${h} 45% 55%)`); gr.addColorStop(1, `hsl(${(h + 60) % 360} 50% 25%)`);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(32, 26, 11, 0, 7); g.fill(); g.beginPath(); g.arc(32, 62, 22, 0, 7); g.fill();
  return c.toDataURL();
}

const calls: string[] = [];
(window as unknown as { __calls: string[] }).__calls = calls;
mockIPC((cmd, args) => {
  calls.push(cmd);
  switch (cmd) {
    case "open_channel": return (args as { channelId: string }).channelId === "7901" ? dmHist : scene === "chat" || scene === "voice" ? hist : [];
    case "load_older": return { msgs: [], more: false };
    case "get_config": return { url: "wss://hopon-chat.duckdns.org/ws" };
    case "audio_devices": return { processing: { aec: false, ns: true, agc: true }, inputs: [{ id: "a", name: "Headset Microphone (Arctis 7)" }], outputs: [{ id: "b", name: "Headset Earphone (Arctis 7)" }], input: "a", output: "b", aec: "Software", ns: "Software", agc: "Software" };
    case "perf_stats": return { rows: [{ name: "text: remote input->paint (synced)", count: 600, p50_ms: 21.3, p95_ms: 28.7, p99_ms: 33.1, max_ms: 40 }], startup: { processToPaintMs: 657, mainToPaintMs: 610, mainToConnectedMs: 2.5 }, clockOffsetMs: 0.1, bestRttMs: 0.4, rssMb: 41 };
    case "create_invite": return "hopon://invite/Kq7xN2pLmA";
    case "avatar": return fakeAvatar(String((args as { userId: string }).userId));
    case "get_profile": { const id = String((args as { userId: string }).userId); const u = [me, ...members].find((m) => m.id === id) ?? me;
      return { user: u, username: u.name.toLowerCase(), bio: id === "1002" ? "Diamond 2 on a good day. Duo queue after 9." : "", bannerV: 0, createdAt: Date.UTC(2025, 2, 14), joinedAt: Date.UTC(2025, 5, 2) }; }
    case "banner": return null;
    case "idle_seconds": return null;
    case "screen_grant": return lk ? [lkUrl, lk] : new Promise(() => {}); // never connects in the preview (unless ?lk=)
    case "update_check": return { current: "0.4.2", latest: "0.4.3", available: true, notes: "" };
    case "gif_search": return { enabled: true, results: Array.from({ length: 12 }, (_, i) => ({ id: `klipy:${i}`, title: `gif ${i}`, preview: `https://media.example/g${i}.gif`, width: 320, height: 200 + (i % 3) * 60 })) };
    case "upload_file": return { id: "CCCCCCCCCCCCCCCCCCCCCC", name: "screenshot.png", mime: "image/png", size: 91234, width: 1280, height: 720, url: "", preview: "" };
    default: return null;
  }
});

const { onEvent } = await import("./store");
await import("./main");

const user = scene === "login" ? null : me;
const mk = (id: string, name: string, unread = false): Server => ({ id, name, ownerId: "1001", memberIds: ["1001"], memberCount: 1, reads: {}, online: ["1001"], activities: {}, statuses: {},
  channels: [{ id: `${id}1`, serverId: id, name: "general", voice: false, topic: "", lastId: unread ? "30000001" : "0" }, { id: `${id}2`, serverId: id, name: "Voice", voice: true, topic: "", lastId: "0" }] } as unknown as Server);
// ?servers: a few more servers to try the server rail.
const extra = new URLSearchParams(location.search).has("servers");
const servers = scene === "empty" || scene === "login" ? [] : extra
  ? [mk("8990", "Arcade Club"), mk("8995", "Late Lab", true), server, mk("9010", "Tea Break"), mk("9020", "Bug Bash"), mk("9030", "The Basement")]
  : [server];
// Friends: mira (a DM), nell (friend, no DM yet), jun asked you, you asked rosa.
const dmServer: Server = { id: "9901", name: "", ownerId: "1001", members: [], channels: [{ id: "7901", serverId: "9901", name: "dm", voice: false, topic: "", lastId: "20000003" }],
  reads: { "7901": "20000001" }, online: ["1002"], activities: { "1002": "VALORANT" }, dmWith: "1002", memberIds: ["1001", "1002"], memberCount: 2 } as unknown as Server;
const dmHist: Msg[] = [
  { id: "20000001", channelId: "7901", authorId: "1002", content: "you on tonight?", editedAt: null, ts: Date.now() - 600000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] },
  { id: "20000002", channelId: "7901", authorId: "1001", content: "after dinner, ~9", editedAt: null, ts: Date.now() - 540000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] },
  { id: "20000003", channelId: "7901", authorId: "1002", content: "bet. bring nell", editedAt: null, ts: Date.now() - 60000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] },
];
const friends = scene === "login" ? [] : [
  { user: members[1], username: "mira", state: "friends" as const, dmServer: "9901" },
  { user: members[4], username: "nell", state: "friends" as const, dmServer: null },
  { user: members[2], username: "jun", state: "incoming" as const, dmServer: null },
  { user: members[6], username: "rosa", state: "outgoing" as const, dmServer: null },
];
const voice = scene === "voice" || scene === "chat"
  ? [{ userId: "1002", channelId: "7101", muted: false, deafened: false }, { userId: "1004", channelId: "7101", muted: true, deafened: false }, ...(scene === "voice" ? [{ userId: "1001", channelId: "7101", muted: false, deafened: false }] : [])]
  : [];
onEvent({ t: "conn", state: "online", rttMs: 0.4 });
onEvent({ t: "session", user, servers: scene === "login" ? servers : [...servers, dmServer], users: members, voice, username: "ash", friends, status: { mode: "online", emoji: "", text: "", until: 0 }, media: scene === "voice" && !lk
  ? [{ userId: "1002", channelId: "7101", source: "screen", active: true }]
  : [] });
if (scene === "voice") {
  onEvent({ t: "voice", channelId: "7101", state: "connected", muted: false, deafened: false, detail: null });
  if (!lk) import("./screen").then((m) => m.setScreen({ channelId: "7101", connected: true, shares: [{ userId: "1002", identity: "1002:screen", hasAudio: true }],
    ...(new URLSearchParams(location.search).has("watch") ? { watching: ["1002"], live: { "1002": true }, viewers: { "1002": ["1001", "1004"] } } : {}) }));
  onEvent({ t: "speaking", userIds: ["1002"] });
}
if (scene === "chat") onEvent({ t: "messages", channelId: "7003", msgs: [{ ...hist[5], id: "99999999", channelId: "7003", authorId: "1003" }] });

// Test hook (preview only).
(window as unknown as { __push: typeof onEvent }).__push = onEvent;
// The app's own module instances (a test's import() can get a stale copy after edits).
Object.assign(window, { __store: await import("./store"), __scr: await import("./screen") });
