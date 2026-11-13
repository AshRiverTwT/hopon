// Right-hand people column: online first, with what they're playing.
// Hidden while the games panel is open (it takes this space).
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { call } from "../ipc";
import { currentServer, loadMoreMembers, s, serverUsers } from "../store";
import { Avatar } from "./Avatar";

export default function PeopleRail() {
  const ROW = 54;
  const OVERSCAN = 8;
  const [range, setRange] = createSignal<[number, number]>([0, 32]);
  let activeServer = "";
  let rail!: HTMLElement;
  let observer: IntersectionObserver | undefined;
  const visible = new Set<string>();
  const publishVisible = () => call("ui_set_visible_members", { userIds: [...visible] }).catch(() => {});
  const observeRow = (el: HTMLLIElement, userId: string) => {
    el.dataset.userId = userId;
    queueMicrotask(() => observer?.observe(el));
  };
  onMount(() => {
    observer = new IntersectionObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const userId = (entry.target as HTMLElement).dataset.userId;
        if (!userId) continue;
        if (entry.isIntersecting && !visible.has(userId)) { visible.add(userId); changed = true; }
        else if (!entry.isIntersecting && visible.delete(userId)) changed = true;
      }
      if (changed) publishVisible();
    }, { root: rail, threshold: 0.01 });
    rail.querySelectorAll<HTMLLIElement>("li[data-user-id]").forEach((el) => observer?.observe(el));
  });
  onCleanup(() => { observer?.disconnect(); visible.clear(); publishVisible(); });
  createEffect(() => {
    const serverId = currentServer()?.id ?? "";
    if (serverId === activeServer) return;
    activeServer = serverId;
    visible.clear();
    publishVisible();
    setRange([0, 32]);
    if (rail) rail.scrollTop = 0;
    const server = s.servers.find((x) => x.id === serverId);
    if (server && server.memberIds.length === 0) loadMoreMembers(serverId);
  });
  createEffect(() => {
    const server = currentServer();
    if (!server || (s.memberLoaded[server.id] ?? 0) !== 0 || server.memberIds.length !== 0) return;
    setRange([0, 32]);
    if (rail) rail.scrollTop = 0;
  });
  const people = createMemo(() => {
    const sv = currentServer();
    if (!sv) return [];
    const act = sv.activities ?? {};
    return serverUsers(sv)
      .map((m) => ({ ...m, online: !!s.online[m.id], game: act[m.id] ?? "", voice: !!s.presence[m.id]?.channelId }))
      .sort((a, b) => Number(b.online) - Number(a.online) || Number(!!b.game) - Number(!!a.game) || a.name.localeCompare(b.name));
  });
  const onlineCount = () => people().filter((p) => p.online).length;
  const page = () => people().slice(range()[0], range()[1]);
  const onScroll = () => {
    const sv = currentServer();
    const first = Math.max(0, Math.floor(Math.max(0, rail.scrollTop - 40) / ROW) - OVERSCAN);
    const last = Math.min(people().length, Math.ceil(rail.clientHeight / ROW) + first + OVERSCAN * 2);
    setRange([first, Math.max(last, first + 32)]);
    if (sv && rail.scrollTop + rail.clientHeight >= rail.scrollHeight - ROW * 8) loadMoreMembers(sv.id);
  };
  const topSpace = () => range()[0] * ROW;
  const bottomSpace = () => Math.max(0, (people().length - range()[1]) * ROW);
  return (
    <aside ref={rail} class="rail" aria-label="People" onScroll={onScroll}>
      <div class="eyebrow rail-head" title={`${onlineCount()} online`}><span class="rail-label">Online · </span>{onlineCount()}</div>
      <ul>
        <li class="rail-spacer" style={{ height: `${topSpace()}px` }} aria-hidden="true" />
        <For each={page()}>
          {(p) => (
            <li ref={(el) => observeRow(el, p.id)} classList={{ off: !p.online, speaking: s.speaking.includes(p.id) }} title={p.game ? `${p.name} · Playing ${p.game}` : p.name}>
              <span class="rail-av"><Avatar id={p.id} size={28} /><Show when={p.online}><i class="rail-dot" /></Show></span>
              <span class="rail-text">
                <span class="rail-name">{p.name}</span>
                <Show when={p.game} fallback={<Show when={p.voice}><span class="rail-sub">In voice</span></Show>}>
                  <span class="rail-sub game">Playing {p.game}</span>
                </Show>
              </span>
            </li>
          )}
        </For>
        <li class="rail-spacer" style={{ height: `${bottomSpace()}px` }} aria-hidden="true" />
      </ul>
    </aside>
  );
}
