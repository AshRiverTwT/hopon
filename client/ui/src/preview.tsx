// Dev-only design preview: mocks the Rust core and feeds a fake session.
// Not part of the production build (vite builds index.html only).
//   pnpm dev  →  http://localhost:5173/preview.html?s=chat|voice|login|empty
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Msg, Server } from "./types";

const scene = new URLSearchParams(location.search).get("s") ?? "chat";
const me = { id: "1001", name: "ash", avatarV: 1 };
const names = ["ash", "mira", "jun", "tobias", "nell", "kaito", "rosa", "ezra"];
const members = names.map((n, i) => ({ id: String(1001 + i), name: n, avatarV: i % 3 === 2 ? 0 : 1 }));
const server: Server = {
  id: "9001", name: "Night Shift", ownerId: "1001", members,
  reads: { "7003": "1", "7001": "10001997" }, online: ["1001", "1002", "1003", "1005"],
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
      editedAt: i % 97 === 0 ? ts : null, ts, nonce: "", state: 2, replyTo: null, reactions: [] });
  }
  return out;
}
const hist = history(2000);
hist.push({ id: "10001998", channelId: "7001", authorId: "1003", content: "new build is up: https://github.com/AshRiverTwT/hopon — try **voice** with `echo off` on headsets", editedAt: null, ts: Date.now() - 120000, nonce: "", state: 2, replyTo: null, reactions: [{ emoji: "🔥", users: ["1001", "1002", "1004"] }, { emoji: "👀", users: ["1005"] }] });
hist.push({ id: "10001999", channelId: "7001", authorId: "1002", content: "<@1001> nice, the dial is _so_ smooth now", editedAt: null, ts: Date.now() - 90000, nonce: "", state: 2, replyTo: "10001998", reactions: [{ emoji: "👍", users: ["1003"] }] });
hist.push({ id: "10002000", channelId: "7001", authorId: "1002", content: "Wordle 1,234 3/6\n\n⬛🟨⬛⬛⬛\n🟩🟩⬛🟩⬛\n🟩🟩🟩🟩🟩", editedAt: null, ts: Date.now() - 60000, nonce: "", state: 2, replyTo: null, reactions: [] });
hist.push({ id: "p1", channelId: "7001", authorId: me.id, content: "this one is still sending", editedAt: null, ts: Date.now(), nonce: "1", state: 0, replyTo: null, reactions: [] });
hist.push({ id: "p2", channelId: "7001", authorId: me.id, content: "and this one failed", editedAt: null, ts: Date.now(), nonce: "2", state: 3, replyTo: null, reactions: [] });

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
    case "open_channel": return scene === "chat" || scene === "voice" ? hist : [];
    case "load_older": return { msgs: [], more: false };
    case "get_config": return { url: "ws://127.0.0.1:18080/ws" };
    case "audio_devices": return { processing: { aec: false, ns: true, agc: true }, inputs: [{ id: "a", name: "Headset Microphone (Arctis 7)" }], outputs: [{ id: "b", name: "Headset Earphone (Arctis 7)" }], input: "a", output: "b", aec: "Software", ns: "Software", agc: "Software" };
    case "perf_stats": return { rows: [{ name: "text: remote input->paint (synced)", count: 600, p50_ms: 21.3, p95_ms: 28.7, p99_ms: 33.1, max_ms: 40 }], startup: { processToPaintMs: 657, mainToPaintMs: 610, mainToConnectedMs: 2.5 }, clockOffsetMs: 0.1, bestRttMs: 0.4, rssMb: 41 };
    case "create_invite": return "hopon://invite/Kq7xN2pLmA";
    case "avatar": return fakeAvatar(String((args as { userId: string }).userId));
    default: return null;
  }
});

const { onEvent } = await import("./store");
await import("./main");

const user = scene === "login" ? null : me;
const servers = scene === "empty" || scene === "login" ? [] : [server];
const voice = scene === "voice" || scene === "chat"
  ? [{ userId: "1002", channelId: "7101", muted: false, deafened: false }, { userId: "1004", channelId: "7101", muted: true, deafened: false }, ...(scene === "voice" ? [{ userId: "1001", channelId: "7101", muted: false, deafened: false }] : [])]
  : [];
onEvent({ t: "conn", state: "online", rttMs: 0.4 });
onEvent({ t: "session", user, servers, voice });
if (scene === "voice") {
  onEvent({ t: "voice", channelId: "7101", state: "connected", muted: false, deafened: false, detail: null });
  onEvent({ t: "speaking", userIds: ["1002"] });
}
if (scene === "chat") onEvent({ t: "messages", channelId: "7003", msgs: [{ ...hist[5], id: "99999999", channelId: "7003", authorId: "1003" }] });

// Test hook (preview only).
(window as unknown as { __push: typeof onEvent }).__push = onEvent;
