// Server settings. Owner: name, channels (rename, topic, delete), people
// (remove), invites, delete server. Members: leave. Destructive actions ask
// you to type the name back.
import { createSignal, For, Show, type JSX } from "solid-js";
import { call } from "../ipc";
import { currentServer, isOwner, toast } from "../store";
import type { Channel } from "../types";
import { Avatar } from "./Avatar";
import { Overlay } from "./Overlay";
import { VoiceGlyph } from "./icons";

const err = (e: unknown) => toast(String(e));

/** Inline "type the name to confirm" for destructive actions. */
function Confirm(p: { name: string; action: string; onConfirm: () => Promise<void>; children?: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const go = async () => {
    setBusy(true);
    try { await p.onConfirm(); setOpen(false); } catch (e) { err(e); } finally { setBusy(false); }
  };
  return (
    <Show when={open()} fallback={<button class="link danger" onClick={() => setOpen(true)}>{p.action}</button>}>
      <div class="confirm">
        {p.children}
        <span class="muted small">Type <b>{p.name}</b> to confirm</span>
        <input class="line" value={typed()} autofocus onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && typed() === p.name && go()} />
        <button class="pill danger" disabled={typed() !== p.name || busy()} onClick={go}>{p.action}</button>
        <button class="link" onClick={() => { setOpen(false); setTyped(""); }}>Cancel</button>
      </div>
    </Show>
  );
}

function Editable(p: { value: string; placeholder?: string; max: number; save: (v: string) => Promise<void>; class?: string }) {
  const [v, setV] = createSignal(p.value);
  const dirty = () => v().trim() !== p.value;
  const save = () => p.save(v().trim()).catch((e) => { err(e); setV(p.value); });
  return (
    <div class="field-row editable">
      <input class={`line ${p.class ?? ""}`} value={p.value} placeholder={p.placeholder} maxLength={p.max}
        onInput={(e) => setV(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && dirty() && save()} />
      <Show when={dirty()}><button class="pill solid" onClick={save}>Save</button></Show>
    </div>
  );
}

function ChannelRow(p: { c: Channel }) {
  return (
    <li class="admin-row">
      <div class="admin-row-head">
        <Show when={p.c.voice} fallback={<span class="kind">Text</span>}><span class="kind"><VoiceGlyph /> Voice</span></Show>
        <Confirm name={p.c.name} action="Delete channel" onConfirm={() => call("delete_channel", { channelId: p.c.id })}>
          <span class="muted small">Deletes the channel and all of its messages{p.c.voice ? " and ends the call" : ""}.</span>
        </Confirm>
      </div>
      <Editable value={p.c.name} max={64} class="big" save={(name) => call("update_channel", { channelId: p.c.id, name, topic: null })} />
      <Show when={!p.c.voice}>
        <Editable value={p.c.topic} placeholder="Topic (optional)" max={256} save={(topic) => call("update_channel", { channelId: p.c.id, name: null, topic })} />
      </Show>
    </li>
  );
}

export function ServerSettingsSheet(p: { close: () => void }) {
  const sv = currentServer;
  return (
    <Overlay title={isOwner() ? "Server" : "Membership"} close={p.close}>
      <Show when={sv()}>
        {(server) => (
          <Show when={isOwner()} fallback={
            <div class="admin">
              <p class="lede">You're a member of {server().name}.</p>
              <Confirm name={server().name} action="Leave server" onConfirm={async () => { await call("leave_server", { serverId: server().id }); p.close(); }} />
            </div>
          }>
            <div class="admin">
              <section>
                <div class="eyebrow">Name</div>
                <Editable value={server().name} max={64} class="big" save={(name) => call("rename_server", { serverId: server().id, name })} />
              </section>

              <section>
                <div class="eyebrow">Channels</div>
                <ol class="admin-list">
                  <For each={server().channels}>{(c) => <ChannelRow c={c} />}</For>
                </ol>
              </section>

              <section>
                <div class="eyebrow">People</div>
                <ol class="admin-list">
                  <For each={server().members}>
                    {(m) => (
                      <li class="admin-row person">
                        <Avatar id={m.id} size={32} />
                        <span class="person-name">{m.name}</span>
                        <Show when={m.id === server().ownerId} fallback={
                          <Confirm name={m.name} action="Remove" onConfirm={() => call("kick_member", { serverId: server().id, userId: m.id })} />
                        }><span class="muted small">Owner</span></Show>
                      </li>
                    )}
                  </For>
                </ol>
              </section>

              <section>
                <div class="eyebrow">Invites</div>
                <div class="field-row">
                  <span class="muted">Links you've shared stop working immediately.</span>
                  <button class="pill" onClick={() => call("revoke_invites", { serverId: server().id }).then(() => toast("All invite links revoked")).catch(err)}>Revoke all invites</button>
                </div>
              </section>

              <section class="danger-zone">
                <div class="eyebrow">Delete server</div>
                <Confirm name={server().name} action="Delete server" onConfirm={async () => { await call("delete_server", { serverId: server().id }); p.close(); }}>
                  <span class="muted small">Removes every channel and message for everyone. This can't be undone.</span>
                </Confirm>
              </section>
            </div>
          </Show>
        )}
      </Show>
    </Overlay>
  );
}
