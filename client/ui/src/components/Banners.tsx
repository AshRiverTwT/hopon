// In-app notifications: a small stack top-right; click opens the message.
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { dismissBanner, notes, channelLevel } from "../notify";
import { jumpTo, s, selectChannel, selectServer } from "../store";
import { NOTIFY_LEVELS, prefs, setPrefs, type NotifyLevel } from "../prefs";
import { BellIcon, BellOffIcon, CloseIcon } from "./icons";

/** Open a channel (switching server if needed) and jump to a message. */
export async function openFromNotification(channelId: string, messageId?: string) {
  const sv = s.servers.find((x) => x.channels.some((c) => c.id === channelId));
  if (!sv) return;
  if (s.selServer !== sv.id) selectServer(sv.id);
  if (s.selChannel !== channelId || s.stage) await selectChannel(channelId);
  if (messageId) void jumpTo(messageId);
}

export function Banners() {
  return (
    <div class="banners" aria-live="polite">
      <For each={notes.banners}>
        {(b) => (
          <div class="banner" classList={{ mention: b.mention }} role="button" tabIndex={0}
            onClick={() => { dismissBanner(b.key); void openFromNotification(b.channelId, b.messageId); }}>
            <div class="banner-title">{b.title}</div>
            <Show when={b.body}><div class="banner-body">{b.body}</div></Show>
            <button class="banner-x" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); dismissBanner(b.key); }}><CloseIcon /></button>
          </div>
        )}
      </For>
    </div>
  );
}

/** Channel header bell: all messages / only @mentions / nothing. */
export function ChannelBell(p: { channelId: string }) {
  const [open, setOpen] = createSignal(false);
  const level = () => channelLevel(p.channelId);
  const set = (l: NotifyLevel) => {
    const next = { ...prefs.channelNotify };
    if (l === "all") delete next[p.channelId]; else next[p.channelId] = l;
    setPrefs({ channelNotify: next });
    setOpen(false);
  };
  let root!: HTMLDivElement;
  const away = (e: PointerEvent) => { if (open() && !root.contains(e.target as Node)) setOpen(false); };
  onMount(() => window.addEventListener("pointerdown", away));
  onCleanup(() => window.removeEventListener("pointerdown", away));
  const label = () => NOTIFY_LEVELS.find((x) => x.id === level())!.label;
  return (
    <div class="bell" ref={root}>
      <button class="icon-btn" classList={{ on: open(), off: level() === "none" }} title={`Notifications: ${label()}`} aria-label={`Channel notifications: ${label()}`}
        aria-expanded={open()} onClick={() => setOpen((v) => !v)}>
        {level() === "none" ? <BellOffIcon /> : <BellIcon />}
        <Show when={level() === "mentions"}><span class="bell-at">@</span></Show>
      </button>
      <Show when={open()}>
        <ul class="bell-menu" role="menu">
          <li class="eyebrow">Notify me about</li>
          <For each={NOTIFY_LEVELS}>
            {(l) => (
              <li><button role="menuitemradio" aria-checked={level() === l.id} classList={{ on: level() === l.id }} onClick={() => set(l.id)}>{l.label}</button></li>
            )}
          </For>
          <Show when={!prefs.systemNotify && !prefs.appNotify}><li class="muted small">Notifications are off in Settings → Notifications.</li></Show>
        </ul>
      </Show>
    </div>
  );
}
