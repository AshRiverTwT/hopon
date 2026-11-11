// Account preferences. Source of truth is the server (they follow your
// account to any device); localStorage is only a cache for instant startup.
// Device-specific settings (audio devices) are NOT here: they stay local.
import { createStore } from "solid-js/store";
import { call } from "./ipc";

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
}

export const DEFAULT_PREFS: Prefs = {
  sounds: true, ptt: false, pttKey: 0, aec: true, ns: true, agc: true,
  game: "wordle", recentEmoji: [], lastServer: null, lastChannel: {},
};

const CACHE_KEY = "prefs";

function fromCache(): Prefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") }; } catch { return { ...DEFAULT_PREFS }; }
}

export const [prefs, setPrefsStore] = createStore<Prefs>(fromCache());

let saveTimer = 0;
let loaded = false;

/** Apply prefs from the server (on login). Unknown/missing keys keep defaults. */
export function loadPrefs(json: string) {
  let incoming: Partial<Prefs> = {};
  try { incoming = json ? JSON.parse(json) : {}; } catch {}
  const merged = { ...DEFAULT_PREFS, ...incoming };
  setPrefsStore(merged);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(merged)); } catch {}
  loaded = true;
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
