import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { call } from "./ipc";
import { currentServer, cycleChannel, cycleServer, isOwner, maybeMarkRead, s, toast } from "./store";
import { comboOf, type Action } from "./hotkeys";
import { applyScale, prefs, SCALES, setPrefs } from "./prefs";
import { addFilesToComposer } from "./components/Composer";

/** Games sit beside the chat; below this width there's no room for both. */
const GAMES_MIN_WIDTH = 1000;
import Login from "./components/Login";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import Dial from "./components/Dial";
import Stage from "./components/Stage";
import Settings from "./components/Settings";
import PerfOverlay from "./components/PerfOverlay";
import { AudioToggles, Status } from "./components/Corners";
import GamesPanel from "./components/GamesPanel";
import PeopleRail from "./components/PeopleRail";
import { connectScreens, disconnectScreens } from "./screen";
import UpdatePrompt from "./components/UpdatePrompt";
import { FullStream, MiniPlayer } from "./components/Streams";
import { Banners, ChannelBell } from "./components/Banners";
import { installUpdate, startUpdateChecks, upd } from "./update";
import { ServerSettingsSheet } from "./components/ServerSettings";
import { InviteSheet, MembersSheet, NewChannelSheet, ServersSheet } from "./components/Sheets";

type Sheet = null | { k: "servers" } | { k: "server" } | { k: "members" } | { k: "settings" } | { k: "invite"; link: string } | { k: "new"; voice: boolean };

export default function App() {
  const [perf, setPerf] = createSignal(false);
  const [sheet, setSheet] = createSignal<Sheet>(null);
  const [games, setGamesRaw] = createSignal(false);
  const [dropping, setDropping] = createSignal(false);
  const setGames = (v: boolean | ((x: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(games()) : v;
    if (next && window.innerWidth < GAMES_MIN_WIDTH) {
      toast("Make the window wider (or maximize it) to play games beside the chat");
      return;
    }
    setGamesRaw(next);
  };
  const zoom = (dir: -1 | 0 | 1) => {
    const i = Math.max(0, SCALES.indexOf(prefs.scale));
    const v = dir === 0 ? 1 : SCALES[Math.min(SCALES.length - 1, Math.max(0, i + dir))];
    setPrefs({ scale: v });
    applyScale(v);
    toast(`Zoom ${Math.round(v * 100)}%`);
  };
  const run = (a: Action) => {
    const err = (e: unknown) => toast(String(e));
    switch (a) {
      case "nextChannel": return cycleChannel(1);
      case "prevChannel": return cycleChannel(-1);
      case "nextUnread": return cycleChannel(1, true);
      case "prevUnread": return cycleChannel(-1, true);
      case "nextServer": return cycleServer(1);
      case "prevServer": return cycleServer(-1);
      case "toggleMute": return void call("voice_mute", { muted: !s.voice.muted }).catch(err);
      case "toggleDeafen": return void call("voice_deafen", { deafened: !s.voice.deafened }).catch(err);
      case "toggleGames": return currentServer() && setGames((v) => !v);
      case "focusComposer": return (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.focus();
      case "zoomIn": return zoom(1);
      case "zoomOut": return zoom(-1);
      case "zoomReset": return zoom(0);
      case "overlay": return;
    }
  };
  // The game is a native view drawn above the page: hide it under sheets/overlays.
  createEffect(() => {
    if (!games()) return;
    call("games_visible", { visible: !sheet() && !perf() }).catch(() => {});
  });
  // Screen-share connection follows voice: up while connected, gone after.
  createEffect(() => {
    const ch = s.voice.channelId;
    if (ch && s.voice.state === "connected" && s.user) connectScreens(ch, s.user.id).catch((e) => toast(`Screen share unavailable: ${e}`));
    else if (!ch) void disconnectScreens();
  });
  onMount(() => {
    startUpdateChecks();
    call<{ testOpenGames?: boolean }>("get_config").then((c) => c?.testOpenGames && setGames(true)).catch(() => {});
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyP") { e.preventDefault(); setPerf((v) => !v); return; }
      const combo = comboOf(e);
      if (!combo || !s.user) return;
      const hk = prefs.hotkeys;
      const a = (Object.keys(hk) as Action[]).find((x) => x !== "overlay" && hk[x] === combo);
      if (!a) return;
      // Sheets (settings, etc.) own the keyboard, except for zoom.
      if (sheet() && !a.startsWith("zoom")) return;
      e.preventDefault();
      run(a);
    };
    // Games beside the chat need room: close them when the window gets narrow.
    const onResize = () => {
      if (games() && window.innerWidth < GAMES_MIN_WIDTH) {
        setGamesRaw(false);
        toast("Games closed: the window is too narrow for games and chat side by side");
      }
    };
    // Files dropped anywhere on the window go to the message box.
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const over = (e: DragEvent) => { if (hasFiles(e) && s.selChannel && !s.stage) { e.preventDefault(); setDropping(true); } };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDropping(false); };
    const dropped = (e: DragEvent) => {
      setDropping(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (s.selChannel && !s.stage) addFilesToComposer([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", dropped);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", dropped);
      window.removeEventListener("resize", onResize);
    });
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
              <span class="wordmark"><span class="mark" aria-hidden="true">H</span><span class="wordmark-text">HopOn</span></span>
              <button class="pill ghost" title={currentServer()?.name} onClick={() => setSheet({ k: "servers" })}>{currentServer()?.name ?? "Servers"}</button>
              <div class="topbar-right">
                <Show when={currentServer()}>
                  <button class="pill ghost" onClick={() => setSheet({ k: "members" })}>People {currentServer()!.members.filter((m) => s.online[m.id]).length}/{currentServer()!.members.length}</button>
                  <Show when={isOwner()}><button class="pill ghost" onClick={() => setSheet({ k: "server" })}>Server<span class="long"> settings</span></button></Show>
                  <button class="pill ghost" onClick={invite}>Invite</button>
                  <button class="pill ghost" classList={{ active: games() }} onClick={() => setGames((v) => !v)}>Games</button>
                </Show>
                <Show when={upd.available}>
                  <button class="pill update-pill" disabled={upd.installing} title={`Update to HopOn ${upd.latest} (installs and reopens)`} onClick={() => installUpdate()}>
                    {upd.installing ? "Updating…" : `Update to ${upd.latest}`}
                  </button>
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
                      <div class="head-row">
                        <h1 class="display title" title={channel()?.name}>{channel()?.name}</h1>
                        <ChannelBell channelId={s.selChannel!} />
                      </div>
                      <Show when={channel()?.topic}><p class="topic">{channel()!.topic}</p></Show>
                    </header>
                    <MessageList />
                    <Composer />
                  </main>
                </Match>
              </Switch>
              <Show when={games()} fallback={<PeopleRail />}><GamesPanel close={() => setGames(false)} /></Show>
            </Show>
            <footer class="foot-l"><Status compact /><AudioToggles /></footer>
            <footer class="foot-r"><Status /></footer>
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
      <Show when={s.user}><MiniPlayer /><FullStream /><Banners /></Show>
      <Show when={perf()}><PerfOverlay close={() => setPerf(false)} /></Show>
      <UpdatePrompt />
      <Show when={dropping()}><div class="drop-hint"><span class="display">Drop to attach</span></div></Show>
      <Show when={s.toast}><div class="toast">{s.toast}</div></Show>
    </>
  );
}
