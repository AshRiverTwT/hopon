// App updates from the downloads branch (latest.json + installer, verified by
// SHA-256 in the core). Checked at startup and every 6 hours; forced when the
// server refuses this app's protocol version ("Update needed").
import { createStore } from "solid-js/store";
import { call } from "./ipc";

export const [upd, setUpd] = createStore({
  checked: false,
  available: false,
  current: __APP_VERSION__,
  latest: "",
  notes: "",
  installing: false,
  error: "",
});

export async function checkUpdate() {
  try {
    const r = await call<{ current: string; latest: string; available: boolean; notes: string }>("update_check");
    setUpd({ checked: true, available: r.available, latest: r.latest, notes: r.notes, error: "" });
  } catch (e) {
    setUpd({ checked: true, error: String(e) });
  }
  return upd.available;
}

/** Download, verify, install silently; HopOn closes and reopens. */
export async function installUpdate() {
  if (upd.installing) return;
  setUpd({ installing: true, error: "" });
  try {
    await call("update_install");
  } catch (e) {
    setUpd({ installing: false, error: String(e) });
  }
}

let started = false;
export function startUpdateChecks() {
  if (started) return;
  started = true;
  void checkUpdate();
  setInterval(() => void checkUpdate(), 6 * 3600_000);
}
