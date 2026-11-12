// Settings as a cascading drill-down menu: CATEGORY > option < VALUE >.
// Keyboard: ↑/↓ move, → / Enter go deeper or cycle, ← go back / cycle back.
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { call } from "../ipc";
import { s, toast } from "../store";
import { applyScale, prefs, SCALES, setPrefs } from "../prefs";
import { ACTIONS, comboLabel, comboOf, RESERVED, type Action } from "../hotkeys";
import { toAvatarBytes } from "./Avatar";

interface Devices {
  processing: { aec: boolean; ns: boolean; agc: boolean };
  inputs: { id: string; name: string }[];
  outputs: { id: string; name: string }[];
  input: string | null;
  output: string | null;
}

interface Opt {
  label: string;
  value: () => string;
  /** Cycle by ±1, or activate (dir 0). */
  step: (dir: -1 | 0 | 1) => void;
}

const vkName = (vk: number) => {
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`;
  const named: Record<number, string> = { 0x14: "Caps Lock", 0x20: "Space", 0xc0: "`", 0x12: "Alt", 0x11: "Ctrl", 0x10: "Shift", 0x05: "Mouse 4", 0x06: "Mouse 5" };
  return named[vk] ?? (vk >= 0x30 && vk <= 0x5a ? String.fromCharCode(vk) : `Key ${vk}`);
};

