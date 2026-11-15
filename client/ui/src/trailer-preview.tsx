// Dev-only: the app with curated content for filming the trailer
// (marketing/trailer). Like preview.tsx, it mocks the Rust core; nothing here
// ships (vite builds index.html and overlay.html only).
//   pnpm dev  →  http://localhost:5173/trailer.html
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Msg, Server } from "./types";
import { encodePoll } from "./polls";

const me = { id: "1001", name: "ash", avatarV: 1, accent: 2, status: "" };
const people: [string, number][] = [["ash", 2], ["mira", 8], ["jun", 6], ["tobias", 4], ["nell", 7], ["kaito", 5], ["rosa", 3], ["ezra", 1]];
const members = people.map(([name, accent], i) => ({ id: String(1001 + i), name, avatarV: 1, accent, status: "" }));
const id = (name: string) => members.find((m) => m.name === name)!.id;

/** Sharp, geometric avatars in each person's colour. */
const HUES = [0, 348, 18, 40, 82, 160, 205, 262, 330];
function avatar(userId: string): string {
  const i = Number(userId) - 1001;
  const c = document.createElement("canvas"); c.width = c.height = 96;
  const g = c.getContext("2d")!;
  const hue = HUES[members[i]?.accent ?? 0];
  g.fillStyle = `hsl(${hue} 72% 56%)`; g.fillRect(0, 0, 96, 96);
  g.fillStyle = "#0b0b0c";
  const v = i % 4;
  if (v === 0) { g.fillRect(48, 0, 48, 48); g.fillRect(0, 48, 48, 48); }
  else if (v === 1) { g.fillRect(0, 60, 96, 36); g.fillStyle = "#ededee"; g.fillRect(30, 18, 36, 36); }
  else if (v === 2) { for (let k = 0; k < 4; k++) g.fillRect(k * 24, 0, 12, 96); }
  else { g.fillRect(0, 0, 96, 96); g.fillStyle = `hsl(${hue} 72% 56%)`; g.fillRect(16, 16, 64, 64); g.fillStyle = "#ededee"; g.fillRect(40, 40, 16, 16); }
  return c.toDataURL();
}
function banner(userId: string): string {
  const i = Number(userId) - 1001;
  const hue = HUES[members[i]?.accent ?? 0];
  const c = document.createElement("canvas"); c.width = 600; c.height = 200;
  const g = c.getContext("2d")!;
  g.fillStyle = "#101011"; g.fillRect(0, 0, 600, 200);
  for (let x = 0; x < 600; x += 24) for (let y = 0; y < 200; y += 24) {
    const d = Math.hypot(x - 470, y - 70);
    if (d < 170) { g.fillStyle = `hsla(${hue} 80% 60% / ${Math.max(0, 1 - d / 170)})`; g.fillRect(x, y, 10, 10); }
  }
  return c.toDataURL("image/png");
}

const ch = (cid: string, name: string, voice = false, topic = "", lastId = "0") => ({ id: cid, serverId: "9001", name, voice, topic, lastId });
const nightShift: Server = {
  id: "9001", name: "Night Shift", ownerId: me.id, memberIds: members.map((m) => m.id), memberCount: members.length,
  reads: { "7001": "10000099", "7003": "1" }, online: ["1001", "1002", "1003", "1004", "1005", "1006", "1007"],
  activities: { [id("mira")]: "Chess", [id("tobias")]: "Minute Cryptic" },
  statuses: {
    [id("jun")]: { mode: "idle", emoji: "", text: "", until: 0 },
    [id("nell")]: { mode: "dnd", emoji: "", text: "rendering, back at 10", until: 0 },
    [id("kaito")]: { mode: "online", emoji: "🎧", text: "lo-fi on repeat", until: 0 },
  },
  channels: [ch("7001", "general", false, "After hours, mostly."), ch("7002", "design"), ch("7003", "clips", false, "", "99999999"), ch("7004", "music"),
    ch("7101", "Lounge", true), ch("7102", "Late Room", true), ch("7103", "Duo Queue", true)],
} as unknown as Server;
const other = (sid: string, name: string, unread = false): Server => ({ id: sid, name, ownerId: "1002", memberIds: [me.id, id("mira"), id("kaito"), id("rosa")], memberCount: 4, reads: {}, online: [me.id, id("mira"), id("kaito")], activities: {}, statuses: {},
  channels: [{ id: `${sid}1`, serverId: sid, name: "general", voice: false, topic: "", lastId: unread ? "30000001" : "0" }, { id: `${sid}2`, serverId: sid, name: "lobby", voice: false, topic: "", lastId: "0" },
    { id: `${sid}3`, serverId: sid, name: "Voice", voice: true, topic: "", lastId: "0" }] } as unknown as Server);
const servers = [other("8990", "Arcade Club"), other("8995", "Late Lab", true), nightShift, other("9010", "Tea Break"), other("9020", "Bug Bash", true), other("9030", "The Basement")];

