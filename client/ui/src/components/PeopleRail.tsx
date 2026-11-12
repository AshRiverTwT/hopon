// Right-hand people column: online first, with what they're playing.
// Hidden while the games panel is open (it takes this space).
import { createMemo, For, Show } from "solid-js";
import { currentServer, s } from "../store";
import { Avatar } from "./Avatar";

export default function PeopleRail() {
  const people = createMemo(() => {
    const sv = currentServer();
    if (!sv) return [];
    const act = sv.activities ?? {};
    return [...sv.members]
      .map((m) => ({ ...m, online: !!s.online[m.id], game: act[m.id] ?? "", voice: !!s.presence[m.id]?.channelId }))
      .sort((a, b) => Number(b.online) - Number(a.online) || Number(!!b.game) - Number(!!a.game) || a.name.localeCompare(b.name));
  });
  const onlineCount = () => people().filter((p) => p.online).length;
  return (
    <aside class="rail" aria-label="People">
      <div class="eyebrow rail-head">Online · {onlineCount()}</div>
      <ul>
        <For each={people()}>
          {(p) => (
            <li classList={{ off: !p.online, speaking: s.speaking.includes(p.id) }} title={p.game ? `${p.name} · Playing ${p.game}` : p.name}>
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
      </ul>
    </aside>
  );
}
