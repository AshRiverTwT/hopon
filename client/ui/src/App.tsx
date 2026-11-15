import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { call } from "./ipc";
import { closeFriends, currentDm, currentServer, cycleChannel, cycleServer, friendOf, friendsAttention, isOwner, maybeMarkRead, openFriends, s, toast } from "./store";
import { DmClosed, DmHeader, FriendsHome, FriendsNav, FriendsRail } from "./components/Friends";
import { BookmarkIcon, GamesIcon, GearIcon, PeopleIcon, SearchIcon, SlidersIcon, StarIcon } from "./components/icons";
import { comboOf, type Action } from "./hotkeys";
import { applyScale, prefs, SCALES, setPrefs } from "./prefs";
import { addFilesToComposer } from "./components/Composer";

/** Games sit beside the chat; below this width there's no room for both. */
const GAMES_MIN_WIDTH = 1000;
import Login from "./components/Login";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import Dial from "./components/Dial";
import Stage, { StageHeader } from "./components/Stage";
import { FitTitle } from "./components/FitTitle";
import Settings from "./components/Settings";
import PerfOverlay from "./components/PerfOverlay";
import { AudioToggles, Status } from "./components/Corners";
import GamesPanel from "./components/GamesPanel";
import PeopleRail from "./components/PeopleRail";
import { screen, setScreenContext, disconnectScreens } from "./screen";
import UpdatePrompt from "./components/UpdatePrompt";
import { MiniPlayer } from "./components/Streams";
import CallView from "./components/CallView";
import { Banners, ChannelBell } from "./components/Banners";
import { installUpdate, startUpdateChecks, upd } from "./update";
import { ServerSettingsSheet } from "./components/ServerSettings";
import { ProfileCardHost } from "./components/ProfileCard";
import { ProfileEditor } from "./components/ProfileEditor";
import { closeProfileEditor, profileEditorOpen, startIdleWatch } from "./profile";
import { BookmarksSheet, InviteSheet, MembersSheet, NewChannelSheet, SearchSheet, ServersSheet } from "./components/Sheets";
import { isFavorite, toggleFavorite } from "./localFeatures";

/** Friend requests waiting for you. */
const incoming = () => s.friends.filter((f) => f.state === "incoming").length;

type Sheet = null | { k: "servers" } | { k: "server" } | { k: "members" } | { k: "settings" } | { k: "invite"; link: string } | { k: "new"; voice: boolean } | { k: "bookmarks" } | { k: "search" };