let seq = 10_000_000;
const t0 = Date.now() - 40 * 60_000;
const msg = (who: string, content: string, mins: number, extra: Partial<Msg> = {}): Msg => ({
  id: String(seq++), channelId: "7001", authorId: id(who), content, editedAt: null, ts: t0 + mins * 60_000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [], ...extra,
});
const hist: Msg[] = [
  msg("mira", "who's around tonight?", 0),
  msg("tobias", "after 9 for sure", 1),
  msg("nell", "same. finishing a render first", 2),
  msg("kaito", "the new dial is so smooth", 6, { reactions: [{ emoji: "🔥", users: [id("mira"), id("ash"), id("rosa")] }] }),
  msg("jun", "Wordle 1,412 3/6\n\n⬛🟨⬛⬛⬛\n🟩🟩⬛🟩⬛\n🟩🟩🟩🟩🟩", 9),
];
const wordle = hist[hist.length - 1].id;
hist.push(
  msg("mira", "3/6 again?? teach me", 10, { replyTo: wordle, reactions: [{ emoji: "😂", users: [id("jun"), id("ash")] }] }),
  msg("rosa", encodePoll({ question: "Tonight?", options: ["Movie night", "Games", "Both, obviously"] }), 14,
    { reactions: [{ emoji: "1️⃣", users: [id("nell")] }, { emoji: "2️⃣", users: [id("tobias"), id("kaito")] }, { emoji: "3️⃣", users: [id("mira"), id("rosa"), id("ezra"), id("ash")] }] }),
  msg("ash", "lounge in 10, bring snacks", 18),
  msg("ezra", `<@${me.id}> saved you a seat`, 19),
);

// The other channels and servers have a little life too (the dial and rail pass through them).
const small = (channelId: string, rows: [string, string][]): Msg[] => rows.map(([who, content], i) => ({ ...msg(who, content, 20 + i), channelId }));
const histories: Record<string, Msg[]> = {
  "7001": hist,
  "7002": small("7002", [["nell", "new poster draft is up"], ["rosa", "the grid on this is so clean"], ["kaito", "type is perfect"], ["nell", "v2 tomorrow"]]),
  "7003": small("7003", [["tobias", "that clutch last night"], ["mira", "replayed it like 6 times"], ["jun", "frame perfect"], ["ezra", "send the full vod"]]),
  "7004": small("7004", [["kaito", "playlist for tonight"], ["rosa", "adding two"], ["kaito", "no skips allowed"]]),
};
const generic = (channelId: string): Msg[] => small(channelId, [["mira", "anyone on?"], ["ash", "in 5"], ["mira", "bet"]]);

mockIPC((cmd, args) => {
  const a = (args ?? {}) as Record<string, string>;
  switch (cmd) {
    case "open_channel": return histories[a.channelId] ?? (a.channelId.endsWith("1") ? generic(a.channelId) : []);
    case "load_older": return { msgs: [], more: false };
    case "get_config": return { url: "wss://hopon.example/ws" };
    case "avatar": return avatar(String(a.userId));
    case "banner": return banner(String(a.userId));
    case "get_profile": {
      const u = members.find((m) => m.id === String(a.userId)) ?? me;
      const bios: Record<string, string> = { mira: "Chess at 2am. Duo queue after 9.", nell: "3D, mostly. Will render for snacks.", kaito: "Always has a playlist." };
      return { user: u, username: u.name, bio: bios[u.name] ?? "", bannerV: 1, createdAt: Date.UTC(2025, 2, 14), joinedAt: Date.UTC(2025, 5, 2) };
    }
    case "idle_seconds": return null;
    case "update_check": return { current: "0.8.0", latest: "0.8.0", available: false, notes: "" };
    case "screen_grant": return new Promise(() => {});
    case "audio_devices": return { processing: { aec: false, ns: true, agc: true }, inputs: [], outputs: [], input: null, output: null };
    default: return null;
  }
});

const { onEvent } = await import("./store");
await import("./main");

const dm: Server = { id: "9901", name: "", ownerId: me.id, members: [], channels: [{ id: "7901", serverId: "9901", name: "dm", voice: false, topic: "", lastId: "0" }],
  reads: {}, online: [id("mira")], activities: {}, dmWith: id("mira"), memberIds: [me.id, id("mira")], memberCount: 2 } as unknown as Server;
const friends = [
  { user: members[1], username: "mira", state: "friends" as const, dmServer: "9901" },
  { user: members[4], username: "nell", state: "friends" as const, dmServer: null },
  { user: members[5], username: "kaito", state: "friends" as const, dmServer: null },
];
onEvent({ t: "prefs", json: JSON.stringify({ lastServer: "9001" }) });
onEvent({ t: "conn", state: "online", rttMs: 0.4 });
onEvent({ t: "session", user: me, servers: [...servers, dm], users: members, username: "ash", friends, status: { mode: "online", emoji: "", text: "", until: 0 },
  voice: [{ userId: id("mira"), channelId: "7101", muted: false, deafened: false }, { userId: id("tobias"), channelId: "7101", muted: false, deafened: false },
    { userId: id("nell"), channelId: "7101", muted: true, deafened: false }],
  media: [{ userId: id("mira"), channelId: "7101", source: "screen", active: true }] });

Object.assign(window, { __push: onEvent, __store: await import("./store"), __scr: await import("./screen"), __ids: Object.fromEntries(members.map((m) => [m.name, m.id])) });
