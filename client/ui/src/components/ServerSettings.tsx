// Server settings. Owner: name, channels (rename, topic, delete), people
// (remove), invites, delete server. Members: leave. Destructive actions ask
// you to type the name back.
import { createSignal, For, Show, type JSX } from "solid-js";
import { call } from "../ipc";
import { currentServer, isOwner, loadMoreMembers, serverUsers, toast } from "../store";
import type { Channel } from "../types";
import { Avatar } from "./Avatar";
import { Overlay } from "./Overlay";
import { VoiceGlyph } from "./icons";

const err = (e: unknown) => toast(String(e));

/** Inline "type the name to confirm" for destructive actions. */
export function Confirm(p: { name: string; action: string; onConfirm: () => Promise<void>; children?: JSX.Element }) {
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

/** One channel: a compact line; click to edit its name and topic, or delete it. */
function ChannelRow(p: { c: Channel; open: boolean; toggle: () => void }) {
  return (
    <li class="ss-item" classList={{ open: p.open }}>
      <button class="ss-line" aria-expanded={p.open} onClick={p.toggle}>
        <span class="ss-glyph"><Show when={p.c.voice} fallback="#"><VoiceGlyph /></Show></span>
        <span class="ss-name">{p.c.name}</span>
        <span class="ss-meta">{p.c.voice ? "Voice" : p.c.topic}</span>
      </button>
      <Show when={p.open}>
        <div class="ss-edit">
          <Editable value={p.c.name} max={64} save={(name) => call("update_channel", { channelId: p.c.id, name, topic: null })} />
          <Show when={!p.c.voice}>
            <Editable value={p.c.topic} placeholder="Topic" max={256} save={(topic) => call("update_channel", { channelId: p.c.id, name: null, topic })} />
          </Show>
          <Confirm name={p.c.name} action="Delete channel" onConfirm={() => call("delete_channel", { channelId: p.c.id })}>
            <span class="muted small">Deletes it and all of its messages{p.c.voice ? " and ends the call" : ""}.</span>
          </Confirm>
        </div>
      </Show>
    </li>
  );
}

/** Invite link (anyone in the server can make one); the owner can revoke them all. */
function InviteRow(p: { serverId: string; owner: boolean }) {
  const [link, setLink] = createSignal("");
  const make = async () => { try { setLink(await call<string>("create_invite", { serverId: p.serverId })); } catch (e) { toast(String(e)); } };
  return (
    <div class="row">
      <span class="eyebrow">Invite</span>
      <div class="row-body">
        <Show when={link()} fallback={<div class="inline"><button class="pill solid" onClick={() => void make()}>Create invite link</button></div>}>
          <div class="inline">
            <input class="line ss-link" readonly value={link()} onFocus={(e) => e.currentTarget.select()} />
            <button class="pill solid" onClick={() => { void navigator.clipboard.writeText(link()); toast("Copied"); }}>Copy</button>
          </div>
        </Show>
        <div class="inline">
          <span class="muted small">Links work for 7 days.</span>
          <Show when={p.owner}>
            <button class="link" onClick={() => call("revoke_invites", { serverId: p.serverId }).then(() => { setLink(""); toast("All invite links revoked"); }).catch(err)}>Revoke all links</button>
          </Show>
        </div>
      </div>
    </div>
  );
}

export function ServerSettingsSheet(p: { close: () => void }) {
  const sv = currentServer;
  const [open, setOpen] = createSignal<string | null>(null);
  return (
    <Overlay title={currentServer()?.name ?? "Server"} close={p.close}>
      <Show when={sv()}>
        {(server) => (
          <div class="rows">
            <InviteRow serverId={server().id} owner={isOwner()} />
            <Show when={isOwner()} fallback={
              <div class="row">
                <span class="eyebrow">Leave</span>
                <div class="row-body"><Confirm name={server().name} action="Leave server" onConfirm={async () => { await call("leave_server", { serverId: server().id }); p.close(); }} /></div>
              </div>
            }>
              <div class="row">
                <span class="eyebrow">Name</span>
                <div class="row-body"><Editable value={server().name} max={64} class="big" save={(name) => call("rename_server", { serverId: server().id, name })} /></div>
              </div>
              <div class="row">
                <span class="eyebrow">Channels</span>
                <div class="row-body">
                  <ol class="ss-list">
                    <For each={[...server().channels.filter((c) => !c.voice), ...server().channels.filter((c) => c.voice)]}>
                      {(c) => <ChannelRow c={c} open={open() === c.id} toggle={() => setOpen((x) => (x === c.id ? null : c.id))} />}
                    </For>
                  </ol>
                </div>
              </div>
              <div class="row">
                <span class="eyebrow">People · {server().memberCount}</span>
                <div class="row-body">
                  <ol class="ss-list">
                    <For each={serverUsers(server())}>
                      {(m) => (
                        <li class="ss-item">
                          <div class="ss-line static">
                            <Avatar id={m.id} size={26} />
                            <span class="ss-name">{m.name}</span>
                            <span class="ss-meta">
                              <Show when={m.id === server().ownerId} fallback={
                                <Confirm name={m.name} action="Remove" onConfirm={() => call("kick_member", { serverId: server().id, userId: m.id })} />
                              }>Owner</Show>
                            </span>
                          </div>
                        </li>
                      )}
                    </For>
                  </ol>
                  <Show when={server().memberIds.length < server().memberCount}>
                    <button class="link" onClick={() => loadMoreMembers(server().id)}>Show more ({server().memberIds.length} of {server().memberCount})</button>
                  </Show>
                </div>
              </div>
              <div class="row">
                <span class="eyebrow">Delete</span>
                <div class="row-body">
                  <Confirm name={server().name} action="Delete server" onConfirm={async () => { await call("delete_server", { serverId: server().id }); p.close(); }}>
                    <span class="muted small">Every channel and message, for everyone. Can't be undone.</span>
                  </Confirm>
                </div>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Overlay>
  );
}
