// In-game overlay page (its own window, created on the hotkey and destroyed
// when hidden). Mini chat for the channel open in the main window, plus who's
// in your voice room; a speaker's square glows. Esc returns to the game.
//
// Deliberately does NOT run the main store's event handling (that would
// replay chimes, open channels and apply prefs a second time). It only
// borrows the store's user/server lists so names and avatars resolve.
import { render } from "solid-js/web";
import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { call, now, randomNonce, subscribe } from "./ipc";
import { set as setMain, userName } from "./store";
import { mergeMsgs } from "./merge";
import { encodeMentions } from "./rich";
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
      setMain({ user: e.user, servers: e.servers });
      break;
    case "server": {
      const i = o.servers.findIndex((x) => x.id === e.server.id);
      if (i >= 0) set("servers", i, reconcile(e.server)); else set("servers", o.servers.length, e.server);
      setMain("servers", reconcile([...o.servers], { key: "id" }));
      break;
    }
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

  const send = () => {
    const ch = o.channelId;
    const sv = channel()?.sv;
    const text = encodeMentions(ta.value.trim(), sv?.members ?? []);
    if (!ch || !text) return;
    call("send_message", { channelId: ch, content: text, nonce: randomNonce(), tInputMs: now(), replyTo: null }).catch(() => {});
    ta.value = "";
  };

  onMount(() => {
    subscribe(onEvent);
    call<{ channelId: string | null; msgs: Msg[] }>("overlay_context").then((c) => {
      set({ channelId: c.channelId, msgs: c.msgs.slice(-KEEP) });
      requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
    }).catch(() => {});
    ta.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
    // Clicked another window (e.g. back into the game with the mouse): go away.
    let focused = false;
    const onFocus = () => (focused = true);
    const onBlur = () => setTimeout(() => { if (focused && !document.hasFocus()) close(false); }, 120);
    window.addEventListener("keydown", key);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    if (document.hasFocus()) focused = true;
    onCleanup(() => { window.removeEventListener("keydown", key); window.removeEventListener("focus", onFocus); window.removeEventListener("blur", onBlur); });
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
          <span class="ov-hint">{comboLabel(prefs.hotkeys.overlay)} or Esc to return</span>
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
        <textarea ref={ta} class="ov-input" rows={1} maxLength={4000} placeholder={channel() ? `Message #${channel()!.c.name}` : ""}
          disabled={!channel()} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
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
