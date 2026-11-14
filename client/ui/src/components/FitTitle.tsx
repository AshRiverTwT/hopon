// The big display title in the top row, sized to fit its column: it shrinks
// (down to a floor) when the column narrows, e.g. with Games open, and only
// cuts off with "…" for very long names. `reserve` is room for the icons beside it.
export function FitTitle(p: { text: string; reserve?: number }) {
  return (
    <h1 class="display title fit-title" title={p.text}
      style={{ "--n": String(Math.max(4, p.text.length)), "--reserve": `${p.reserve ?? 180}px` }}>{p.text}</h1>
  );
}
