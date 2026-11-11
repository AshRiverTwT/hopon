// User picture: a small square (not a circle), fixed size so it never changes
// a measured row height. Data URLs come from the core's SQLite cache.
import { createEffect, createSignal, Show } from "solid-js";
import { call } from "../ipc";
import { s } from "../store";

const urls = new Map<string, string | null>(); // "id:v" → data URL (null = loading / none)
const [loaded, setLoaded] = createSignal(0);

export function avatarV(id: string): number {
  if (s.user?.id === id) return s.user.avatarV;
  for (const sv of s.servers) for (const m of sv.members) if (m.id === id) return m.avatarV;
  return 0;
}

function nameOf(id: string): string {
  if (s.user?.id === id) return s.user.name;
  for (const sv of s.servers) for (const m of sv.members) if (m.id === id) return m.name;
  return "?";
}

export function Avatar(p: { id: string; size: number; class?: string }) {
  const key = () => `${p.id}:${avatarV(p.id)}`;
  createEffect(() => {
    const v = avatarV(p.id);
    const k = key();
    if (v === 0 || urls.has(k)) return;
    urls.set(k, null);
    call<string | null>("avatar", { userId: p.id, v }).then((u) => { urls.set(k, u); setLoaded((n) => n + 1); }).catch(() => {});
  });
  const url = () => { loaded(); return urls.get(key()) ?? null; };
  const box = () => ({ width: `${p.size}px`, height: `${p.size}px`, "font-size": `${Math.round(p.size * 0.46)}px` });
  return (
    <Show when={url()} fallback={<span class={`avatar initials ${p.class ?? ""}`} style={box()} aria-hidden="true">{nameOf(p.id).slice(0, 1).toUpperCase()}</span>}>
      <img class={`avatar ${p.class ?? ""}`} style={box()} width={p.size} height={p.size} src={url()!} alt="" draggable={false} />
    </Show>
  );
}

/** Center-crop and downscale a picked image to 128 px WebP bytes. */
export async function toAvatarBytes(file: File): Promise<number[]> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 128, 128);
  bmp.close();
  for (const q of [0.86, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", q));
    if (blob && blob.size <= 48 * 1024) return [...new Uint8Array(await blob.arrayBuffer())];
  }
  throw new Error("image too large after compression");
}
