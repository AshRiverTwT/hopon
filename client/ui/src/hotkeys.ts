// In-app keyboard shortcuts (window focused) plus the global overlay key.
// A combo is "Ctrl+Alt+Shift+<KeyboardEvent.code>", modifiers in that order.

export type Action =
  | "nextChannel" | "prevChannel" | "nextUnread" | "prevUnread"
  | "nextServer" | "prevServer"
  | "toggleMute" | "toggleDeafen" | "toggleGames" | "focusComposer"
  | "zoomIn" | "zoomOut" | "zoomReset" | "overlay";

export const ACTIONS: { id: Action; label: string }[] = [
  { id: "nextChannel", label: "Next channel" },
  { id: "prevChannel", label: "Previous channel" },
  { id: "nextUnread", label: "Next unread channel" },
  { id: "prevUnread", label: "Previous unread channel" },
  { id: "nextServer", label: "Next server" },
  { id: "prevServer", label: "Previous server" },
  { id: "toggleMute", label: "Mute / unmute" },
  { id: "toggleDeafen", label: "Deafen / undeafen" },
  { id: "toggleGames", label: "Games panel" },
  { id: "focusComposer", label: "Jump to message box" },
  { id: "zoomIn", label: "Zoom in" },
  { id: "zoomOut", label: "Zoom out" },
  { id: "zoomReset", label: "Reset zoom" },
  { id: "overlay", label: "In-game overlay (works in games)" },
];

export const DEFAULT_HOTKEYS: Record<Action, string> = {
  nextChannel: "Alt+ArrowDown",
  prevChannel: "Alt+ArrowUp",
  nextUnread: "Alt+Shift+ArrowDown",
  prevUnread: "Alt+Shift+ArrowUp",
  nextServer: "Ctrl+Alt+ArrowDown",
  prevServer: "Ctrl+Alt+ArrowUp",
  toggleMute: "Ctrl+Shift+KeyM",
  toggleDeafen: "Ctrl+Shift+KeyD",
  toggleGames: "Ctrl+KeyG",
  focusComposer: "Ctrl+KeyT",
  zoomIn: "Ctrl+Equal",
  zoomOut: "Ctrl+Minus",
  zoomReset: "Ctrl+Digit0",
  overlay: "Alt+Backquote",
};

const MODS = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

/** Combo for a key event, or null for a bare modifier press. */
export function comboOf(e: KeyboardEvent): string | null {
  if (MODS.has(e.code) || !e.code) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.code].filter(Boolean).join("+");
}

const NAMES: Record<string, string> = {
  ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Backquote: "`", Equal: "=", Minus: "-",
  BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
  Space: "Space", Enter: "Enter", Tab: "Tab", Escape: "Esc", Backspace: "Backspace", PageUp: "PgUp", PageDown: "PgDn",
};

export function comboLabel(c: string): string {
  if (!c) return "Not set";
  return c.split("+").map((p) => NAMES[p] ?? p.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ")).join(" + ");
}

/** Combos the in-app handler must never take (text editing, system). */
export const RESERVED = new Set(["Ctrl+KeyC", "Ctrl+KeyV", "Ctrl+KeyX", "Ctrl+KeyA", "Ctrl+KeyZ", "Ctrl+KeyY", "Alt+F4", "Escape", "Enter", "Tab"]);
