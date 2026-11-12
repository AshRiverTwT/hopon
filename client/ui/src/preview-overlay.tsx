// Dev-only: the in-game overlay with a mocked core (not in the build).
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Msg, Server } from "./types";

const names = ["ash", "mira", "jun", "tobias", "nell"];
const members = names.map((n, i) => ({ id: String(1001 + i), name: n, avatarV: 1 }));
const server: Server = {
  id: "9001", name: "Night Shift", ownerId: "1001", memberIds: members.map((m) => m.id), memberCount: members.length, reads: {}, online: ["1001", "1002", "1003"], activities: {},
  channels: [{ id: "7001", serverId: "9001", name: "general", voice: false, topic: "", lastId: "0" }, { id: "7101", serverId: "9001", name: "Lounge", voice: true, topic: "", lastId: "0" }],
};
const t = Date.now();
const m = (id: string, a: string, content: string, k: number): Msg => ({ id, channelId: "7001", authorId: a, content, editedAt: null, ts: t - k * 20000, nonce: "", state: 2, replyTo: null, reactions: [], attachments: [] });
const msgs = [
  m("10000001", "1003", "anyone up for ranked after this", 6),
  m("10000002", "1002", "yes. give me 5", 5),
  m("10000003", "1002", "need to finish this match first", 4),
  m("10000004", "0", "Welcome aboard, <@1005>!", 3),
  m("10000005", "1005", "hiii 👋", 2),
  m("10000006", "1004", "<@1001> you're up next, bring snacks", 1),
];
function fakeAvatar(id: string): string {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!; const h = (Number(id) * 47) % 360;
  const gr = g.createLinearGradient(0, 0, 64, 64);
  gr.addColorStop(0, `hsl(${h} 45% 55%)`); gr.addColorStop(1, `hsl(${(h + 60) % 360} 50% 25%)`);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(32, 26, 11, 0, 7); g.fill(); g.beginPath(); g.arc(32, 62, 22, 0, 7); g.fill();
  return c.toDataURL();
}
mockIPC((cmd, args) => {
  if (cmd === "overlay_context") return { channelId: "7001", msgs };
  if (cmd === "avatar") return fakeAvatar(String((args as { userId: string }).userId));
  if (cmd === "get_config") return { url: "wss://hopon-chat.duckdns.org/ws" };
  return null;
});
await import("./overlay");
const push = (window as unknown as { __ovPush: (e: unknown) => void }).__ovPush;
push({ t: "session", user: members[0], servers: [server], users: members, voice: ["1001", "1002", "1003", "1004"].map((u, i) => ({ userId: u, channelId: "7101", muted: i === 3, deafened: false })) });
push({ t: "speaking", userIds: ["1002"] });
