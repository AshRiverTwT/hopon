// Where attachment media lives: uploads on the chat server, GIFs on the
// provider's CDN (already absolute URLs).
import { createSignal } from "solid-js";
import { call } from "./ipc";
import type { Attachment } from "./types";

const [base, setBase] = createSignal("");

function toHttp(ws: string) {
  const m = ws.match(/^(wss?):\/\/([^/]+)/);
  return m ? `${m[1] === "wss" ? "https" : "http"}://${m[2]}` : "";
}

/** Refresh after the server address changes. */
export function loadMediaBase() {
  call<{ url: string }>("get_config").then((c) => setBase(toHttp(c?.url ?? ""))).catch(() => {});
}
loadMediaBase();

export const mediaUrl = (a: Attachment) => a.url || `${base()}/files/${a.id}`;
export const isImage = (a: Attachment) => a.mime.startsWith("image/");
export const isVideo = (a: Attachment) => a.mime.startsWith("video/");
/** Provider GIFs (sent as looping silent video or GIF). */
export const isGif = (a: Attachment) => !!a.url || a.mime === "image/gif";

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}

/** Display box for media: fits in maxW × maxH, keeps the aspect ratio. */
export function fitBox(w: number, h: number, maxW = 420, maxH = 320) {
  if (!w || !h) return { w: Math.min(maxW, 320), h: 200 };
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(48, Math.round(w * k)), h: Math.max(32, Math.round(h * k)) };
}