export default function Settings(p: { close: () => void }) {
  const err = (e: unknown) => toast(String(e));
  const [devs, { mutate }] = createResource(() => call<Devices>("audio_devices").catch(() => null));
  const [cfg] = createResource(() => call<{ url: string }>("get_config"));
  const ptt = () => prefs.ptt;
  const pttKey = () => prefs.pttKey;
  /** Waiting for a key: "ptt" or a hotkey action. */
  const [capturing, setCapturing] = createSignal<null | "ptt" | Action>(null);
  let fileInput!: HTMLInputElement;

  const savePtt = (en: boolean, k: number) => {
    setPrefs({ ptt: en, pttKey: k });
    call("voice_ptt", { enabled: en, keyCode: k }).catch(err);
  };
  const onOff = (b: boolean) => (b ? "On" : "Off");
  const cycleDevice = (input: boolean, dir: number) => {
    const d = devs(); if (!d) return;
    const list = [{ id: "", name: "System default" }, ...(input ? d.inputs : d.outputs)];
    const cur = (input ? d.input : d.output) ?? "";
    const i = Math.max(0, list.findIndex((x) => x.id === cur));
    const next = list[(i + (dir || 1) + list.length) % list.length];
    call("audio_set_device", { input, id: next.id || null }).catch(err);
    mutate({ ...d, [input ? "input" : "output"]: next.id || null });
  };
  const deviceName = (input: boolean) => {
    const d = devs(); if (!d) return "Unavailable";
    const id = input ? d.input : d.output;
    return (input ? d.inputs : d.outputs).find((x) => x.id === id)?.name ?? "System default";
  };
  const stepScale = (dir: number) => {
    const i = Math.max(0, SCALES.indexOf(prefs.scale) < 0 ? SCALES.indexOf(1) : SCALES.indexOf(prefs.scale));
    let j = i + (dir || 1);
    if (dir === 0 && j >= SCALES.length) j = 0; // Enter cycles
    setScale(SCALES[Math.min(SCALES.length - 1, Math.max(0, j))]);
  };
  const setScale = (v: number) => { setPrefs({ scale: v }); applyScale(v); };
  const bindHotkey = (a: Action, combo: string) => {
    const hk = { ...prefs.hotkeys };
    const other = combo ? (Object.keys(hk) as Action[]).find((k) => k !== a && hk[k] === combo) : undefined;
    if (other) { hk[other] = ""; toast(`${comboLabel(combo)} moved from "${ACTIONS.find((x) => x.id === other)?.label}"`); }
    hk[a] = combo;
    setPrefs({ hotkeys: hk });
    if (a === "overlay" || other === "overlay") call("overlay_hotkey", { combo: hk.overlay }).catch(err);
  };
  const setProc = (k: "aec" | "ns" | "agc") => {
    setPrefs({ [k]: !prefs[k] });
    call("audio_processing", { aec: prefs.aec, ns: prefs.ns, agc: prefs.agc }).catch(err);
  };

  const cats = createMemo<{ name: string; opts: Opt[] }[]>(() => [
    { name: "Profile", opts: [
      { label: "Picture", value: () => (s.user?.avatarV ? "Change" : "Upload"), step: () => fileInput.click() },
      { label: "Remove picture", value: () => (s.user?.avatarV ? "Remove" : "—"), step: (d) => { if (d === 0 && s.user?.avatarV) call("set_avatar", { data: [] }).catch(err); } },
      { label: "Name", value: () => s.user?.name ?? "", step: () => {} },
    ] },
    { name: "Audio", opts: [
      { label: "Microphone", value: () => deviceName(true), step: (d) => cycleDevice(true, d) },
      { label: "Output", value: () => deviceName(false), step: (d) => cycleDevice(false, d) },
      { label: "Join / leave sounds", value: () => onOff(prefs.sounds), step: () => setPrefs({ sounds: !prefs.sounds }) },
    ] },
    { name: "Voice", opts: [
      { label: "Echo cancellation · off for headsets", value: () => onOff(prefs.aec), step: () => setProc("aec") },
      { label: "Noise suppression", value: () => onOff(prefs.ns), step: () => setProc("ns") },
      { label: "Auto gain", value: () => onOff(prefs.agc), step: () => setProc("agc") },
    ] },
    { name: "Controls", opts: [
      { label: "Push to talk", value: () => onOff(ptt()), step: () => savePtt(!ptt(), pttKey()) },
      { label: "Talk key", value: () => (capturing() === "ptt" ? "Press a key" : pttKey() ? vkName(pttKey()) : "Not set"), step: (d) => { if (d === 0) setCapturing("ptt"); } },
      { label: "Latency overlay", value: () => "Ctrl+Shift+P", step: () => {} },
    ] },
    { name: "Display", opts: [
      { label: "Scale · Ctrl + / Ctrl − / Ctrl 0", value: () => `${Math.round(prefs.scale * 100)}%`, step: (d) => stepScale(d) },
    ] },
    { name: "Hotkeys", opts: ACTIONS.map((a) => ({
      label: a.label,
      value: () => (capturing() === a.id ? "Press keys · Del clears" : comboLabel(prefs.hotkeys[a.id] ?? "")),
      step: (d: -1 | 0 | 1) => { if (d === 0) setCapturing(a.id); },
    })) },
    { name: "Account", opts: [
      { label: "Server", value: () => cfg()?.url ?? "", step: () => {} },
      { label: "Session", value: () => "Log out", step: (d) => { if (d === 0) { call("logout").catch(err); p.close(); } } },
    ] },
  ]);

  const [cat, setCat] = createSignal(0);
  const [opt, setOpt] = createSignal(-1); // -1 = focus on the category column
  const current = () => cats()[cat()];

  const onKey = (e: KeyboardEvent) => {
    const cap = capturing();
    if (cap === "ptt") {
      e.preventDefault(); e.stopPropagation();
      setCapturing(null);
      if (e.key !== "Escape") savePtt(true, e.keyCode); // keyCode = Windows virtual-key code
      return;
    }
    if (cap) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") return void setCapturing(null);
      if (e.key === "Delete" || e.key === "Backspace") { setCapturing(null); return bindHotkey(cap, ""); }
      const combo = comboOf(e);
      if (!combo) return; // modifier alone: keep waiting
      setCapturing(null);
      if (RESERVED.has(combo)) return toast(`${comboLabel(combo)} is reserved`);
      if (!e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.code)) return toast("Use Ctrl or Alt (or an F-key) so typing isn't affected");
      return bindHotkey(cap, combo);
    }
    if (e.key === "Escape") { if (opt() >= 0) { setOpt(-1); e.stopPropagation(); } else p.close(); return; }
    const n = opt() < 0 ? cats().length : current().opts.length;
    const at = opt() < 0 ? cat() : opt();
    if (e.key === "ArrowDown") { e.preventDefault(); opt() < 0 ? setCat((at + 1) % n) : setOpt((at + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); opt() < 0 ? setCat((at - 1 + n) % n) : setOpt((at - 1 + n) % n); }
    else if (e.key === "ArrowRight") { e.preventDefault(); opt() < 0 ? setOpt(0) : current().opts[opt()].step(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); opt() < 0 ? undefined : (opt() === 0 ? setOpt(-1) : current().opts[opt()].step(-1)); }
    else if (e.key === "Enter") { e.preventDefault(); opt() < 0 ? setOpt(0) : current().opts[opt()].step(0); }
  };
  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const pickFile = async () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    try { await call("set_avatar", { data: await toAvatarBytes(f) }); toast("Picture updated"); } catch (e) { err(e); }
  };

  return (
    <div class="sheet menu-sheet" role="dialog" aria-label="Settings">
      <div class="sheet-bar">
        <span class="wordmark"><span class="mark" aria-hidden="true">H</span>HopOn</span>
        <button class="pill" onClick={p.close}>Close</button>
      </div>
      <div class="cascade">
        <ol class="cascade-cats">
          <For each={cats()}>
            {(c, i) => (
              <li style={{ opacity: String(Math.max(0.28, 1 - Math.abs(i() - cat()) * 0.22)) }}>
                <button classList={{ on: i() === cat(), focus: opt() < 0 && i() === cat() }}
                  onClick={() => { setCat(i()); setOpt(0); }} onMouseEnter={() => opt() < 0 && setCat(i())}>
                  {c.name}<span class="chev">›</span>
                </button>
              </li>
            )}
          </For>
        </ol>
        <ol class="cascade-opts">
          <For each={current().opts}>
            {(o, i) => (
              <li classList={{ focus: opt() === i() }} onMouseEnter={() => setOpt(i())}>
                <div class="cap">{o.label}</div>
                <div class="val">
                  <button class="chev" aria-label="Previous" onClick={() => o.step(-1)}>‹</button>
                  <button class="v" onClick={() => o.step(0)}>{o.value()}</button>
                  <button class="chev" aria-label="Next" onClick={() => o.step(1)}>›</button>
                </div>
              </li>
            )}
          </For>
        </ol>
      </div>
      <Show when={!devs() && !devs.loading}>
        <p class="cascade-note muted">Audio devices are unavailable in this build.</p>
      </Show>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pickFile} />
    </div>
  );
}
