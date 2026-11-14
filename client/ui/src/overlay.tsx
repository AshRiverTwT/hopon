// In-game overlay page (its own window, created on the hotkey and destroyed
// when hidden). Mini chat for the channel open in the main window, plus who's
// in your voice room; a speaker's square glows.
//
// It appears without taking focus, so the game keeps running fullscreen.
// Typing is explicit: the "type" hotkey or clicking the box takes focus;
// Enter sends and Esc cancels, both handing focus back to the game.
//
// Deliberately does NOT run the main store's event handling (that would
// replay chimes, open channels and apply prefs a second time). It only
// borrows the store's user/server lists so names and avatars resolve.
import { render } from "solid-js/web";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { createStore, reconcile } from "solid-js/store";
import { call, now, randomNonce, subscribe } from "./ipc";
import { s as mainStore, set as setMain, userName } from "./store";
import { mergeMsgs } from "./merge";
import { encodeMentions } from "./rich";
import { rememberMentionCandidates, serverUsers } from "./store";
import Rich from "./components/Rich";
import { Avatar } from "./components/Avatar";
import Attachments from "./components/Attachments";
import { prefs } from "./prefs";
import { comboLabel } from "./hotkeys";
import { SYSTEM_USER, type Msg, type Presence, type Server, type UiEvent, type User } from "./types";
import "./overlay.css";

const KEEP = 40;

const [o, set] = createStore({
  me: null as User | null,
  servers: [] as Server[],
  channelId: null as string | null,
  msgs: [] as Msg[],
  presence: {} as Record<string, Presence>,
  voiceCh: null as string | null,
  muted: false,
  speaking: [] as string[],
});

function onEvent(e: UiEvent) {
  switch (e.t) {
    case "session":
      set("me", e.user);
      set("servers", reconcile(e.servers, { key: "id" }));
      set("presence", reconcile(Object.fromEntries(e.voice.map((p) => [p.userId, p]))));
      if (e.user) set("voiceCh", e.voice.find((p) => p.userId === e.user!.id)?.channelId ?? null);
      setMain({ user: e.user, servers: e.servers, users: Object.fromEntries(e.users.map((u) => [u.id, u])) });
      break;
    case "server": {
      const i = o.servers.findIndex((x) => x.id === e.server.id);
      if (i >= 0) set("servers", i, reconcile(e.server)); else set("servers", o.servers.length, e.server);
      setMain("servers", reconcile([...o.servers], { key: "id" }));
      break;
    }
    case "memberPage": {
      const users = { ...mainStore.users, ...Object.fromEntries(e.users.map((u) => [u.id, u])) };
      setMain("users", users);
      setMain("servers", (servers) => servers.map((sv) => sv.id === e.serverId ? { ...sv, memberIds: [...new Set([...sv.memberIds, ...e.users.map((u) => u.id)])] } : sv));
      break;
    }
    case "memberSearch":
      rememberMentionCandidates(e.serverId, e.users);
      break;
    case "messages":
      if (e.channelId === o.channelId) set("msgs", mergeMsgs([...o.msgs], e.msgs).list.slice(-KEEP));
      break;
    case "edited":
      if (e.channelId === o.channelId) set("msgs", (m) => m.id === e.id, { content: e.content, editedAt: e.editedAt });
      break;
    case "deleted":
      if (e.channelId === o.channelId) set("msgs", (l) => l.filter((m) => m.id !== e.id));
      break;
    case "presence":
      if (e.presence.channelId) set("presence", e.presence.userId, e.presence);
      else set("presence", (p) => { const n = { ...p }; delete n[e.presence.userId]; return n; });
      break;
    case "voice":
      set({ voiceCh: e.channelId, muted: e.muted });
      if (!e.channelId) set("speaking", []);
      break;
    case "speaking":
      set("speaking", e.userIds);
      break;
    case "userUpdated":
      if (o.me?.id === e.user.id) set("me", e.user);
      setMain("users", e.user.id, e.user);
      break;
  }
}

