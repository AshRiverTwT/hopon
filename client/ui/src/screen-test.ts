// Dev-only: drives screen.ts against a real LiveKit server (not in the build).
import { mockIPC } from "@tauri-apps/api/mocks";
const q = new URLSearchParams(location.search);
mockIPC((cmd) => (cmd === "screen_grant" ? [q.get("url"), q.get("token")] : null));
const screen = await import("./screen");
(window as unknown as Record<string, unknown>).__screen = screen;
(window as unknown as Record<string, unknown>).__ready = true;
