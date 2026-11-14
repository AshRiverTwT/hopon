import { createSignal } from "solid-js";

export interface SavedMessage { channelId: string; messageId: string }
const read = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
};
const [favorites, setFavorites] = createSignal<string[]>(read("hopon.favorites", []));
const [bookmarks, setBookmarks] = createSignal<SavedMessage[]>(read("hopon.bookmarks", []));
export const isFavorite = (channelId: string) => favorites().includes(channelId);
export function toggleFavorite(channelId: string) {
  const next = isFavorite(channelId) ? favorites().filter((id) => id !== channelId) : [...favorites(), channelId];
  setFavorites(next);
  localStorage.setItem("hopon.favorites", JSON.stringify(next));
}
export const savedMessages = bookmarks;
export const isBookmarked = (channelId: string, messageId: string) => bookmarks().some((m) => m.channelId === channelId && m.messageId === messageId);
export function toggleBookmark(channelId: string, messageId: string) {
  const next = isBookmarked(channelId, messageId)
    ? bookmarks().filter((m) => m.channelId !== channelId || m.messageId !== messageId)
    : [...bookmarks(), { channelId, messageId }];
  setBookmarks(next);
  localStorage.setItem("hopon.bookmarks", JSON.stringify(next));
}
