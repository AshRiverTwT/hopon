import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { call } from "./ipc";
import { currentServer, isOwner, maybeMarkRead, s, toast } from "./store";
import Login from "./components/Login";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import Dial from "./components/Dial";
import Stage from "./components/Stage";
import Settings from "./components/Settings";
import PerfOverlay from "./components/PerfOverlay";
import { AudioToggles, Status } from "./components/Corners";
import GamesPanel from "./components/GamesPanel";
import { ServerSettingsSheet } from "./components/ServerSettings";
import { InviteSheet, MembersSheet, NewChannelSheet, ServersSheet } from "./components/Sheets";

type Sheet = null | { k: "servers" } | { k: "server" } | { k: "members" } | { k: "settings" } | { k: "invite"; link: string } | { k: "new"; voice: boolean };

export default function App() {
  const [perf, setPerf] = createSignal(false);
  const [sheet, setSheet] = createSignal<Sheet>(null);
  const [games, setGames] = createSignal(false);
  // The game is a native view drawn above the page: hide it under sheets/overlays.
  createEffect(() => {
    if (!games()) return;
    call("games_visible", { visible: !sheet() && !perf() }).catch(() => {});
  });
  onMount(() => {
    call<{ testOpenGames?: boolean }>("get_config").then((c) => c?.testOpenGames && setGames(true)).catch(() => {});
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyP") { e.preventDefault(); setPerf((v) => !v); }
    };
    window.addEventListener("keydown", k);
    window.addEventListener("focus", maybeMarkRead);
    document.addEventListener("visibilitychange", maybeMarkRead);
    onCleanup(() => {
      window.removeEventListener("keydown", k);
      window.removeEventListener("focus", maybeMarkRead);
      document.removeEventListener("visibilitychange", maybeMarkRead);
    });
  });
  const channel = () => currentServer()?.channels.find((c) => c.id === s.selChannel);
  const invite = async () => {
    try { setSheet({ k: "invite", link: await call<string>("create_invite", { serverId: s.selServer }) }); } catch (e) { toast(String(e)); }
  };
  const close = () => setSheet(null);
  return (
    <>
      <Show when={s.ready} fallback={<div class="splash" />}>
        <Show when={s.user} fallback={<Login />}>
          <div class="frame" classList={{ "with-games": games() && !!currentServer() }}>
            <header class="topbar">
              <span class="wordmark"><span class="mark" aria-hidden="true">H</span>HopOn</span>
              <button class="pill ghost" onClick={() => setSheet({ k: "servers" })}>{currentServer()?.name ?? "Servers"}</button>
              <div class="topbar-right">
                <Show when={currentServer()}>
                  <button class="pill ghost" onClick={() => setSheet({ k: "members" })}>People {currentServer()!.members.filter((m) => s.online[m.id]).length}/{currentServer()!.members.length}</button>
                  <Show when={isOwner()}><button class="pill ghost" onClick={() => setSheet({ k: "server" })}>Server settings</button></Show>
                  <button class="pill ghost" onClick={invite}>Invite</button>
                  <button class="pill ghost" classList={{ active: games() }} onClick={() => setGames((v) => !v)}>Games</button>
                </Show>
                <button class="pill" onClick={() => setSheet({ k: "settings" })}>Settings</button>
              </div>
            </header>
            <Show when={currentServer()} fallback={
              <main class="empty-state">
                <h1 class="display title">No servers yet</h1>
                <p class="lede">Start one, or paste an invite someone sent you.</p>
                <button class="pill solid big" onClick={() => setSheet({ k: "servers" })}>Create or join</button>
              </main>
            }>
              <Dial onNewChannel={(voice) => setSheet({ k: "new", voice })} onServers={() => setSheet({ k: "servers" })} />
              <Switch>
                <Match when={s.stage}><main class="main"><Stage /></main></Match>
                <Match when={s.selChannel}>
                  <main class="main">
                    <header class="head">
                      <div class="eyebrow">{currentServer()?.name} · Channel</div>
                      <h1 class="display title" title={channel()?.name}>{channel()?.name}</h1>
                      <Show when={channel()?.topic}><p class="topic">{channel()!.topic}</p></Show>
                    </header>
                    <MessageList />
                    <Composer />
                  </main>
                </Match>
              </Switch>
              <Show when={games()}><GamesPanel close={() => setGames(false)} /></Show>
            </Show>
            <footer class="bottombar">
              <AudioToggles />
              <Status />
            </footer>
          </div>
          <Switch>
            <Match when={sheet()?.k === "servers"}><ServersSheet close={close} /></Match>
            <Match when={sheet()?.k === "members"}><MembersSheet close={close} /></Match>
            <Match when={sheet()?.k === "server"}><ServerSettingsSheet close={close} /></Match>
            <Match when={sheet()?.k === "settings"}><Settings close={close} /></Match>
            <Match when={sheet()?.k === "invite"}><InviteSheet link={(sheet() as { link: string }).link} close={close} /></Match>
            <Match when={sheet()?.k === "new"}><NewChannelSheet voice={(sheet() as { voice: boolean }).voice} close={close} /></Match>
          </Switch>
        </Show>
      </Show>
      <Show when={perf()}><PerfOverlay close={() => setPerf(false)} /></Show>
      <Show when={s.toast}><div class="toast">{s.toast}</div></Show>
    </>
  );
}
