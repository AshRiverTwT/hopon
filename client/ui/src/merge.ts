// Pure helpers for the open channel's message array (sorted by ID ascending).
// Kept free of Solid so they can be unit tested with node --test.
import { cmpId, type Msg } from "./types.ts";

/** Index of the message whose id equals `id`, or -1 (binary search). */
export function findId(list: readonly Msg[], id: string): number {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cmpId(list[mid].id, id);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

const isPending = (m: Msg) => m.id.startsWith("p");

/**
 * Merge incoming messages. Returns a new array plus the keys that changed
 * (for paint instrumentation). Pending local copies sit at the end and are
 * replaced by the server copy carrying the same nonce.
 */
export function mergeMsgs(list: Msg[], incoming: readonly Msg[]): { list: Msg[]; changed: string[] } {
  const confirmed = list.filter((m) => !isPending(m));
  let pending = list.filter(isPending);
  const changed: string[] = [];
  for (const m of incoming) {
    if (isPending(m)) {
      if (!pending.some((p) => p.nonce === m.nonce)) pending.push(m);
      changed.push(m.id);
      continue;
    }
    if (m.nonce) pending = pending.filter((p) => p.nonce !== m.nonce);
    const i = findId(confirmed, m.id);
    if (i >= 0) {
      // Keep the higher delivery state (durable ack may have arrived first).
      confirmed[i] = { ...m, state: Math.max(m.state, confirmed[i].state) };
    } else {
      const last = confirmed[confirmed.length - 1];
      if (!last || cmpId(last.id, m.id) < 0) confirmed.push(m);
      else {
        let lo = 0, hi = confirmed.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cmpId(confirmed[mid].id, m.id) < 0) lo = mid + 1; else hi = mid;
        }
        confirmed.splice(lo, 0, m);
      }
    }
    changed.push(m.id);
  }
  return { list: confirmed.concat(pending), changed };
}

/** Drop from the top so the open channel never holds more than `cap`. */
export function trimTop(list: Msg[], cap: number): Msg[] {
  return list.length > cap ? list.slice(list.length - cap) : list;
}

/** Group header shown when the author changes or 7 minutes pass. */
export function showsHeader(list: readonly Msg[], i: number): boolean {
  if (i === 0) return true;
  const a = list[i - 1], b = list[i];
  return a.authorId !== b.authorId || b.ts - a.ts > 7 * 60_000;
}
