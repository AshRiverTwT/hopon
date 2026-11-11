import { invoke, Channel } from "@tauri-apps/api/core";
import type { UiEvent } from "./types";

/** Unix ms with µs precision, same clock as the Rust core's SystemTime. */
export const now = () => performance.timeOrigin + performance.now();

export const call = invoke;

export function subscribe(onEvent: (e: UiEvent) => void) {
  const ch = new Channel<UiEvent>();
  ch.onmessage = onEvent;
  return invoke("ui_subscribe", { events: ch });
}

// Paint stamps are batched and reported once per frame at most.
let marks: [string, number][] = [];
let markTimer = 0;
export function markPainted(keys: string[]) {
  if (!keys.length) return;
  // setTimeout(0) from inside rAF runs after the frame has been rendered.
  setTimeout(() => {
    const t = now();
    for (const k of keys) marks.push([k, t]);
    if (!markTimer) {
      markTimer = window.setTimeout(() => {
        markTimer = 0;
        const m = marks;
        marks = [];
        invoke("perf_painted", { marks: m }).catch(() => {});
      }, 50);
    }
  }, 0);
}

export function randomNonce(): string {
  // 52 random bits: exact in a JS number, non-zero.
  const hi = Math.floor(Math.random() * 0xfffff);
  const lo = Math.floor(Math.random() * 0xffffffff);
  return String(hi * 0x100000000 + lo + 1);
}
