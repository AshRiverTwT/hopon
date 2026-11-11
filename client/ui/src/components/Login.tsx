import { createResource, createSignal, Show } from "solid-js";
import { call } from "../ipc";
import { s } from "../store";

export default function Login() {
  const [cfg] = createResource(() => call<{ url: string }>("get_config"));
  const [user, setUser] = createSignal("");
  const [pw, setPw] = createSignal("");
  const [url, setUrl] = createSignal<string | null>(null);
  const [err, setErr] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [showServer, setShowServer] = createSignal(false);

  const submit = async (signup: boolean) => {
    setErr(""); setBusy(true);
    try {
      const u = url();
      if (u !== null && u !== cfg()?.url) await call("set_server_url", { url: u });
      await call(signup ? "signup" : "login", { username: user(), password: pw() });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="login">
      <div class="login-mark display" aria-hidden="true"><span>Hop</span><span>On</span></div>
      <form class="login-form" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        <div class="eyebrow">Sign in</div>
        <input class="line big" placeholder="Username" autofocus autocomplete="username" value={user()} onInput={(e) => setUser(e.currentTarget.value)} />
        <input class="line big" placeholder="Password" type="password" autocomplete="current-password" value={pw()} onInput={(e) => setPw(e.currentTarget.value)} />
        <Show when={err()}><p class="err">{err()}</p></Show>
        <div class="field-row">
          <button class="pill solid" type="submit" disabled={busy() || !user() || !pw()}>Log in</button>
          <button class="pill" type="button" disabled={busy() || !user() || pw().length < 8} onClick={() => submit(true)}>Create account</button>
        </div>
        <button type="button" class="link" onClick={() => setShowServer((v) => !v)}>
          Server · {url() ?? cfg()?.url} · <span classList={{ warn: s.conn.state !== "online" }}>{s.conn.state}</span>
        </button>
        <Show when={showServer()}>
          <input class="line" value={url() ?? cfg()?.url ?? ""} onInput={(e) => setUrl(e.currentTarget.value)} placeholder="wss://chat.example.com/ws" />
        </Show>
      </form>
    </div>
  );
}
