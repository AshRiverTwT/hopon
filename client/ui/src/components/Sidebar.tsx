import { For, Show, createSignal } from "solid-js";
import { call } from "../ipc";
import { currentServer, s, selectChannel, selectServer, toast, userName } from "../store";
import type { Channel } from "../types";
import { Modal } from "./Modal";

export function ServerRail() {
  const [open, setOpen] = createSignal(false);
  return (
    <nav class="rail">
      <For each={s.servers}>
        {(sv) => (
          <button class="srv" classList={{ active: s.selServer === sv.id }} title={sv.name} onClick={() => selectServer(sv.id)}>
            {sv.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase()}
          </button>
        )}
      </For>
      <button class="srv add" title="Create or join a server" onClick={() => setOpen(true)}>+</button>
      <Show when={open()}><AddServer close={() => setOpen(false)} /></Show>
    </nav>
  );
}

function AddServer(p: { close: () => void }) {
  const [name, setName] = createSignal("");
  const [code, setCode] = createSignal("");
  const create = async () => {
    try { selectServer(await call<string>("create_server", { name: name() })); p.close(); } catch (e) { toast(String(e)); }
  };
  const join = async () => {
    try { selectServer(await call<string>("join_invite", { code: code() })); p.close(); } catch (e) { toast(String(e)); }
  };
  return (
    <Modal title="Add a server" close={p.close}>
      <label>Create a server</label>
      <div class="row">
        <input placeholder="Server name" value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
        <button class="primary" disabled={!name().trim()} onClick={create}>Create</button>
      </div>
      <label>Join with an invite</label>
      <div class="row">
        <input placeholder="hopon://invite/AbC123xyz0 or code" value={code()} onInput={(e) => setCode(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && join()} />
        <button class="primary" disabled={!code().trim()} onClick={join}>Join</button>
      </div>
    </Modal>
  );
}

export function ChannelList() {
  const sv = currentServer;
  const [invite, setInvite] = createSignal<string | null>(null);
  const [newCh, setNewCh] = createSignal<null | boolean>(null);
  const mkInvite = async () => {
    try { setInvite(await call<string>("create_invite", { serverId: s.selServer })); } catch (e) { toast(String(e)); }
  };
  const voiceMembers = (c: Channel) => Object.values(s.presence).filter((p) => p.channelId === c.id);
  const joinVoice = (c: Channel) => {
    if (s.voice.channelId === c.id) return;
    call("voice_join", { channelId: c.id }).catch((e) => toast(String(e)));
  };
  const isOwner = () => sv()?.ownerId === s.user?.id;
  return (
    <aside class="channels">
      <Show when={sv()} fallback={<div class="empty-side">Create or join a server with +</div>}>
        <header class="srv-head">
          <span>{sv()!.name}</span>
          <button class="ghost" title="Invite people" onClick={mkInvite}>Invite</button>
        </header>
        <div class="section">Text channels <Show when={isOwner()}><button class="ghost tiny" onClick={() => setNewCh(false)}>+</button></Show></div>
        <For each={sv()!.channels.filter((c) => !c.voice)}>
          {(c) => (
            <button class="ch" classList={{ active: s.selChannel === c.id, unread: !!s.unread[c.id] }} onClick={() => selectChannel(c.id)}>
              <span class="hash">#</span>{c.name}
            </button>
          )}
        </For>
        <div class="section">Voice channels <Show when={isOwner()}><button class="ghost tiny" onClick={() => setNewCh(true)}>+</button></Show></div>
        <For each={sv()!.channels.filter((c) => c.voice)}>
          {(c) => (
            <>
              <button
                class="ch"
                classList={{ active: s.voice.channelId === c.id }}
                // Hover pre-fetches the join grant so the click goes straight to the SFU.
                onMouseEnter={() => call("voice_prepare", { channelId: c.id }).catch(() => {})}
                onClick={() => joinVoice(c)}
              >
                <span class="hash">🔊</span>{c.name}
              </button>
              <For each={voiceMembers(c)}>
                {(p) => (
                  <div class="vmember" classList={{ speaking: s.speaking.includes(p.userId) }}>
                    <span class="dot" />{userName(p.userId)}
                    <Show when={p.muted}><span class="ico" title="Muted">🎙̸</span></Show>
                    <Show when={p.deafened}><span class="ico" title="Deafened">🔇</span></Show>
                  </div>
                )}
              </For>
            </>
          )}
        </For>
      </Show>
      <Show when={invite()}>
        <Modal title="Invite link" close={() => setInvite(null)}>
          <p class="muted">Valid for 7 days. Anyone with it can join.</p>
          <div class="row">
            <input readonly value={invite()!} onFocus={(e) => e.currentTarget.select()} />
            <button class="primary" onClick={() => { navigator.clipboard.writeText(invite()!); toast("Copied"); }}>Copy</button>
          </div>
        </Modal>
      </Show>
      <Show when={newCh() !== null}>
        <NewChannel voice={newCh()!} close={() => setNewCh(null)} />
      </Show>
    </aside>
  );
}

function NewChannel(p: { voice: boolean; close: () => void }) {
  const [name, setName] = createSignal("");
  const go = async () => {
    try { await call("create_channel", { serverId: s.selServer, name: name(), voice: p.voice }); p.close(); } catch (e) { toast(String(e)); }
  };
  return (
    <Modal title={p.voice ? "New voice channel" : "New text channel"} close={p.close}>
      <div class="row">
        <input placeholder="channel-name" value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && go()} autofocus />
        <button class="primary" disabled={!name().trim()} onClick={go}>Create</button>
      </div>
    </Modal>
  );
}

export function MemberList() {
  return (
    <aside class="members">
      <div class="section">Members — {currentServer()?.members.length ?? 0}</div>
      <For each={currentServer()?.members ?? []}>
        {(m) => <div class="member" classList={{ speaking: s.speaking.includes(m.id) }}>{m.name}</div>}
      </For>
    </aside>
  );
}
