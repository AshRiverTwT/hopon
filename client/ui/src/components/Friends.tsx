// Friends and direct messages. Friends mode swaps the channel dial for your
// conversations and the people column for online friends; the middle is the
// friends home (add by username, requests, everyone) or an open DM, which is
// the ordinary chat (message list + composer) on the DM's one channel.
import { createMemo, createSignal, For, Show } from "solid-js";
import { call } from "../ipc";
import { closeFriends, currentDm, friendOf, isUnread, openDm, openFriends, s, toast, userName } from "../store";
import type { Friend } from "../types";
import { Avatar } from "./Avatar";
import { BookmarkIcon, SearchIcon } from "./icons";

const err = (e: unknown) => toast(String(e).replace(/^Error: /, ""));
const gameOf = (userId: string) => {
  for (const sv of s.servers) { const g = sv.activities?.[userId]; if (g) return g; }
  return "";
};
const sortFriends = (list: Friend[]) =>
  [...list].sort((a, b) => Number(!!s.online[b.user.id]) - Number(!!s.online[a.user.id]) || a.user.name.localeCompare(b.user.name));

/** Left column in friends mode: Friends home + your conversations. */
export function FriendsNav() {
  // Conversations: every DM you have (also with people you're no longer friends with).
  const dms = createMemo(() => s.servers.filter((x) => x.dmWith).map((x) => ({ sv: x, user: x.dmWith! }))
    .sort((a, b) => (b.sv.channels[0]?.lastId ?? "0").localeCompare(a.sv.channels[0]?.lastId ?? "0", undefined, { numeric: true })));
  const incoming = () => s.friends.filter((f) => f.state === "incoming").length;
  return (
    <nav class="dm-nav" aria-label="Direct messages">
      <div class="eyebrow dm-nav-head">Direct messages</div>
      <ul>
        <For each={dms()} fallback={<li class="dm-empty muted small">Message a friend and it shows up here.</li>}>
          {(d) => {
            const unread = () => d.sv.channels.some((c) => isUnread(c)) && currentDm()?.id !== d.sv.id;
            return (
              <li>
                <button class="dm-row" classList={{ on: currentDm()?.id === d.sv.id, unread: unread() }} onClick={() => openDm(d.user)}>
                  <span class="rail-av"><Avatar id={d.user} size={28} /><Show when={s.online[d.user]}><i class="rail-dot" /></Show></span>
                  <span class="dm-name">{userName(d.user)}</span>
                  <Show when={unread()}><i class="dm-unread" aria-label="New messages" /></Show>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </nav>
  );
}

/** Middle in friends mode with no DM open. */
export function FriendsHome() {
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const requests = () => s.friends.filter((f) => f.state !== "friends").sort((a, b) => (a.state === "incoming" ? -1 : 1) - (b.state === "incoming" ? -1 : 1));
  const friends = createMemo(() => sortFriends(s.friends.filter((f) => f.state === "friends")));
  const send = async () => {
    const n = name().trim().replace(/^@/, "");
    if (!n || busy()) return;
    setBusy(true);
    try {
      await call("friend_request", { username: n });
      setName("");
      // The friendship update lands just after the reply: they may have asked you first.
      setTimeout(() => {
        const f = s.friends.find((x) => x.username.toLowerCase() === n.toLowerCase());
        toast(f?.state === "friends" ? `You and ${f.user.name} are friends now` : `Friend request sent to ${n}`);
      }, 300);
    }
    catch (e) { err(e); }
    finally { setBusy(false); }
  };
  const respond = (f: Friend, accept: boolean) => call("friend_respond", { userId: f.user.id, accept }).catch(err);
  const remove = (f: Friend) => { setConfirm(null); call("friend_remove", { userId: f.user.id }).catch(err); };
  const copy = () => navigator.clipboard?.writeText(s.username).then(() => toast("Username copied")).catch(() => {});
  return (
    <section class="friends">
      <div class="friend-add">
        <div class="field-row">
          <input class="line big" placeholder="Add a friend by username" value={name()} spellcheck={false} autocomplete="off"
            onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void send()} />
          <button class="pill solid" disabled={!name().trim() || busy()} onClick={() => void send()}>{busy() ? "Sending…" : "Send request"}</button>
        </div>
        <p class="muted small">Your username is <button class="link inline" title="Copy" onClick={copy}><strong>{s.username}</strong></button>. Share it so friends can add you.</p>
      </div>

      <Show when={requests().length}>
        <section>
          <div class="eyebrow friends-head">Requests · {requests().length}</div>
          <ol class="index people">
            <For each={requests()}>
              {(f) => (
                <li class="index-row static">
                  <span class="index-name"><Avatar id={f.user.id} size={40} />{f.user.name}<span class="handle">@{f.username}</span></span>
                  <span class="index-meta">
                    <Show when={f.state === "incoming"} fallback={<><span>Waiting for them</span><button class="link" onClick={() => remove(f)}>Cancel</button></>}>
                      <button class="pill solid" onClick={() => respond(f, true)}>Accept</button>
                      <button class="pill ghost" onClick={() => respond(f, false)}>Decline</button>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ol>
        </section>
      </Show>

      <section>
        <div class="eyebrow friends-head">Friends · {friends().length}</div>
        <ol class="index people">
          <For each={friends()} fallback={<li class="muted lede friends-empty">No friends yet. Add someone by their username above.</li>}>
            {(f) => (
              <li class="index-row static" classList={{ off: !s.online[f.user.id] }}>
                <span class="index-name">
                  <span class="rail-av"><Avatar id={f.user.id} size={40} /><Show when={s.online[f.user.id]}><i class="rail-dot" /></Show></span>
                  {f.user.name}
                  <span class="handle">{gameOf(f.user.id) ? <span class="game">Playing {gameOf(f.user.id)}</span> : s.online[f.user.id] ? "Online" : "Offline"}</span>
                </span>
                <span class="index-meta">
                  <button class="pill" onClick={() => openDm(f.user.id)}>Message</button>
                  <Show when={confirm() === f.user.id} fallback={<button class="link" onClick={() => setConfirm(f.user.id)}>Remove</button>}>
                    <button class="link danger" onClick={() => remove(f)}>Remove {f.user.name}?</button>
                    <button class="link" onClick={() => setConfirm(null)}>Keep</button>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ol>
      </section>
    </section>
  );
}

/** Header of an open DM (replaces the channel header). */
export function DmHeader(p: { search: () => void; saved: () => void }) {
  const other = () => currentDm()?.dmWith ?? "";
  const f = () => friendOf(other());
  return (
    <>
      <div class="eyebrow">Direct message{f() ? ` · @${f()!.username}` : ""}</div>
      <div class="head-row">
        <Avatar id={other()} size={40} />
        <h1 class="display title" title={userName(other())}>{userName(other())}</h1>
        <Show when={s.online[other()]}><span class="dm-online">Online</span></Show>
        <button class="icon-btn" title="Search this conversation" aria-label="Search this conversation" onClick={p.search}><SearchIcon /></button>
        <button class="icon-btn" title="Saved messages" aria-label="Saved messages" onClick={p.saved}><BookmarkIcon /></button>
      </div>
    </>
  );
}

/** Shown instead of the composer when you can't message this person any more. */
export function DmClosed() {
  const other = () => currentDm()?.dmWith ?? "";
  const f = () => friendOf(other());
  return (
    <div class="dm-closed">
      <Show when={f()?.state === "outgoing"} fallback={
        <Show when={f()?.state === "incoming"} fallback={<span>You're not friends with {userName(other())} any more. Add them again to keep talking.</span>}>
          <span>{userName(other())} wants to be friends again.</span>
          <button class="pill solid" onClick={() => call("friend_respond", { userId: other(), accept: true }).catch(err)}>Accept</button>
        </Show>
      }>
        <span>Friend request sent. You can message {userName(other())} once they accept.</span>
      </Show>
    </div>
  );
}

/** Right column in friends mode: who's online. */
export function FriendsRail() {
  const online = createMemo(() => sortFriends(s.friends.filter((f) => f.state === "friends" && s.online[f.user.id])));
  return (
    <aside class="rail" aria-label="Online friends">
      <div class="eyebrow rail-head"><span class="rail-label">Online · </span>{online().length}</div>
      <ul>
        <For each={online()} fallback={<li class="rail-none muted small">No friends online</li>}>
          {(f) => (
            <li class="rail-click" onClick={() => openDm(f.user.id)} title={`Message ${f.user.name}`}>
              <span class="rail-av"><Avatar id={f.user.id} size={28} /><i class="rail-dot" /></span>
              <span class="rail-text">
                <span class="rail-name">{f.user.name}</span>
                <Show when={gameOf(f.user.id)}><span class="rail-sub game">Playing {gameOf(f.user.id)}</span></Show>
              </span>
            </li>
          )}
        </For>
      </ul>
    </aside>
  );
}
