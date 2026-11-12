// Attachments under a message: images and GIFs inline (box reserved from the
// known size so the list never jumps), videos with controls, other files as
// a download card. GIF loops are silent videos that only play while visible.
import { createSignal, For, onCleanup, onMount, Show, Switch, Match } from "solid-js";
import { Portal } from "solid-js/web";
import { call } from "../ipc";
import { fitBox, fmtSize, isGif, isImage, isVideo, mediaUrl } from "../media";
import type { Attachment } from "../types";

const open = (url: string) => call("open_url", { url }).catch(() => {});

/** Plays only while on screen (offscreen loops cost nothing). */
function LoopVideo(p: { src: string; poster?: string; w: number; h: number; label: string }) {
  let v!: HTMLVideoElement;
  onMount(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) v.play().catch(() => {}); else v.pause(); });
    io.observe(v);
    onCleanup(() => io.disconnect());
  });
  return <video ref={v} class="media" src={p.src} poster={p.poster || undefined} muted loop playsinline preload="metadata" aria-label={p.label}
    style={{ width: `${p.w}px`, height: `${p.h}px` }} />;
}

export function Lightbox(p: { a: Attachment; close: () => void }) {
  onMount(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); p.close(); } };
    window.addEventListener("keydown", k, true);
    onCleanup(() => window.removeEventListener("keydown", k, true));
  });
  return (
    <Portal>
      <div class="lightbox" role="dialog" aria-label={p.a.name} onClick={p.close}>
        <Show when={isVideo(p.a)} fallback={<img src={mediaUrl(p.a)} alt={p.a.name} onClick={(e) => e.stopPropagation()} />}>
          <video src={mediaUrl(p.a)} controls autoplay loop={isGif(p.a)} muted={isGif(p.a)} onClick={(e) => e.stopPropagation()} />
        </Show>
        <div class="lightbox-bar" onClick={(e) => e.stopPropagation()}>
          <span class="lightbox-name">{p.a.name}</span>
          <Show when={!p.a.url}><button class="pill" onClick={() => open(mediaUrl(p.a))}>Open original</button></Show>
          <button class="pill" onClick={p.close}>Close</button>
        </div>
      </div>
    </Portal>
  );
}

export default function Attachments(p: { list: Attachment[]; remeasure: () => void }) {
  const [big, setBig] = createSignal<Attachment | null>(null);
  return (
    <div class="attachments">
      <For each={p.list}>
        {(a) => {
          const box = fitBox(a.width, a.height);
          return (
            <Switch fallback={
              <button class="file-card" onClick={() => open(mediaUrl(a))} title="Download">
                <span class="file-icon" aria-hidden="true">{(a.name.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE"}</span>
                <span class="file-meta"><span class="file-name">{a.name}</span><span class="muted small">{fmtSize(a.size)} · Download</span></span>
              </button>
            }>
              <Match when={isVideo(a) && isGif(a)}>
                <button class="media-btn" onClick={() => setBig(a)} aria-label={`GIF: ${a.name}`}>
                  <LoopVideo src={mediaUrl(a)} poster={a.preview} w={box.w} h={box.h} label={a.name} />
                  <span class="gif-tag">GIF</span>
                </button>
              </Match>
              <Match when={isVideo(a)}>
                <video class="media" src={mediaUrl(a)} controls preload="metadata" style={{ width: `${box.w}px`, height: `${box.h}px` }}
                  onLoadedMetadata={() => p.remeasure()} />
              </Match>
              <Match when={isImage(a)}>
                <button class="media-btn" onClick={() => setBig(a)} aria-label={`Image: ${a.name}`}>
                  <img class="media" src={mediaUrl(a)} alt={a.name} loading="lazy" decoding="async"
                    style={{ width: `${box.w}px`, height: `${box.h}px` }} onLoad={() => !a.width && p.remeasure()} />
                  <Show when={isGif(a)}><span class="gif-tag">GIF</span></Show>
                </button>
              </Match>
            </Switch>
          );
        }}
      </For>
      <Show when={big()}>{(a) => <Lightbox a={a()} close={() => setBig(null)} />}</Show>
    </div>
  );
}
