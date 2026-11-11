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
      <form class="card" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        <h1>HopOn</h1>
        <label>Username</label>
        <input autofocus autocomplete="username" value={user()} onInput={(e) => setUser(e.currentTarget.value)} />
        <label>Password</label>
        <input type="password" autocomplete="current-password" value={pw()} onInput={(e) => setPw(e.currentTarget.value)} />
        <Show when={err()}><p class="err">{err()}</p></Show>
        <div class="row">
          <button class="primary" type="submit" disabled={busy() || !user() || !pw()}>Log in</button>
          <button type="button" disabled={busy() || !user() || pw().length < 8} onClick={() => submit(true)}>Sign up</button>
        </div>
        <details>
          <summary class="muted small">Server: {url() ?? cfg()?.url} · {s.conn.state}</summary>
          <input value={url() ?? cfg()?.url ?? ""} onInput={(e) => setUrl(e.currentTarget.value)} placeholder="wss://chat.example.com/ws" />
        </details>
      </form>
    </div>
  );
}
