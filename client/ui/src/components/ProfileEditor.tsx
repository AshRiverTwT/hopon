// Edit profile: one sheet in the app's settings layout (label | value rows).
// Your name shows in your colour as you pick it.
import { createResource, createSignal, For, Show } from "solid-js";
import { call } from "../ipc";
import { ACCENT_NAMES, ACCENTS, bannerUrl, toBannerBytes } from "../profile";
import { s, toast } from "../store";
import type { Profile } from "../types";
import { Avatar, toAvatarBytes } from "./Avatar";
import { Overlay } from "./Overlay";

const MAX_BIO = 190;

export function ProfileEditor(p: { close: () => void }) {
  const err = (e: unknown) => toast(String(e).replace(/^Error: /, ""));
  const [profile, { refetch }] = createResource(() => s.user?.id, (userId) => call<Profile>("get_profile", { userId, serverId: null }).catch(() => null));
  const [name, setName] = createSignal(s.user?.name ?? "");
  const [bio, setBio] = createSignal<string | null>(null);
  const [accent, setAccent] = createSignal(s.user?.accent ?? 0);
  const [saving, setSaving] = createSignal(false);
  const bioNow = () => bio() ?? profile()?.bio ?? "";
  const banner = () => { const pr = profile(); return pr && s.user ? bannerUrl(s.user.id, pr.bannerV) : null; };
  const dirty = () => name().trim() !== (s.user?.name ?? "") || accent() !== (s.user?.accent ?? 0) || (bio() !== null && bio() !== (profile()?.bio ?? ""));
  let avatarFile!: HTMLInputElement;
  let bannerFile!: HTMLInputElement;

  const pick = async (input: HTMLInputElement, isBanner: boolean) => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    try {
      if (isBanner) { await call("set_banner", { data: await toBannerBytes(f) }); void refetch(); }
      else await call("set_avatar", { data: await toAvatarBytes(f) });
    } catch (e) { err(e); }
  };
  const save = async () => {
    if (saving() || !s.user) return;
    setSaving(true);
    try {
      if (name().trim() !== s.user.name) await call("set_display_name", { name: name().trim() });
      await call("set_profile", { bio: bioNow().trim(), accent: accent() });
      toast("Profile saved");
      p.close();
    } catch (e) { err(e); }
    finally { setSaving(false); }
  };

  return (
    <Overlay title="Profile" close={p.close}>
      <div class="rows">
        <div class="row">
          <span class="eyebrow">Picture</span>
          <div class="row-body inline">
            <Avatar id={s.user?.id ?? ""} size={44} />
            <button class="pill" onClick={() => avatarFile.click()}>{s.user?.avatarV ? "Change" : "Upload"}</button>
            <Show when={s.user?.avatarV}><button class="link" onClick={() => call("set_avatar", { data: [] }).catch(err)}>Remove</button></Show>
          </div>
        </div>
        <div class="row">
          <span class="eyebrow">Banner</span>
          <div class="row-body inline">
            <span class="banner-thumb" style={banner() ? { "background-image": `url(${banner()})` } : { background: ACCENTS[accent()] || "var(--cream-10)" }} />
            <button class="pill" onClick={() => bannerFile.click()}>{profile()?.bannerV ? "Change" : "Upload"}</button>
            <Show when={profile()?.bannerV}><button class="link" onClick={() => call("set_banner", { data: [] }).then(() => refetch()).catch(err)}>Remove</button></Show>
          </div>
        </div>
        <div class="row">
          <span class="eyebrow">Colour</span>
          <div class="row-body">
            <div class="swatches" role="radiogroup" aria-label="Profile colour">
              <For each={ACCENTS}>
                {(c, i) => (
                  <button role="radio" aria-checked={accent() === i()} aria-label={ACCENT_NAMES[i()]} title={ACCENT_NAMES[i()]}
                    class="swatch" classList={{ on: accent() === i(), none: !c }} style={c ? { background: c } : {}} onClick={() => setAccent(i())} />
                )}
              </For>
            </div>
          </div>
        </div>
        <label class="row">
          <span class="eyebrow">Display name</span>
          <div class="row-body">
            <input class="line big pedit-name" style={{ color: ACCENTS[accent()] || undefined }} value={name()} maxLength={32} placeholder={s.username}
              onInput={(e) => setName(e.currentTarget.value)} />
            <span class="muted small">@{s.username}</span>
          </div>
        </label>
        <label class="row">
          <span class="eyebrow">About me</span>
          <div class="row-body">
            <textarea class="line pedit-bio" rows={3} maxLength={MAX_BIO} placeholder="A line or two about you" value={bioNow()} onInput={(e) => setBio(e.currentTarget.value)} />
            <span class="muted small">{bioNow().length} / {MAX_BIO}</span>
          </div>
        </label>
        <div class="row end">
          <span />
          <div class="row-body inline">
            <button class="pill solid" disabled={saving() || !dirty()} onClick={() => void save()}>{saving() ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
      <input ref={avatarFile} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={() => void pick(avatarFile, false)} />
      <input ref={bannerFile} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={() => void pick(bannerFile, true)} />
    </Overlay>
  );
}
