// Windowed message list. Only rows intersecting the viewport (+ overscan) are
// in the DOM; row heights are measured once after mount and cached by id, so
// a 5000-message channel renders ~30 rows and scrolls at full frame rate.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { deleteMessage, editMessage, isOwner, jumpTo, loadOlder, maybeMarkRead, s, set, toggleReaction, userName } from "../store";
import { findId } from "../merge";
import { decodeMentions, mentionsUser, preview } from "../rich";
import Rich from "./Rich";
import { EmojiPicker } from "./EmojiPicker";
import { showsHeader } from "../merge";
import type { Msg } from "../types";
import { Avatar } from "./Avatar";
import { cellClass, GAMES, parseGameResult } from "../games";

const OVERSCAN = 800; // px above and below the viewport
const EST_HEADER = 82;
const EST_QUOTE = 22;
const EST_REACTIONS = 34;
const EST_LINE = 30;

export default function MessageList() {
  let el!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);
  const [heights, setHeights] = createSignal(new Map<string, number>(), { equals: false });
  let atBottom = true;

  // Prefix offsets, O(n) per change; n ≤ 5000 so this is well under a millisecond.
  const layout = createMemo(() => {
    const h = heights();
    const list = s.msgs;
    const offs = new Float64Array(list.length + 1);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      offs[i + 1] = offs[i] + (h.get(m.id) ?? ((showsHeader(list, i) ? EST_HEADER : EST_LINE) + (m.replyTo ? EST_QUOTE : 0) + (m.reactions.length ? EST_REACTIONS : 0)));
    }
    return offs;
  });

  const range = createMemo(() => {
    const offs = layout();
    const n = offs.length - 1;
    const top = scrollTop() - OVERSCAN;
    const bottom = scrollTop() + viewH() + OVERSCAN;
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offs[mid + 1] < top) lo = mid + 1; else hi = mid; }
    const start = lo;
    let end = start;
    while (end < n && offs[end] < bottom) end++;
    return [start, end] as const;
  });

  const visible = createMemo(() => {
    const [a, b] = range();
    const out: { m: Msg; i: number }[] = [];
    for (let i = a; i < b; i++) out.push({ m: s.msgs[i], i });
    return out;
  });

  const measure = (id: string, node: HTMLElement) => {
    const h = node.offsetHeight;
    const map = heights();
    if (h && map.get(id) !== h) {
      map.set(id, h);
      setHeights(map);
    }
  };

  // Scroll events caused by our own pinning must not clear `atBottom`: row
  // heights can grow between setting scrollTop and the event firing.
  let pinnedAt = -1;
  const pin = () => { el.scrollTop = el.scrollHeight; pinnedAt = el.scrollTop; };
  const onScroll = () => {
    setScrollTop(el.scrollTop);
    if (Math.abs(el.scrollTop - pinnedAt) < 2) return;
    pinnedAt = -1;
    atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    if (atBottom !== s.atBottom) { set("atBottom", atBottom); if (atBottom) maybeMarkRead(); }
    if (el.scrollTop < 1500 && s.more && !s.loadingOlder) loadOlder();
  };

  onMount(() => {
    const ro = new ResizeObserver(() => { setViewH(el.clientHeight); if (atBottom) pin(); });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  // Keep the bottom pinned for new messages; keep the anchor for prepends.
  let prevFirst = "";
  let prevHeight = 0;
  createEffect(on(layout, (offs) => {
    const first = s.msgs[0]?.id ?? "";
    const total = offs[offs.length - 1];
    queueMicrotask(() => {
      if (atBottom) pin();
      else if (prevFirst && first !== prevFirst) el.scrollTop += total - prevHeight;
      prevFirst = first;
      prevHeight = total;
    });
  }));
  createEffect(on(() => s.selChannel, () => { atBottom = true; set("atBottom", true); setHeights(new Map()); }));
  // Jump: scroll the target row into the middle of the viewport.
  createEffect(on(() => s.jump, (id) => {
    if (!id) return;
    const i = findId(s.msgs, id);
    if (i < 0) return;
    atBottom = false;
    set("atBottom", false);
    queueMicrotask(() => { el.scrollTop = Math.max(0, layout()[i] - el.clientHeight / 3); });
  }, { defer: true }));

  return (
    <div class="messages" ref={el} onScroll={onScroll}>
      <div style={{ height: `${layout()[layout().length - 1]}px`, position: "relative" }}>
        <Show when={!s.more && s.msgs.length > 0}>
          <div class="channel-start eyebrow">Beginning of the channel</div>
        </Show>
        <div style={{ transform: `translateY(${layout()[range()[0]]}px)` }}>
          <For each={visible()}>
            {(row) => <Row m={row.m} header={showsHeader(s.msgs, row.i)} measure={measure} />}
          </For>
        </div>
      </div>
    </div>
  );
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? t : `${d.toLocaleDateString()} ${t}`;
}

function Row(p: { m: Msg; header: boolean; measure: (id: string, n: HTMLElement) => void }) {
  let node!: HTMLDivElement;
  const mine = () => p.m.authorId === s.user?.id;
  const [picker, setPicker] = createSignal(false);
  // Actions are only built while hovered: most rows never need them.
  const [hover, setHover] = createSignal(false);
  const real = () => !p.m.id.startsWith("p");
  onMount(() => p.measure(p.m.id, node));
  createEffect(on(
    () => [p.m.content, s.editing === p.m.id, p.header, p.m.replyTo, p.m.reactions.length, p.m.reactions.map((r) => r.users.length).join()],
    () => p.measure(p.m.id, node),
    { defer: true },
  ));
  const quoted = () => {
    if (!p.m.replyTo) return null;
    const i = findId(s.msgs, p.m.replyTo);
    return i >= 0 ? s.msgs[i] : undefined;
  };
  const flash = () => s.jump === p.m.id;
  createEffect(() => { if (flash()) setTimeout(() => s.jump === p.m.id && set("jump", null), 1600); });
  return (
    <div ref={node} class="msg" onMouseEnter={() => setHover(true)} onMouseLeave={() => !picker() && setHover(false)}
      classList={{ first: p.header, pending: p.m.state === 0, failed: p.m.state === 3, "mention-me": !!s.user && mentionsUser(p.m.content, s.user.id), flash: flash() }}>
      <Show when={p.m.replyTo}>
        <button class="quote" onClick={() => jumpTo(p.m.replyTo!)}>
          <span class="quote-arrow">↳</span>
          <Show when={quoted()} fallback={<span class="muted">Original message isn't loaded · jump</span>}>
            {(q) => <><span class="quote-author">{userName(q().authorId)}</span><span class="quote-text">{preview(q().content, userName)}</span></>}
          </Show>
        </button>
      </Show>
      <Show when={p.header}>
        <div class="meta">
          <Avatar id={p.m.authorId} size={32} />
          <span class="author">{userName(p.m.authorId)}</span>
          <span class="time" title={new Date(p.m.ts).toLocaleString()}>{fmtTime(p.m.ts)}</span>
        </div>
      </Show>
      <Show when={s.editing === p.m.id} fallback={
        <Show when={parseGameResult(p.m.content)} fallback={
        <div class="body">
          <Rich text={p.m.content} />
          <Show when={p.m.editedAt}><span class="edited"> · edited</span></Show>
          <Show when={p.m.state === 3}><span class="err"> · Not sent</span></Show>
        </div>
        }>
          {(r) => (
            <div class="score">
              <div class="score-game">{GAMES.find((g) => g.id === r().game)?.name}</div>
              <div class="score-title">{r().title}</div>
              <Show when={r().grid.length}>
                <div class="score-grid">
                  <For each={r().grid}>{(row) => <div class="score-row"><For each={row}>{(c) => <span class={`cell ${cellClass(c)}`} />}</For></div>}</For>
                </div>
              </Show>
              <For each={r().extra}>{(l) => <div class="score-extra">{l}</div>}</For>
            </div>
          )}
        </Show>
      }>
        <Editor m={p.m} />
      </Show>
      <Show when={p.m.reactions.length}>
        <div class="reactions">
          <For each={p.m.reactions}>
            {(r) => (
              <button class="chip" classList={{ mine: !!s.user && r.users.includes(s.user.id) }}
                title={r.users.map(userName).join(", ")} onClick={() => toggleReaction(p.m, r.emoji)}>
                <span class="chip-emoji">{r.emoji}</span><span class="chip-n">{r.users.length}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={(hover() || picker()) && real() && s.editing !== p.m.id}>
        <div class="actions" classList={{ open: picker() }}>
          <button class="link" onClick={() => set("replyTo", { ...p.m })}>Reply</button>
          <button class="link" onClick={() => setPicker((v) => !v)}>React</button>
          <Show when={mine()}><button class="link" onClick={() => set("editing", p.m.id)}>Edit</button></Show>
          <Show when={mine() || isOwner()}><button class="link" onClick={() => deleteMessage(p.m.id)}>Delete</button></Show>
          <Show when={picker()}>
            <EmojiPicker pick={(e) => { setPicker(false); setHover(node.matches(":hover")); toggleReaction(p.m, e); }} close={() => { setPicker(false); setHover(node.matches(":hover")); }} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

function Editor(p: { m: Msg }) {
  let ta!: HTMLTextAreaElement;
  onMount(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") set("editing", null);
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const v = ta.value.trim();
      if (v && v !== decodeMentions(p.m.content, userName)) editMessage(p.m.id, v); else set("editing", null);
    }
  };
  const text = decodeMentions(p.m.content, userName);
  return <textarea ref={ta} class="edit" value={text} onKeyDown={key} rows={Math.min(8, text.split("\n").length)} />;
}
