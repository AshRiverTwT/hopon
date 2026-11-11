import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { s } from "./store";
import Login from "./components/Login";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import VoicePanel from "./components/VoicePanel";
import PerfOverlay from "./components/PerfOverlay";
import { ChannelList, MemberList, ServerRail } from "./components/Sidebar";

export default function App() {
  const [perf, setPerf] = createSignal(false);
  onMount(() => {
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyP") { e.preventDefault(); setPerf((v) => !v); }
    };
    window.addEventListener("keydown", k);
    onCleanup(() => window.removeEventListener("keydown", k));
  });
  const chName = () => s.servers.flatMap((x) => x.channels).find((c) => c.id === s.selChannel)?.name;
  return (
    <>
      <Show when={s.ready} fallback={<div class="splash" />}>
        <Show when={s.user} fallback={<Login />}>
          <div class="app">
            <ServerRail />
            <div class="side">
              <ChannelList />
              <VoicePanel />
            </div>
            <main class="chat">
              <header class="chat-head"># {chName() ?? ""}</header>
              <Show when={s.selChannel} fallback={<div class="empty">Pick a channel</div>}>
                <MessageList />
                <Composer />
              </Show>
            </main>
            <MemberList />
          </div>
        </Show>
      </Show>
      <Show when={perf()}><PerfOverlay close={() => setPerf(false)} /></Show>
      <Show when={s.toast}><div class="toast">{s.toast}</div></Show>
    </>
  );
}
