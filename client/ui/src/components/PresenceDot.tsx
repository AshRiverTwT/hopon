// The small presence mark on an avatar: green online, amber moon idle, red
// do not disturb. Offline shows nothing; you see a hollow ring while invisible.
import { Show } from "solid-js";
import { presenceOf, SHOWN_LABEL } from "../profile";

export function PresenceDot(p: { id: string }) {
  const shown = () => presenceOf(p.id);
  return (
    <Show when={shown() !== "offline"}>
      <i class={`rail-dot ${shown()}`} title={SHOWN_LABEL[shown()]} aria-label={SHOWN_LABEL[shown()]} />
    </Show>
  );
}

/** Avatar plus presence, the way rows show people. */
export function StatusLine(p: { emoji: string; text: string }) {
  return <><Show when={p.emoji}><span class="status-emoji">{p.emoji}</span></Show>{p.text}</>;
}
