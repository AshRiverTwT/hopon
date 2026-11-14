import { createSignal, For, Show } from "solid-js";
import { call } from "../ipc";
import { currentServer, isOwner, jumpTo, loadMoreMembers, loadOlder, realServers, s, selectChannel, selectServer, serverUsers, toast, userName } from "../store";
import { Confirm } from "./ServerSettings";
import { Overlay } from "./Overlay";
import { Avatar } from "./Avatar";
import { createMemo } from "solid-js";
import { savedMessages } from "../localFeatures";

export function BookmarksSheet(p: { close: () => void }) {
  const items = createMemo(() => savedMessages().map((saved) => ({
    ...saved,
    channel: s.servers.flatMap((server) => server.channels).find((channel) => channel.id === saved.channelId),
    message: s.selChannel === saved.channelId ? s.msgs.find((message) => message.id === saved.messageId) : undefined,
  })));
  return <Overlay title="Saved messages" close={p.close}>
    <ol class="index">
      <For each={items()} fallback={<li class="muted">Saved messages will appear here.</li>}>
        {(item) => <li><button class="index-row" disabled={!item.channel} onClick={async () => {
          if (item.channel) {
            const server = s.servers.find((entry) => entry.channels.some((channel) => channel.id === item.channelId));
            if (server && server.id !== s.selServer) selectServer(server.id);
            await selectChannel(item.channelId);
            await jumpTo(item.messageId);
          }
          p.close();
        }}>
          <span class="index-name">{item.channel?.name ?? "Channel unavailable"}</span>
          <span class="index-meta">{item.message ? `${userName(item.message.authorId)} · ${item.message.content}` : "Open its channel to view this message"}</span>
        </button></li>}
      </For>
    </ol>
  </Overlay>;
}

export function SearchSheet(p: { close: () => void }) {
  const [query, setQuery] = createSignal("");
  const [searchingOlder, setSearchingOlder] = createSignal(false);
  const matches = createMemo(() => {
    const q = query().trim().toLocaleLowerCase();
    return q ? s.msgs.filter((message) => message.content.toLocaleLowerCase().includes(q)).slice(-100).reverse() : [];
  });
  return <Overlay title="Search this channel" close={p.close}>
    <input class="line big" autofocus placeholder="Search loaded messages" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
    <ol class="index">
      <For each={matches()} fallback={<li class="muted">Enter a word or phrase to search this channel.</li>}>
        {(message) => <li><button class="index-row" onClick={() => { void jumpTo(message.id); p.close(); }}>
          <span class="index-name">{userName(message.authorId)}</span><span class="index-meta">{message.content}</span>
        </button></li>}
      </For>
    </ol>
    <Show when={s.more && s.msgs.length && query().trim()}>
      <button class="pill" disabled={searchingOlder()} onClick={async () => {
        setSearchingOlder(true);
        try {
          for (let page = 0; page < 8 && s.more && s.selChannel; page++) await loadOlder();
        } catch (error) { toast(String(error)); }
        finally { setSearchingOlder(false); }
      }}>{searchingOlder() ? "Searching older messages…" : "Search older messages"}</button>
    </Show>
  </Overlay>;
}

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
        <For each={realServers()} fallback={<li class="muted">You are not in any server yet.</li>}>
          {(sv, i) => (
            <li>
              <button class="index-row" classList={{ current: s.selServer === sv.id }} onClick={() => { selectServer(sv.id); p.close(); }}>
                <span class="index-no">{String(i() + 1).padStart(2, "0")}</span>
                <span class="index-name">{sv.name}</span>
                <span class="index-meta">{sv.memberCount} {sv.memberCount === 1 ? "member" : "members"}</span>
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
        <For each={[...serverUsers(currentServer())].sort((a, b) => Number(!!s.online[b.id]) - Number(!!s.online[a.id]) || a.name.localeCompare(b.name))}>
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
      <Show when={currentServer() && currentServer()!.memberIds.length < currentServer()!.memberCount}>
        <button class="link" onClick={() => currentServer() && loadMoreMembers(currentServer()!.id)}>Load more people ({currentServer()!.memberIds.length}/{currentServer()!.memberCount})</button>
      </Show>
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
