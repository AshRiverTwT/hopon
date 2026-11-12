// Message notifications. Two kinds:
//  - in-app banners (top right) for messages in other channels while you're
//    looking at HopOn;
//  - Windows notifications while HopOn is in the background or in the tray.
// Each channel notifies for all messages, only @mentions, or nothing
// (bell in the channel header). Runs on event arrival, not in the rAF queue,
// so it also works while the window is hidden (no frames are drawn then).
import { createStore, produce } from "solid-js/store";
import { call } from "./ipc";
import { prefs, type NotifyLevel } from "./prefs";
import { mentionsUser, preview } from "./rich";
import { SYSTEM_USER, type Msg } from "./types";

export interface Banner { key: number; channelId: string; messageId: string; title: string; body: string; mention: boolean }

export const [notes, setNotes] = createStore({ banners: [] as Banner[] });

const BANNER_MS = 6000;
const MAX_BANNERS = 3;
/** Older than this is history (reconnect backfill), not news. */
const FRESH_MS = 60_000;
const seen = new Set<string>();
let bannerKey = 0;

export const channelLevel = (channelId: string): NotifyLevel => prefs.channelNotify[channelId] ?? "all";

export interface NotifyCtx {
  me: string | null;
  /** channel you have open (null while on a voice room) */
  openChannel: string | null;
  channelName: (id: string) => string;
  serverName: (channelId: string) => string;
  userName: (id: string) => string;
}

/** HopOn is what you're looking at (focused and visible). */
const looking = () => document.hasFocus() && !document.hidden;

export function onMessages(channelId: string, msgs: Msg[], ctx: NotifyCtx) {
  if (!ctx.me) return;
  const level = channelLevel(channelId);
  if (level === "none") return;
  const now = Date.now();
  for (const m of msgs) {
    if (m.id.startsWith("p") || m.authorId === ctx.me || m.authorId === SYSTEM_USER) continue;
    if (now - m.ts > FRESH_MS || seen.has(m.id)) continue;
    seen.add(m.id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    const mention = mentionsUser(m.content, ctx.me);
    if (level === "mentions" && !mention) continue;
    const watching = looking() && channelId === ctx.openChannel;
    if (watching) continue;
    const author = ctx.userName(m.authorId);
    const text = preview(m.content, ctx.userName) || (m.attachments.length ? `sent ${m.attachments.length === 1 ? "a file" : `${m.attachments.length} files`}` : "");
    const where = `#${ctx.channelName(channelId)}`;
    if (looking()) {
      if (!prefs.appNotify) continue;
      pushBanner({ channelId, messageId: m.id, title: `${author} · ${where}`, body: text, mention });
      if (prefs.notifySound) ping(mention);
    } else if (prefs.systemNotify) {
      call("notify", { title: `${author} · ${where} · ${ctx.serverName(channelId)}`, body: text, sound: prefs.notifySound, channelId }).catch(() => {});
    }
  }
}

function pushBanner(b: Omit<Banner, "key">) {
  const key = ++bannerKey;
  setNotes("banners", (l) => [...l.filter((x) => x.channelId !== b.channelId), { ...b, key }].slice(-MAX_BANNERS));
  window.setTimeout(() => dismissBanner(key), BANNER_MS);
}

export function dismissBanner(key: number) {
  setNotes("banners", produce((l) => { const i = l.findIndex((x) => x.key === key); if (i >= 0) l.splice(i, 1); }));
}

/** Opening a channel clears its banners. */
export function clearBanners(channelId: string) {
  if (notes.banners.some((b) => b.channelId === channelId)) setNotes("banners", (l) => l.filter((b) => b.channelId !== channelId));
}

/** Short two-note blip, synthesized; the audio context closes right after. */
function ping(mention: boolean) {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    const notes = mention ? [880, 1174.7] : [784];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.08);
      g.gain.linearRampToValueAtTime(0.08, t + i * 0.08 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.08 + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.08);
      o.stop(t + i * 0.08 + 0.2);
    });
    window.setTimeout(() => void ctx.close(), 500);
  } catch {}
}
