import { For, Show, createResource, createSignal } from "solid-js";
import { call } from "../ipc";
import { toast } from "../store";
import { Overlay } from "./Overlay";

interface Devices { processing: { aec: boolean; ns: boolean; agc: boolean }; inputs: { id: string; name: string }[]; outputs: { id: string; name: string }[]; input: string | null; output: string | null; aec: string; ns: string; agc: string }

export default function Settings(p: { close: () => void }) {
  const [devs] = createResource(() => call<Devices>("audio_devices"));
  const [ptt, setPtt] = createSignal(localStorage.getItem("ptt") === "1");
  const [key, setKey] = createSignal(Number(localStorage.getItem("pttKey") || 0));
  const [capturing, setCapturing] = createSignal(false);
  const err = (e: unknown) => toast(String(e));

  const applyPtt = (en: boolean, k: number) => {
    setPtt(en); setKey(k);
    try { localStorage.setItem("ptt", en ? "1" : "0"); localStorage.setItem("pttKey", String(k)); } catch {}
    call("voice_ptt", { enabled: en, keyCode: k }).catch(err);
  };
  const capture = (e: KeyboardEvent) => {
    if (!capturing()) return;
    e.preventDefault();
    setCapturing(false);
    // keyCode matches the Windows virtual-key code for keys used for PTT.
    applyPtt(true, e.keyCode);
  };
  const logout = () => { call("logout").catch(err); p.close(); };
  const [apm, setApm] = createSignal<{ aec: boolean; ns: boolean; agc: boolean } | null>(null);
  const proc = () => apm() ?? devs()?.processing ?? { aec: true, ns: true, agc: true };
  const setProc = (k: "aec" | "ns" | "agc", v: boolean) => {
    const next = { ...proc(), [k]: v };
    setApm(next);
    call("audio_processing", next).catch(err);
  };

  return (
    <Overlay title="Settings" close={p.close}>
      <div class="settings" onKeyDown={capture}>
        <div class="eyebrow">Microphone</div>
        <Show when={devs()} fallback={<p class="muted">{devs.error ? String(devs.error) : "Loading devices…"}</p>}>
          <select class="line" onChange={(e) => call("audio_set_device", { input: true, id: e.currentTarget.value || null }).catch(err)}>
            <option value="">System default</option>
            <For each={devs()!.inputs}>{(d) => <option value={d.id} selected={d.id === devs()!.input}>{d.name}</option>}</For>
          </select>
          <div class="eyebrow">Output</div>
          <select class="line" onChange={(e) => call("audio_set_device", { input: false, id: e.currentTarget.value || null }).catch(err)}>
            <option value="">System default</option>
            <For each={devs()!.outputs}>{(d) => <option value={d.id} selected={d.id === devs()!.output}>{d.name}</option>}</For>
          </select>
          <div class="eyebrow">Voice processing</div>
          <div class="field-row">
            <label class="check"><input type="checkbox" checked={proc().aec} onChange={(e) => setProc("aec", e.currentTarget.checked)} /> Echo cancellation</label>
            <label class="check"><input type="checkbox" checked={proc().ns} onChange={(e) => setProc("ns", e.currentTarget.checked)} /> Noise suppression</label>
            <label class="check"><input type="checkbox" checked={proc().agc} onChange={(e) => setProc("agc", e.currentTarget.checked)} /> Auto gain</label>
          </div>
          <p class="muted small">Using a headset? Turn echo cancellation off: there is no echo to remove, and it can cut your voice while others talk. Changes apply immediately, even mid-call.</p>
        </Show>
        <div class="eyebrow">Push to talk</div>
        <div class="field-row">
          <label class="check"><input type="checkbox" checked={ptt()} onChange={(e) => applyPtt(e.currentTarget.checked, key())} /> Enabled</label>
          <button class="pill" onClick={() => setCapturing(true)}>{capturing() ? "Press a key…" : key() ? `Key: ${keyName(key())}` : "Set key"}</button>
        </div>
        <p class="muted small">Works while HopOn is in the background. Press Ctrl+Shift+P for the latency overlay.</p>
        <div class="field-row end"><button class="pill" onClick={logout}>Log out</button></div>
      </div>
    </Overlay>
  );
}

function keyName(vk: number) {
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`;
  const named: Record<number, string> = { 0x14: "Caps Lock", 0x20: "Space", 0xc0: "`", 0x12: "Alt", 0x11: "Ctrl", 0x10: "Shift" };
  return named[vk] ?? (vk >= 0x30 && vk <= 0x5a ? String.fromCharCode(vk) : `0x${vk.toString(16)}`);
}
