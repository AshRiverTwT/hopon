import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { call } from "../ipc";

interface Row { name: string; count: number; p50_ms: number; p95_ms: number; p99_ms: number; max_ms: number }
interface Report { rows: Row[]; startup: null | { processToPaintMs: number | null; mainToPaintMs: number; mainToConnectedMs: number | null }; clockOffsetMs: number; bestRttMs: number | null; rssMb: number | null }

export default function PerfOverlay(p: { close: () => void }) {
  const [r, setR] = createSignal<Report | null>(null);
  const poll = () => call<Report>("perf_stats").then(setR).catch(() => {});
  onMount(() => { poll(); const t = setInterval(poll, 1000); onCleanup(() => clearInterval(t)); });
  const f = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(2));
  return (
    <div class="perf">
      <header>
        <b>Latency (ms)</b>
        <span>
          <button class="link" onClick={() => call("perf_reset").then(poll)}>Reset</button>
          <button class="link" onClick={p.close}>Close</button>
        </span>
      </header>
      <Show when={r()}>
        <table>
          <thead><tr><th /><th>n</th><th>p50</th><th>p95</th><th>p99</th></tr></thead>
          <tbody>
            <For each={r()!.rows}>{(x) => <tr><td>{x.name}</td><td>{x.count}</td><td>{f(x.p50_ms)}</td><td>{f(x.p95_ms)}</td><td>{f(x.p99_ms)}</td></tr>}</For>
          </tbody>
        </table>
        <div class="small muted">
          start→paint {f(r()!.startup?.processToPaintMs ?? r()!.startup?.mainToPaintMs)} · start→connected {f(r()!.startup?.mainToConnectedMs)} ·
          RSS {f(r()!.rssMb)} MB · clock offset {f(r()!.clockOffsetMs)} (±{f((r()!.bestRttMs ?? 0) / 2)})
        </div>
      </Show>
    </div>
  );
}
