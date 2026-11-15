// Profiles: accent colours, presence (online / idle / do not disturb /
// invisible), custom status, idle detection and the profile card's open state.
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { call } from "./ipc";
import { currentServer, s, set, toast } from "./store";
import type { Status, StatusMode } from "./types";
import { setQuietCheck } from "./sounds";

/** Profile colours: the app is black and white, so a name's colour is one of the few places colour shows (index 0 = none). */
export const ACCENTS = ["", "#ff1b50", "#ff7a4d", "#f2b84b", "#b8d65a", "#4fd1a5", "#5ab4f0", "#a58cf5", "#f283c4"];
export const ACCENT_NAMES = ["None", "Red", "Coral", "Amber", "Lime", "Mint", "Sky", "Violet", "Rose"];
export const accentIndex = (id: string) => (s.user?.id === id ? s.user.accent : s.users[id]?.accent) ?? 0;
/** The person's colour, or "" for none. */
export const accentOf = (id: string) => ACCENTS[accentIndex(id)] ?? "";

export type Shown = "online" | "idle" | "dnd" | "offline" | "invisible";
export const SHOWN_LABEL: Record<Shown, string> = { online: "Online", idle: "Idle", dnd: "Do not disturb", offline: "Offline", invisible: "Invisible" };

// A slow clock so expired custom statuses disappear on their own.
const [minute, setMinute] = createSignal(Date.now());
setInterval(() => setMinute(Date.now()), 30_000);

const [idle, setIdle] = createSignal(false);
/** This device is idle (after IDLE_S without input, and not in voice or a game). */
export const idleNow = idle;

/** How someone shows up right now, as everyone else sees it (you also see "invisible"). */
export function presenceOf(id: string): Shown {
  if (id === s.user?.id) {
    if (s.conn.state !== "online") return "offline";
    const m = s.myStatus.mode;
    if (m === "invisible" || m === "dnd") return m;
    return idle() ? "idle" : "online";
  }
  if (!s.online[id]) return "offline";
  const m = s.statuses[id]?.mode;
  return m === "idle" || m === "dnd" ? m : "online";
}

/** Someone's custom status if set, unexpired and visible (online). */
export function customOf(id: string): Status | null {
  const st = id === s.user?.id ? s.myStatus : s.online[id] ? s.statuses[id] : undefined;
  if (!st || (!st.text && !st.emoji)) return null;
  if (st.until && st.until <= Math.max(minute(), Date.now() - 60_000)) return null;
  return st;
}

/** Do not disturb: no notifications and no sounds. */
export const dnd = () => s.myStatus.mode === "dnd";
setQuietCheck(dnd);

/** Change your presence and/or custom status (shown immediately, saved to the account). */
export async function setStatus(patch: Partial<Status>) {
  const prev = { ...s.myStatus };
  const next = { ...prev, ...patch };
  if (next.mode === "idle") next.mode = "online";
  set("myStatus", next);
  try { await call("set_status", { mode: next.mode, emoji: next.emoji, text: next.text, until: next.until }); }
  catch (e) { set("myStatus", prev); toast(String(e).replace(/^Error: /, "")); }
}
export const setMode = (mode: StatusMode) => setStatus({ mode });
export const clearCustom = () => setStatus({ emoji: "", text: "", until: 0 });

// ---------- idle ----------

const IDLE_S = 10 * 60;
let lastInput = Date.now();
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true });

const playing = () => { const me = s.user?.id; return !!me && s.servers.some((sv) => !!sv.activities?.[me]); };

async function checkIdle() {
  if (!s.user || s.conn.state !== "online") return;
  // System-wide input where the OS tells us (Windows), so gaming isn't idle;
  // otherwise input in HopOn, with voice and a detected game counting as active.
  const sys = await call<number | null>("idle_seconds").catch(() => null);
  const secs = typeof sys === "number" ? sys : (Date.now() - lastInput) / 1000;
  const next = secs >= IDLE_S && !s.voice.channelId && !playing();
  if (next !== idle()) {
    setIdle(next);
    call("set_idle", { idle: next }).catch(() => {});
  }
}

let started = false;
export function startIdleWatch() {
  if (started) return;
  started = true;
  setInterval(() => void checkIdle(), 15_000);
  createRoot(() => {
    // The server forgets a device's idle state when the connection drops.
    createEffect(on(() => s.conn.state, (st) => { if (st === "online" && idle()) call("set_idle", { idle: true }).catch(() => {}); }));
  });
}

// ---------- profile card ----------

export interface CardAt { userId: string; serverId: string | null; rect: { left: number; top: number; right: number; bottom: number } }
const [card, setCard] = createSignal<CardAt | null>(null);
export const profileCard = card;
export const closeProfile = () => setCard(null);

/** Open someone's profile card next to the element that was clicked. */
export function openProfile(userId: string, el: Element, e?: MouseEvent) {
  e?.stopPropagation();
  if (card()?.userId === userId) return void setCard(null);
  const r = el.getBoundingClientRect();
  const sv = currentServer();
  setCard({ userId, serverId: sv && !sv.dmWith ? sv.id : null, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
}

// ---------- images ----------

const banners = new Map<string, string | null>();
const [bannerTick, setBannerTick] = createSignal(0);
/** Banner data URL for (user, version), fetched once and cached by the core. */
export function bannerUrl(userId: string, v: number): string | null {
  bannerTick();
  if (!v) return null;
  const k = `${userId}:${v}`;
  if (!banners.has(k)) {
    banners.set(k, null);
    call<string | null>("banner", { userId, v })
      .then((u) => { banners.set(k, u); setBannerTick((n) => n + 1); })
      .catch(() => setTimeout(() => banners.delete(k), 30_000));
  }
  return banners.get(k) ?? null;
}

/** Center-crop a picked image to 3:1 and downscale to 600 × 200 WebP bytes. */
export async function toBannerBytes(file: File): Promise<number[]> {
  const bmp = await createImageBitmap(file);
  const W = 600, H = 200;
  const scale = Math.max(W / bmp.width, H / bmp.height);
  const sw = W / scale, sh = H / scale;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, W, H);
  bmp.close();
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", q));
    if (blob && blob.size <= 56 * 1024) return [...new Uint8Array(await blob.arrayBuffer())];
  }
  throw new Error("image too large after compression");
}

/** "Member since" style date. */
export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

/** When a custom status clears, for the picker: "", "1h", "4h", "today". */
export function untilFor(choice: string): number {
  const now = Date.now();
  if (choice === "30m") return now + 30 * 60_000;
  if (choice === "1h") return now + 60 * 60_000;
  if (choice === "4h") return now + 4 * 60 * 60_000;
  if (choice === "today") { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }
  return 0;
}

/** What someone is playing (from any server you share), or "". */
export function gameOf(userId: string): string {
  for (const sv of s.servers) { const g = sv.activities?.[userId]; if (g) return g; }
  return "";
}

// ---------- profile editor ----------

const [editor, setEditor] = createSignal(false);
export const profileEditorOpen = editor;
export const openProfileEditor = () => { setCard(null); setEditor(true); };
export const closeProfileEditor = () => setEditor(false);
