// Profile card: opens next to any name or picture you click. Banner (image
// or accent colour), presence, custom status, what they're doing, bio, dates,
// and one row of actions.
import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { call } from "../ipc";
import { closeProfile, accentOf, bannerUrl, customOf, fmtDate, gameOf, openProfileEditor, presenceOf, profileCard, SHOWN_LABEL } from "../profile";
import { friendOf, openDm, s, toast, userName } from "../store";
import type { Profile } from "../types";
import { Avatar } from "./Avatar";
import { PresenceDot, StatusLine } from "./PresenceDot";
import { VolumeSlider } from "./Stage";

const W = 320;

export function ProfileCardHost() {
  return (
    <Show when={profileCard()} keyed>
      {(at) => <Card userId={at.userId} serverId={at.serverId} rect={at.rect} />}
    </Show>
  );
}

function Card(p: { userId: string; serverId: string | null; rect: { left: number; top: number; right: number; bottom: number } }) {
  let el!: HTMLDivElement;
  const err = (e: unknown) => toast(String(e).replace(/^Error: /, ""));
  const me = () => s.user?.id === p.userId;
  const [profile] = createResource(() => [p.userId, p.serverId] as const, ([userId, serverId]) =>
    call<Profile>("get_profile", { userId, serverId }).catch(() => null));
  const user = () => (me() ? s.user : s.users[p.userId]) ?? profile()?.user ?? null;
  const banner = () => { const pr = profile(); return pr ? bannerUrl(p.userId, pr.bannerV) : null; };
  const shown = () => presenceOf(p.userId);
  const custom = () => customOf(p.userId);
  const voiceRoom = () => {
    const ch = (me() ? s.voice.channelId : s.presence[p.userId]?.channelId) ?? null;
    return ch ? s.servers.flatMap((x) => x.channels).find((c) => c.id === ch)?.name ?? "" : "";
  };
  const sameRoom = () => !me() && !!s.voice.channelId && s.presence[p.userId]?.channelId === s.voice.channelId;
  const friend = () => friendOf(p.userId);
  const server = () => s.servers.find((x) => x.id === p.serverId) ?? null;
  const canKick = () => !me() && !!server() && server()!.ownerId === s.user?.id;
  const [confirmKick, setConfirmKick] = createSignal(false);

  // Beside the anchor: to its left when it's on the right half, else to its right.
  const pos = () => {
    const r = p.rect;
    const left = r.left > window.innerWidth / 2 ? r.left - W - 12 : r.right + 12;
    return { left: `${Math.max(8, Math.min(window.innerWidth - W - 8, left))}px`, top: `${Math.max(8, r.top - 8)}px` };
  };
  // Keep it on screen once its height is known.
  createEffect(() => {
    profile();
    queueMicrotask(() => {
      if (!el) return;
      const over = el.getBoundingClientRect().bottom - (window.innerHeight - 8);
      if (over > 0) el.style.top = `${Math.max(8, el.offsetTop - over)}px`;
    });
  });
  const away = (e: PointerEvent) => { if (!el.contains(e.target as Node)) closeProfile(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeProfile(); } };
  setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  document.addEventListener("keydown", key, true);
  onCleanup(() => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); });

  const addFriend = () => {
    const name = profile()?.username;
    if (name) call("friend_request", { username: name }).then(() => toast(`Friend request sent to ${user()?.name ?? name}`)).catch(err);
  };
  const message = () => { closeProfile(); openDm(p.userId); };

  return (
    <Portal>
      <div class="pcard" ref={el} style={{ ...pos(), "--accent": accentOf(p.userId) || "var(--hot)" }} role="dialog" aria-label={`${user()?.name ?? "Profile"}`}>
        <Show when={banner()}>
          <div class="pcard-banner" style={{ "background-image": `url(${banner()})` }} />
        </Show>
        <div class="pcard-head">
          <span class="pcard-av rail-av"><Avatar id={p.userId} size={52} /><PresenceDot id={p.userId} /></span>
          <div class="pcard-id">
            <div class="pcard-name display">{user()?.name ?? userName(p.userId)}</div>
            <div class="pcard-sub">
              <Show when={profile()}><span>@{profile()!.username}</span></Show>
              <span class={`pcard-mode ${shown()}`}>{SHOWN_LABEL[shown()]}</span>
            </div>
          </div>
        </div>

        <Show when={custom() || gameOf(p.userId) || voiceRoom()}>
          <div class="pcard-sec">
            <Show when={custom()}>{(c) => <div class="pcard-status"><StatusLine emoji={c().emoji} text={c().text} /></div>}</Show>
            <Show when={gameOf(p.userId)} fallback={<Show when={voiceRoom()}><div class="eyebrow">In voice · {voiceRoom()}</div></Show>}>
              <div class="eyebrow pcard-game">Playing {gameOf(p.userId)}</div>
            </Show>
          </div>
        </Show>

        <Show when={profile()?.bio}><div class="pcard-sec"><p class="pcard-bio">{profile()!.bio}</p></div></Show>

        <Show when={profile()}>
          <dl class="pcard-sec pcard-dates">
            <div><dt class="eyebrow">Member since</dt><dd>{fmtDate(profile()!.createdAt)}</dd></div>
            <Show when={profile()!.joinedAt}><div><dt class="eyebrow">Joined</dt><dd>{fmtDate(profile()!.joinedAt)}</dd></div></Show>
          </dl>
        </Show>

        <Show when={sameRoom()}><div class="pcard-sec"><VolumeSlider userId={p.userId} /></div></Show>

        <div class="pcard-sec pcard-actions">
          <Show when={me()} fallback={
            <>
              <Show when={friend()?.state === "friends"}><button class="pill solid" onClick={message}>Message</button></Show>
              <Show when={!friend() && profile()}><button class="pill" onClick={addFriend}>Add friend</button></Show>
              <Show when={friend()?.state === "outgoing"}><span class="eyebrow">Request sent</span></Show>
              <Show when={friend()?.state === "incoming"}>
                <button class="pill solid" onClick={() => call("friend_respond", { userId: p.userId, accept: true }).catch(err)}>Accept</button>
              </Show>
            </>
          }>
            <button class="pill" onClick={openProfileEditor}>Edit profile</button>
          </Show>
          <Show when={canKick()}>
            <Show when={confirmKick()} fallback={<button class="link pcard-kick" onClick={() => setConfirmKick(true)}>Remove</button>}>
              <button class="link danger pcard-kick" onClick={() => { closeProfile(); call("kick_member", { serverId: p.serverId, userId: p.userId }).catch(err); }}>Remove from {server()!.name}?</button>
            </Show>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