export default function App() {
  const [perf, setPerf] = createSignal(false);
  const [sheet, setSheet] = createSignal<Sheet>(null);
  const [games, setGamesRaw] = createSignal(false);
  const [dropping, setDropping] = createSignal(false);
  createEffect(() => {
    call("ui_set_context", {
      serverId: s.selServer,
      joinedVoice: s.voice.channelId,
      viewedVoice: s.stage,
    }).catch(() => {});
  });
  onMount(() => {
    const syncVisibility = () => call("ui_set_visibility", { visible: !document.hidden }).catch(() => {});
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    onCleanup(() => document.removeEventListener("visibilitychange", syncVisibility));
  });
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
  // Keep video capture scoped to the voice room and current account.
  createEffect(() => {
    const ch = s.voice.channelId;
    if (s.conn.state === "online" && ch && s.voice.state === "connected" && s.user) setScreenContext(ch, s.user.id);
    else if (s.conn.state !== "online" || !ch || !s.user) void disconnectScreens(true);
  });
  onMount(() => {
    startUpdateChecks();
    startIdleWatch();
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
          <div class="frame" classList={{ "with-games": games() && !!currentServer() && !s.friendsOpen }}>
            {/* Top-left: where you are (Friends or your servers). */}
            <nav class="topnav" aria-label="Friends and servers">
              <button class="nav-item" classList={{ on: s.friendsOpen }} aria-current={s.friendsOpen ? "page" : undefined} onClick={openFriends}>
                <span>Friends</span>
                <Show when={incoming()} fallback={<Show when={friendsAttention() && !s.friendsOpen}><i class="dm-unread" aria-label="New messages" /></Show>}>
                  <span class="count-badge" title={`${incoming()} friend request${incoming() === 1 ? "" : "s"}`}>{incoming()}</span>
                </Show>
              </button>
              <button class="nav-item" classList={{ on: !s.friendsOpen }} aria-current={!s.friendsOpen ? "page" : undefined}
                title={s.friendsOpen ? "Back to your servers" : "Switch, create or join a server"} onClick={() => (s.friendsOpen ? closeFriends() : setSheet({ k: "servers" }))}>
                <span>Servers</span>
              </button>
              <Show when={upd.available}>
                <button class="pill update-pill nav-update" disabled={upd.installing} title={`Update to HopOn ${upd.latest} (installs and reopens)`} onClick={() => installUpdate()}>
                  {upd.installing ? "Updating…" : `Update to ${upd.latest}`}
                </button>
              </Show>
            </nav>
            {/* Top row: the open view's header, with the few buttons on the right. */}
            <header class="viewhead">
              <div class="head">
                <Switch>
                  <Match when={s.friendsOpen && currentDm()}><DmHeader search={() => setSheet({ k: "search" })} saved={() => setSheet({ k: "bookmarks" })} /></Match>
                  <Match when={s.friendsOpen}>
                    <div class="head-row">
                      <FitTitle text="Friends" reserve={140} />
                      <button class="handle-chip" title="Your username (click to copy)" onClick={() => navigator.clipboard?.writeText(s.username).then(() => toast("Username copied")).catch(() => {})}>@{s.username}</button>
                    </div>
                  </Match>
                  <Match when={!currentServer()}>{null}</Match>
                  <Match when={s.stage}><StageHeader /></Match>
                  <Match when={s.selChannel}>
                    <div class="eyebrow">Text channel{currentServer() ? ` · ${currentServer()!.name}` : ""}</div>
                    <div class="head-row">
                      <FitTitle text={channel()?.name ?? ""} />
                      <button class="icon-btn fav" classList={{ on: isFavorite(s.selChannel!) }} aria-pressed={isFavorite(s.selChannel!)} title={isFavorite(s.selChannel!) ? "Favorite channel (click to remove)" : "Favorite channel"} aria-label="Favorite channel" onClick={() => toggleFavorite(s.selChannel!)}><StarIcon filled={isFavorite(s.selChannel!)} /></button>
                      <ChannelBell channelId={s.selChannel!} />
                      <button class="icon-btn" title="Search this channel" aria-label="Search this channel" onClick={() => setSheet({ k: "search" })}><SearchIcon /></button>
                      <button class="icon-btn" title="Saved messages" aria-label="Saved messages" onClick={() => setSheet({ k: "bookmarks" })}><BookmarkIcon /></button>
                    </div>
                    <Show when={channel()?.topic}><p class="topic">{channel()!.topic}</p></Show>
                  </Match>
                </Switch>
              </div>
            </header>
            <Show when={!s.friendsOpen} fallback={<>
              <FriendsNav />
              <main class="main">
                <Show when={currentDm()} fallback={<FriendsHome />}>
                  <MessageList />
                  <Show when={friendOf(currentDm()!.dmWith!)?.state === "friends"} fallback={<DmClosed />}><Composer /></Show>
                </Show>
              </main>
              <aside class="side">
                <div class="side-bar">
                  <Show when={currentServer() && !s.friendsOpen}>
                    <button class="icon-btn top-icon people" title={`People: ${currentServer()!.memberCount} in this server`} aria-label="People" onClick={() => setSheet({ k: "members" })}>
                      <PeopleIcon /><span class="top-count">{currentServer()!.memberCount}</span>
                    </button>
                    <button class="games-btn" classList={{ on: games() }} aria-pressed={games()} onClick={() => setGames((v) => !v)}><GamesIcon /><span>Games</span></button>
                    <button class="icon-btn top-icon" title="Server: invite people, settings" aria-label="Server" onClick={() => setSheet({ k: "server" })}><SlidersIcon /></button>
                  </Show>
                  <button class="icon-btn top-icon" title="Settings" aria-label="Settings" onClick={() => setSheet({ k: "settings" })}><GearIcon /></button>
                </div>
                <FriendsRail />
              </aside>
            </>}>
            <Show when={currentServer()} fallback={<>
              <aside class="side"><div class="side-bar">
                  <Show when={currentServer() && !s.friendsOpen}>
                    <button class="icon-btn top-icon people" title={`People: ${currentServer()!.memberCount} in this server`} aria-label="People" onClick={() => setSheet({ k: "members" })}>
                      <PeopleIcon /><span class="top-count">{currentServer()!.memberCount}</span>
                    </button>
                    <button class="games-btn" classList={{ on: games() }} aria-pressed={games()} onClick={() => setGames((v) => !v)}><GamesIcon /><span>Games</span></button>
                    <button class="icon-btn top-icon" title="Server: invite people, settings" aria-label="Server" onClick={() => setSheet({ k: "server" })}><SlidersIcon /></button>
                  </Show>
                  <button class="icon-btn top-icon" title="Settings" aria-label="Settings" onClick={() => setSheet({ k: "settings" })}><GearIcon /></button>
                </div></aside>
              <main class="empty-state">
                <h1 class="display title">No servers yet</h1>
                <p class="lede">Start one, or paste an invite someone sent you.</p>
                <button class="pill solid big" onClick={() => setSheet({ k: "servers" })}>Create or join</button>
              </main>
            </>
            }>
              <Dial onNewChannel={(voice) => setSheet({ k: "new", voice })} onServers={() => setSheet({ k: "servers" })} />
              <Switch>
                <Match when={s.stage}><main class="main"><Stage /></main></Match>
                <Match when={s.selChannel}>
                  <main class="main">
                    <MessageList />
                    <Composer />
                  </main>
                </Match>
              </Switch>
              <aside class="side">
                <div class="side-bar">
                  <Show when={currentServer() && !s.friendsOpen}>
                    <button class="icon-btn top-icon people" title={`People: ${currentServer()!.memberCount} in this server`} aria-label="People" onClick={() => setSheet({ k: "members" })}>
                      <PeopleIcon /><span class="top-count">{currentServer()!.memberCount}</span>
                    </button>
                    <button class="games-btn" classList={{ on: games() }} aria-pressed={games()} onClick={() => setGames((v) => !v)}><GamesIcon /><span>Games</span></button>
                    <button class="icon-btn top-icon" title="Server: invite people, settings" aria-label="Server" onClick={() => setSheet({ k: "server" })}><SlidersIcon /></button>
                  </Show>
                  <button class="icon-btn top-icon" title="Settings" aria-label="Settings" onClick={() => setSheet({ k: "settings" })}><GearIcon /></button>
                </div>
                <Show when={games()} fallback={<PeopleRail />}><GamesPanel close={() => setGames(false)} /></Show>
              </aside>
            </Show>
            </Show>
            <footer class="foot-l"><Status compact /><AudioToggles /></footer>
            <footer class="foot-r"><Status /></footer>
          </div>
          <Switch>
            <Match when={sheet()?.k === "servers"}><ServersSheet close={close} /></Match>
            <Match when={sheet()?.k === "members"}><MembersSheet close={close} /></Match>
            <Match when={sheet()?.k === "bookmarks"}><BookmarksSheet close={close} /></Match>
            <Match when={sheet()?.k === "search"}><SearchSheet close={close} /></Match>
            <Match when={sheet()?.k === "server"}><ServerSettingsSheet close={close} /></Match>
            <Match when={sheet()?.k === "settings"}><Settings close={close} /></Match>
            <Match when={sheet()?.k === "invite"}><InviteSheet link={(sheet() as { link: string }).link} close={close} /></Match>
            <Match when={sheet()?.k === "new"}><NewChannelSheet voice={(sheet() as { voice: boolean }).voice} close={close} /></Match>
          </Switch>
        </Show>
      </Show>
      <Show when={s.user}>
        <MiniPlayer /><Show when={screen.full}><CallView /></Show><Banners />
        <ProfileCardHost />
        <Show when={profileEditorOpen()}><ProfileEditor close={closeProfileEditor} /></Show>
      </Show>
      <Show when={perf()}><PerfOverlay close={() => setPerf(false)} /></Show>
      <UpdatePrompt />
      <Show when={dropping()}><div class="drop-hint"><span class="display">Drop to attach</span></div></Show>
      <Show when={s.toast}><div class="toast">{s.toast}</div></Show>
    </>
  );
}
