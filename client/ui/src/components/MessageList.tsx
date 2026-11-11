// Windowed message list. Only rows intersecting the viewport (+ overscan) are
// in the DOM; row heights are measured once after mount and cached by id, so
// a 5000-message channel renders ~30 rows and scrolls at full frame rate.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { deleteMessage, editMessage, loadOlder, s, set, userName } from "../store";
import { showsHeader } from "../merge";
import type { Msg } from "../types";
import { Avatar } from "./Avatar";

const OVERSCAN = 800; // px above and below the viewport
const EST_HEADER = 70;
const EST_LINE = 28;

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
      offs[i + 1] = offs[i] + (h.get(m.id) ?? (showsHeader(list, i) ? EST_HEADER : EST_LINE));
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
  createEffect(on(() => s.selChannel, () => { atBottom = true; setHeights(new Map()); }));

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
  onMount(() => p.measure(p.m.id, node));
  createEffect(on(() => [p.m.content, s.editing === p.m.id, p.header], () => p.measure(p.m.id, node), { defer: true }));
  return (
    <div ref={node} class="msg" classList={{ first: p.header, pending: p.m.state === 0, failed: p.m.state === 3 }}>
      <Show when={p.header}>
        <div class="meta">
          <Avatar id={p.m.authorId} size={20} />
          <span class="author">{userName(p.m.authorId)}</span>
          <span class="time">{fmtTime(p.m.ts)}</span>
        </div>
      </Show>
      <Show when={s.editing === p.m.id} fallback={
        <div class="body">
          {p.m.content}
          <Show when={p.m.editedAt}><span class="edited"> · edited</span></Show>
          <Show when={p.m.state === 3}><span class="err"> · Not sent</span></Show>
        </div>
      }>
        <Editor m={p.m} />
      </Show>
      <Show when={mine() && !p.m.id.startsWith("p") && s.editing !== p.m.id}>
        <div class="actions">
          <button class="link" onClick={() => set("editing", p.m.id)}>Edit</button>
          <button class="link" onClick={() => deleteMessage(p.m.id)}>Delete</button>
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
      if (v && v !== p.m.content) editMessage(p.m.id, v); else set("editing", null);
    }
  };
  return <textarea ref={ta} class="edit" value={p.m.content} onKeyDown={key} rows={Math.min(8, p.m.content.split("\n").length)} />;
}
