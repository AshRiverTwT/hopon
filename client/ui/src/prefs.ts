// Account preferences. Source of truth is the server (they follow your
// account to any device); localStorage is only a cache for instant startup.
// Device-specific settings (audio devices) are NOT here: they stay local.
import { createStore } from "solid-js/store";
import { call } from "./ipc";
import { DEFAULT_HOTKEYS, type Action } from "./hotkeys";

export interface Prefs {
  sounds: boolean;
  ptt: boolean;
  pttKey: number;
  aec: boolean;
  ns: boolean;
  agc: boolean;
  game: string;
  recentEmoji: string[];
  lastServer: string | null;
  /** server id → last open channel id */
  lastChannel: Record<string, string>;
  /** UI scale, 1 = 100 %. */
  scale: number;
  /** action → key combo ("Ctrl+Alt+ArrowDown"); "" = unbound. */
  hotkeys: Record<Action, string>;
}

export const DEFAULT_PREFS: Prefs = {
  sounds: true, ptt: false, pttKey: 0, aec: true, ns: true, agc: true,
  game: "wordle", recentEmoji: [], lastServer: null, lastChannel: {},
  scale: 1, hotkeys: { ...DEFAULT_HOTKEYS },
};

export const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5];

/** Defaults + saved values; nested maps merge per key so new actions get defaults. */
function withDefaults(p: Partial<Prefs>): Prefs {
  return { ...DEFAULT_PREFS, ...p, hotkeys: { ...DEFAULT_HOTKEYS, ...(p.hotkeys ?? {}) }, lastChannel: { ...(p.lastChannel ?? {}) } };
}

const CACHE_KEY = "prefs";

function fromCache(): Prefs {
  try { return withDefaults(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}")); } catch { return withDefaults({}); }
}

export const [prefs, setPrefsStore] = createStore<Prefs>(fromCache());

let saveTimer = 0;
let loaded = false;
/** Last payload received from the server; repeats are ignored. */
let lastIncoming: string | null = null;

/** Older builds kept a few settings in separate localStorage keys. */
function legacyLocal(): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  try {
    const g = (k: string) => localStorage.getItem(k);
    if (g("sounds") !== null) out.sounds = g("sounds") !== "0";
    if (g("ptt") !== null) out.ptt = g("ptt") === "1";
    if (g("pttKey") !== null) out.pttKey = Number(g("pttKey")) || 0;
    if (g("game") !== null) out.game = g("game")!;
    if (g("lastServer") !== null) out.lastServer = g("lastServer");
  } catch {}
  return out;
}

/** Push audio-related prefs into the core (voice processing, push-to-talk). */
function applyToCore(p: Prefs) {
  call("audio_processing", { aec: p.aec, ns: p.ns, agc: p.agc }).catch(() => {});
  call("voice_ptt", { enabled: p.ptt, keyCode: p.pttKey }).catch(() => {});
  applyScale(p.scale);
  call("overlay_hotkey", { combo: p.hotkeys.overlay ?? "" }).catch(() => {});
}

/** Zoom the whole window (games view follows via its bounds). */
export function applyScale(scale: number) {
  call("set_zoom", { scale }).catch(() => {});
}

/**
 * Prefs from the server (login, or another device saved). An account that
 * has never saved prefs adopts this device's settings and uploads them.
 */
export function applyPrefs(json: string) {
  // The same payload can arrive twice (snapshot + buffered event): applying
  // it again would undo changes made since, e.g. the server just opened.
  if (loaded && json === lastIncoming) return;
  lastIncoming = json;
  let incoming: Partial<Prefs> = {};
  try { incoming = json ? JSON.parse(json) : {}; } catch {}
  const fresh = Object.keys(incoming).length === 0;
  // A fresh account starts from defaults (never another account's cached
  // prefs), plus a one-time import of settings from older builds.
  const merged: Prefs = fresh ? withDefaults(legacyLocal()) : withDefaults(incoming);
  setPrefsStore(merged);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(merged)); } catch {}
  loaded = true;
  applyToCore(merged);
  if (fresh) {
    call("save_prefs", { json: JSON.stringify(merged) }).catch(() => {});
    try { for (const k of ["sounds", "ptt", "pttKey", "game", "lastServer"]) localStorage.removeItem(k); } catch {}
  }
}

/** Logged out: forget the account's prefs on this device. */
export function resetPrefs() {
  clearTimeout(saveTimer);
  loaded = false;
  lastIncoming = null;
  setPrefsStore(withDefaults({}));
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}

/** Change prefs; saved to the account (debounced) and cached locally. */
export function setPrefs(patch: Partial<Prefs>) {
  setPrefsStore(patch);
  const snapshot = JSON.stringify(prefs);
  try { localStorage.setItem(CACHE_KEY, snapshot); } catch {}
  if (!loaded) return; // not logged in yet: nothing to save to
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => call("save_prefs", { json: JSON.stringify(prefs) }).catch(() => {}), 800);
}