function Overlay() {
  let ta!: HTMLTextAreaElement;
  let list!: HTMLDivElement;
  const channel = createMemo(() => o.servers.flatMap((sv) => sv.channels.map((c) => ({ c, sv }))).find((x) => x.c.id === o.channelId));
  const voiceName = createMemo(() => o.servers.flatMap((sv) => sv.channels).find((c) => c.id === o.voiceCh)?.name);
  const inVoice = createMemo(() => Object.values(o.presence).filter((p) => p.channelId && p.channelId === o.voiceCh));
  const close = (refocus: boolean) => call("overlay_hide", { refocus }).catch(() => {});
  const [typing, setTyping] = createSignal(false);
  const startTyping = () => { if (!typing()) call("overlay_typing", { on: true }).catch(() => {}); };
  const stopTyping = () => { if (typing()) { setTyping(false); call("overlay_typing", { on: false }).catch(() => {}); } };

  const send = () => {
    const ch = o.channelId;
    const sv = channel()?.sv;
    const text = encodeMentions(ta.value.trim(), serverUsers(sv, true));
    if (!ch || !text) return;
    call("send_message", { channelId: ch, content: text, nonce: randomNonce(), tInputMs: now(), replyTo: null }).catch(() => {});
    ta.value = "";
    stopTyping();
  };

  onMount(() => {
    subscribe(onEvent);
    call<{ channelId: string | null; msgs: Msg[] }>("overlay_context").then((c) => {
      set({ channelId: c.channelId, msgs: c.msgs.slice(-KEEP) });
      requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
    }).catch(() => {});
    const un = listen<boolean>("overlay-typing", (e) => {
      setTyping(e.payload);
      if (e.payload) requestAnimationFrame(() => { window.focus(); ta.focus(); });
      else ta.blur();
    });
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (typing()) stopTyping(); else close(true);
    };
    // Clicked back into the game while typing: stop typing (overlay stays up).
    const onBlur = () => setTimeout(() => { if (typing() && !document.hasFocus()) stopTyping(); }, 120);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onBlur);
    onCleanup(() => { un.then((f) => f()); window.removeEventListener("keydown", key); window.removeEventListener("blur", onBlur); });
  });

  // Stick to the newest message.
  createMemo(() => { o.msgs.length; requestAnimationFrame(() => list && (list.scrollTop = list.scrollHeight)); });

  return (
    <div class="ov">
      <section class="ov-chat">
        <header class="ov-head">
          <span class="ov-mark">H</span>
          <span class="ov-title">{channel() ? `# ${channel()!.c.name}` : "No channel open"}</span>
          <span class="ov-sub">{channel()?.sv.name}</span>
          <span class="ov-hint">{typing() ? "Enter to send · Esc to cancel" : `${comboLabel(prefs.hotkeys.overlayType)} to type · ${comboLabel(prefs.hotkeys.overlay)} to hide`}</span>
        </header>
        <div class="ov-msgs" ref={list}>
          <For each={o.msgs}>
            {(m, i) => {
              const head = () => i() === 0 || o.msgs[i() - 1].authorId !== m.authorId;
              return (
                <div class="ov-msg" classList={{ sys: m.authorId === SYSTEM_USER, cont: !head() }}>
                  <Show when={head() && m.authorId !== SYSTEM_USER}>
                    <div class="ov-meta"><Avatar id={m.authorId} size={20} /><b>{userName(m.authorId)}</b></div>
                  </Show>
                  <div class="ov-body">
                    <Show when={m.content}><Rich text={m.content} /></Show>
                    <Show when={m.attachments.length}><Attachments list={m.attachments} remeasure={() => {}} /></Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <textarea ref={ta} class="ov-input" classList={{ typing: typing() }} rows={1} maxLength={4000}
          placeholder={channel() ? (typing() ? `Message #${channel()!.c.name}` : `Press ${comboLabel(prefs.hotkeys.overlayType)} or click to type`) : ""}
          disabled={!channel()} onMouseDown={startTyping} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
      </section>
      <Show when={o.voiceCh}>
        <aside class="ov-voice">
          <div class="ov-vhead"><span class="ov-live" />{voiceName() ?? "Voice"}</div>
          <ul>
            <For each={inVoice()}>
              {(p) => (
                <li classList={{ speaking: o.speaking.includes(p.userId), muted: p.muted || p.deafened }}>
                  <span class="ov-av"><Avatar id={p.userId} size={34} /></span>
                  <span class="ov-name">{userName(p.userId)}</span>
                  <Show when={p.muted || p.deafened}><span class="ov-state">{p.deafened ? "deaf" : "muted"}</span></Show>
                </li>
              )}
            </For>
          </ul>
        </aside>
      </Show>
    </div>
  );
}

render(() => <Overlay />, document.getElementById("root")!);
// Dev preview hook (preview-overlay.html).
if (import.meta.env.DEV) (window as unknown as { __ovPush: typeof onEvent }).__ovPush = onEvent;
