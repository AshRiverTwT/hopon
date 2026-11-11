import { render } from "solid-js/web";
import App from "./App";
import { call, now, subscribe } from "./ipc";
import { onEvent } from "./store";
import "./styles.css";

// No context menu / reload shortcuts in the shipped app.
if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", (e) => { if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) e.preventDefault(); });
}

render(() => <App />, document.getElementById("root")!);
subscribe(onEvent);
// Report the first painted frame (window is shown by the core at that point).
requestAnimationFrame(() => setTimeout(() => call("ui_ready", { tPaintMs: now() }), 0));
