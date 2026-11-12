// Shown when the server refuses this app's version: update in one click.
import { createEffect, Show } from "solid-js";
import { s } from "../store";
import { checkUpdate, installUpdate, upd } from "../update";

export default function UpdatePrompt() {
  const blocked = () => s.conn.state === "incompatible";
  // Refresh what's available the moment the server says no.
  createEffect(() => { if (blocked()) void checkUpdate(); });
  return (
    <Show when={blocked()}>
      <div class="update-gate" role="dialog" aria-label="Update needed">
        <div class="update-card">
          <div class="eyebrow">Update needed</div>
          <Show when={upd.checked} fallback={<p class="lede">Checking for a new version…</p>}>
            <Show when={upd.available} fallback={
              <>
                <h2 class="display">Server needs updating</h2>
                <p class="lede">You're on the newest HopOn ({upd.current}), but the server runs a different version. Ask the server owner to update it.</p>
                <Show when={upd.error}><p class="err">{upd.error}</p></Show>
              </>
            }>
              <h2 class="display">HopOn {upd.latest}</h2>
              <p class="lede">The server runs a newer HopOn. Update to keep chatting: it downloads, installs and reopens by itself.</p>
              <Show when={upd.error}><p class="err">{upd.error}</p></Show>
              <button class="pill solid big" disabled={upd.installing} onClick={() => installUpdate()}>
                {upd.installing ? "Downloading…" : "Update now"}
              </button>
              <p class="muted small">You're on {upd.current}.</p>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}
