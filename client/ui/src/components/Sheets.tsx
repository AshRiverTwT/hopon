import { createSignal, For, Show } from "solid-js";
import { call } from "../ipc";
import { currentServer, isOwner, s, selectServer, toast } from "../store";
import { Confirm } from "./ServerSettings";
import { Overlay } from "./Overlay";
import { Avatar } from "./Avatar";

export function ServersSheet(p: { close: () => void }) {
  const [name, setName] = createSignal("");
  const [code, setCode] = createSignal("");
  const create = async () => {
    try { selectServer(await call<string>("create_server", { name: name() })); p.close(); } catch (e) { toast(String(e)); }
  };
  const join = async () => {
    try { selectServer(await call<string>("join_invite", { code: code() })); p.close(); } catch (e) { toast(String(e)); }
  };
  return (
    <Overlay title="Servers" close={p.close}>
      <ol class="index">
        <For each={s.servers} fallback={<li class="muted">You are not in any server yet.</li>}>
          {(sv, i) => (
            <li>
              <button class="index-row" classList={{ current: s.selServer === sv.id }} onClick={() => { selectServer(sv.id); p.close(); }}>
                <span class="index-no">{String(i() + 1).padStart(2, "0")}</span>
                <span class="index-name">{sv.name}</span>
                <span class="index-meta">{sv.members.length} {sv.members.length === 1 ? "member" : "members"}</span>
              </button>
            </li>
          )}
        </For>
      </ol>
      <div class="split">
        <div>
          <div class="eyebrow">Start a server</div>
          <div class="field-row">
            <input class="line" placeholder="Name" value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && name().trim() && create()} />
            <button class="pill solid" disabled={!name().trim()} onClick={create}>Create</button>
          </div>
        </div>
        <div>
          <div class="eyebrow">Join with an invite</div>
          <div class="field-row">
            <input class="line" placeholder="hopon://invite/… or code" value={code()} onInput={(e) => setCode(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && code().trim() && join()} />
            <button class="pill solid" disabled={!code().trim()} onClick={join}>Join</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

export function MembersSheet(p: { close: () => void }) {
  const voiceOf = (id: string) => {
    const pr = s.presence[id];
    if (!pr) return null;
    return currentServer()?.channels.find((c) => c.id === pr.channelId)?.name ?? null;
  };
  return (
    <Overlay title="People" close={p.close}>
      <ol class="index">
        <For each={[...(currentServer()?.members ?? [])].sort((a, b) => Number(!!s.online[b.id]) - Number(!!s.online[a.id]) || a.name.localeCompare(b.name))}>
          {(m, i) => (
            <li class="index-row static">
              <span class="index-no">{String(i() + 1).padStart(2, "0")}</span>
              <span class="index-name" classList={{ offline: !s.online[m.id] }}><span class="avatar-wrap"><Avatar id={m.id} size={32} /><span class="presence" classList={{ on: !!s.online[m.id] }} /></span>{m.name}<Show when={s.speaking.includes(m.id)}><span class="live-dot" /></Show></span>
              <span class="index-meta">
                {m.id === currentServer()?.ownerId ? "Owner" : ""}
                <Show when={voiceOf(m.id)}>{(v) => <> · in {v()}</>}</Show>
              </span>
            </li>
          )}
        </For>
      </ol>
      <Show when={!isOwner() && currentServer()}>
        {(sv) => (
          <div class="leave-row">
            <span class="muted">Leave {sv().name}? You can rejoin with a new invite.</span>
            <Confirm name={sv().name} action="Leave server" onConfirm={async () => { await call("leave_server", { serverId: sv().id }); p.close(); }} />
          </div>
        )}
      </Show>
    </Overlay>
  );
}

export function InviteSheet(p: { link: string; close: () => void }) {
  return (
    <Overlay title="Invite" close={p.close}>
      <p class="lede">Anyone with this link can join {currentServer()?.name} for the next 7 days.</p>
      <div class="field-row">
        <input class="line big" readonly value={p.link} onFocus={(e) => e.currentTarget.select()} />
        <button class="pill solid" onClick={() => { navigator.clipboard.writeText(p.link); toast("Copied"); }}>Copy</button>
      </div>
    </Overlay>
  );
}

export function NewChannelSheet(p: { voice: boolean; close: () => void }) {
  const [name, setName] = createSignal("");
  const go = async () => {
    try { await call("create_channel", { serverId: s.selServer, name: name(), voice: p.voice }); p.close(); } catch (e) { toast(String(e)); }
  };
  return (
    <Overlay title={p.voice ? "New voice room" : "New channel"} close={p.close}>
      <div class="field-row">
        <input class="line big" placeholder="Name" value={name()} autofocus onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && name().trim() && go()} />
        <button class="pill solid" disabled={!name().trim()} onClick={go}>Create</button>
      </div>
    </Overlay>
  );
}
