// Mirrors client/src-tauri/src/ui.rs. IDs are decimal strings (63-bit).
export interface User { id: string; name: string; avatarV: number }
export interface Channel { id: string; serverId: string; name: string; voice: boolean }
export interface Server { id: string; name: string; ownerId: string; channels: Channel[]; members: User[] }
export interface Msg {
  id: string; channelId: string; authorId: string; content: string;
  editedAt: number | null; ts: number; nonce: string;
  /** 0 pending, 1 delivered, 2 durable, 3 failed */
  state: number;
}
export interface Presence { userId: string; channelId: string | null; muted: boolean; deafened: boolean }

export type UiEvent =
  | { t: "conn"; state: "connecting" | "online" | "offline"; rttMs: number | null }
  | { t: "session"; user: User | null; servers: Server[]; voice: Presence[] }
  | { t: "server"; server: Server }
  | { t: "channelCreated"; channel: Channel }
  | { t: "memberJoined"; serverId: string; user: User }
  | { t: "userUpdated"; user: User }
  | { t: "messages"; channelId: string; msgs: Msg[] }
  | { t: "msgState"; channelId: string; nonce: string; id: string; state: number }
  | { t: "edited"; channelId: string; id: string; content: string; editedAt: number }
  | { t: "deleted"; channelId: string; id: string }
  | { t: "presence"; serverId: string; presence: Presence }
  | { t: "voice"; channelId: string | null; state: string; muted: boolean; deafened: boolean; detail: string | null }
  | { t: "speaking"; userIds: string[] }
  | { t: "error"; message: string };

/** Compare decimal ID strings without BigInt allocation. */
export function cmpId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
