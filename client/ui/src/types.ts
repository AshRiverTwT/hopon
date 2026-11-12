// Mirrors client/src-tauri/src/ui.rs. IDs are decimal strings (63-bit).
export interface User { id: string; name: string; avatarV: number }
export interface Channel { id: string; serverId: string; name: string; voice: boolean; topic: string; lastId: string }
export interface Server { id: string; name: string; ownerId: string; channels: Channel[]; members: User[]; reads: Record<string, string>; online: string[];
  /** user → game they're playing right now */
  activities: Record<string, string> }
export interface Msg {
  id: string; channelId: string; authorId: string; content: string;
  editedAt: number | null; ts: number; nonce: string;
  /** 0 pending, 1 delivered, 2 durable, 3 failed */
  state: number;
  replyTo: string | null;
  reactions: { emoji: string; users: string[] }[];
  attachments: Attachment[];
}
/** `url` empty = served by the chat server at /files/{id} (see media.ts). */
export interface Attachment { id: string; name: string; mime: string; size: number; width: number; height: number; url: string; preview: string }
export interface Gif { id: string; title: string; preview: string; width: number; height: number }
/** Author id of server-written messages (welcomes). */
export const SYSTEM_USER = "0";
export interface Presence { userId: string; channelId: string | null; muted: boolean; deafened: boolean }

export type UiEvent =
  | { t: "conn"; state: "connecting" | "online" | "offline"; rttMs: number | null }
  | { t: "session"; user: User | null; servers: Server[]; voice: Presence[] }
  | { t: "server"; server: Server }
  | { t: "channelCreated"; channel: Channel }
  | { t: "memberJoined"; serverId: string; user: User }
  | { t: "userUpdated"; user: User }
  | { t: "serverRemoved"; serverId: string; reason: "deleted" | "kicked" | "left" }
  | { t: "channelDeleted"; serverId: string; channelId: string }
  | { t: "readUpdated"; channelId: string; lastRead: string }
  | { t: "reaction"; channelId: string; messageId: string; emoji: string; userId: string; add: boolean }
  | { t: "mentioned"; channelId: string }
  | { t: "typing"; channelId: string; userId: string }
  | { t: "prefs"; json: string }
  | { t: "userPresence"; userId: string; online: boolean }
  | { t: "activity"; userId: string; game: string }
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
