//! Games side panel: a child webview (not an iframe, so X-Frame-Options does
//! not apply) showing the game's real website. It exists only while the panel
//! is open, so idle RAM is unaffected.
//!
//! Security: the game webview has NO IPC — its label is in no capability. An
//! initialization script hooks the share paths (navigator.share, clipboard
//! writeText/write, execCommand('copy')) and reports the shared text by
//! briefly setting `document.title` to `HOPON_RESULT:<urlencoded text>`. Rust
//! sees the title change, validates the text against the game's pattern,
//! collapses duplicate events from one click, and posts it to the server's `general` channel. Page scripts (ads
//! included) can fake this channel, so validation is strict and the worst case
//! is a plausible-looking score message in your own name (and the server's
//! per-connection send rate limit still applies).

use crate::core::{Core, Res};
use crate::ui::{pid, UiEvent};
use hopon_shared::time::now_us;
use hopon_shared::{ChannelKind, Id};
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

pub const LABEL: &str = "games";

pub struct Game {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
}

pub const GAMES: &[Game] = &[
    Game { id: "wordle", name: "Wordle", url: "https://www.nytimes.com/games/wordle/index.html" },
    Game { id: "cryptic", name: "Minute Cryptic", url: "https://www.minutecryptic.com/" },
    Game { id: "krillion", name: "Krillion", url: "https://krillion.io/" },
];

const HOOK: &str = r#"
(() => {
  if (window.__hoponHooked) return; window.__hoponHooked = true;
  const report = (t) => {
    try {
      if (typeof t !== 'string') return;
      t = t.trim(); if (!t || t.length > 2000) return;
      if (window.top !== window) { try { window.top.postMessage({ __hopon: t }, '*'); } catch (e) {} return; }
      // Remember the page's real title (never one of our markers), so a
      // later restore can't re-announce an earlier result.
      if (!document.title.startsWith('HOPON_RESULT:')) window.__hoponTitle = document.title;
      const real = window.__hoponTitle || '';
      const sentinel = 'HOPON_RESULT:' + encodeURIComponent(t);
      document.title = sentinel;
      // WebView2 raises the title event asynchronously and reads the title
      // when it runs: restore late, and only if nothing else changed it.
      setTimeout(() => { if (document.title === sentinel) document.title = real; }, 1500);
    } catch (e) {}
  };
  if (window.top === window) {
    window.addEventListener('message', (e) => { if (e.data && typeof e.data.__hopon === 'string') report(e.data.__hopon); });
  }
  try {
    // Always present, so sites that feature-detect share use it.
    navigator.share = async (d) => { report([d && d.text, d && d.url].filter(Boolean).join('\n')); };
  } catch (e) {}
  try {
    const cb = navigator.clipboard;
    if (cb && cb.writeText) {
      const w = cb.writeText.bind(cb);
      cb.writeText = (t) => { report(String(t)); return w(t); };
    }
    if (cb && cb.write) {
      const w2 = cb.write.bind(cb);
      cb.write = async (items) => {
        try { for (const it of items) { if (it.types.includes('text/plain')) report(await (await it.getType('text/plain')).text()); } } catch (e) {}
        return w2(items);
      };
    }
  } catch (e) {}
  try {
    const ex = document.execCommand.bind(document);
    document.execCommand = function (c, ...a) {
      if (String(c).toLowerCase() === 'copy') {
        const el = document.activeElement;
        const v = el && typeof el.value === 'string' ? el.value.substring(el.selectionStart || 0, el.selectionEnd || el.value.length) : '';
        report(v || String(window.getSelection() || ''));
      }
      return ex(c, ...a);
    };
  } catch (e) {}
})();
"#;

/// Game URL. `HOPON_GAMES_TEST_URL` (tests only) points all games at local
/// stand-in pages: `<base><id>.html`.
fn url_for(g: &Game) -> String {
    match std::env::var("HOPON_GAMES_TEST_URL") {
        Ok(base) if !base.is_empty() => format!("{base}{}.html", g.id),
        _ => g.url.to_owned(),
    }
}

#[derive(Default)]
pub struct Games {
    /// Server whose `general` channel receives results.
    server: Mutex<Option<Id>>,
    game: Mutex<Option<&'static str>>,
    /// (text, when) of the last post: one Share click can fire more
    /// than one copy/share hook, so identical text within 3 s posts once.
    last_post: Mutex<Option<(String, i64)>>,
}

impl Games {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Validate shared text for a game. Returns the cleaned text and a dedupe key.
pub fn validate(game: &str, raw: &str) -> Option<(String, String)> {
    let text: String = raw.chars().filter(|c| *c == '\n' || !c.is_control()).take(1200).collect();
    let text = text.trim().to_owned();
    let first = text.lines().next()?.trim().to_owned();
    let lower = text.to_lowercase();
    let ok = match game {
        // "Wordle 1,234 3/6" (optionally "*" for hard mode).
        "wordle" => {
            let mut it = first.split_whitespace();
            it.next() == Some("Wordle")
                && it.next().map_or(false, |n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.'))
                && it.next().map_or(false, |s| {
                    let s = s.trim_end_matches('*');
                    s.len() == 3 && s.ends_with("/6") && matches!(s.as_bytes()[0], b'1'..=b'6' | b'X')
                })
        }
        "cryptic" => lower.contains("minute cryptic") || lower.contains("minutecryptic"),
        "krillion" => lower.contains("krillion"),
        _ => false,
    };
    ok.then(|| (text, format!("{game}|{first}")))
}

fn general_channel(core: &Core, server: Id) -> Option<Id> {
    let s = core.store.lock();
    let sv = s.servers.iter().find(|x| x.id == server)?;
    let text = sv.channels.iter().filter(|c| c.kind == ChannelKind::Text);
    text.clone().find(|c| c.name.eq_ignore_ascii_case("general")).or_else(|| text.min_by_key(|c| c.id)).map(|c| c.id)
}

async fn post_result(core: Arc<Core>, game: &'static str, raw: String) {
    let Some((text, _key)) = validate(game, &raw) else {
        tracing::info!("games: ignored share text from {game}");
        return;
    };
    // Re-sharing is allowed any number of times; only collapse the duplicate
    // events a single click produces.
    {
        let now = now_us();
        let mut last = core.games.last_post.lock();
        if last.as_ref().map_or(false, |(t, at)| *t == text && now - at < 3_000_000) {
            return;
        }
        *last = Some((text.clone(), now));
    }
    let server = *core.games.server.lock();
    let Some(ch) = server.and_then(|s| general_channel(&core, s)) else {
        core.emit(UiEvent::Error { message: "No text channel to post your result to".into() });
        return;
    };
    let nonce = (now_us() as u64) | 1;
    match core.send_message(ch, text, nonce, now_us(), None, vec![], vec![]) {
        Ok(()) => {
            let name = GAMES.iter().find(|g| g.id == game).map(|g| g.name).unwrap_or(game);
            core.emit(UiEvent::Error { message: format!("{name} result posted to general") });
        }
        Err(e) => core.emit(UiEvent::Error { message: e }),
    }
}

// These must be async: a sync command runs on the main thread, and creating
// or resizing a child webview from it deadlocks WebView2 on Windows.
#[tauri::command]
pub async fn games_open(app: tauri::AppHandle, core: tauri::State<'_, Arc<Core>>, game: String, server_id: String, x: f64, y: f64, w: f64, h: f64) -> Res<()> {
    let g = GAMES.iter().find(|g| g.id == game).ok_or("unknown game")?;
    *core.games.server.lock() = Some(pid(&server_id)?);
    let url: tauri::Url = url_for(g).parse().map_err(|e| format!("{e}"))?;
    if let Some(wv) = app.get_webview(LABEL) {
        if *core.games.game.lock() != Some(g.id) {
            wv.navigate(url).map_err(|e| e.to_string())?;
        }
        *core.games.game.lock() = Some(g.id);
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    *core.games.game.lock() = Some(g.id);
    let window = app.get_window("main").ok_or("no main window")?;
    let c = core.inner().clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .initialization_script_for_all_frames(HOOK)
        // Ads must not open windows; the game itself never needs one.
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_document_title_changed(move |_, title| {
            if let Some(enc) = title.strip_prefix("HOPON_RESULT:") {
                let raw = urlencoding_decode(enc);
                let game = c.games.game.lock().unwrap_or("");
                let c2 = c.clone();
                tauri::async_runtime::spawn(post_result(c2, game, raw));
            }
        });
    window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    Ok(())
}

/// The server whose `general` receives results follows the UI selection.
#[tauri::command]
pub fn games_server(core: tauri::State<'_, Arc<Core>>, server_id: String) -> Res<()> {
    *core.games.server.lock() = Some(pid(&server_id)?);
    Ok(())
}

#[tauri::command]
pub async fn games_bounds(app: tauri::AppHandle, x: f64, y: f64, w: f64, h: f64) -> Res<()> {
    if let Some(wv) = app.get_webview(LABEL) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Native webviews draw above the app's UI, so hide the game while a sheet or
/// overlay is open.
#[tauri::command]
pub async fn games_visible(app: tauri::AppHandle, visible: bool) -> Res<()> {
    if let Some(wv) = app.get_webview(LABEL) {
        if visible { wv.show() } else { wv.hide() }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Destroy the webview: its renderer process and memory go with it.
#[tauri::command]
pub async fn games_close(app: tauri::AppHandle, core: tauri::State<'_, Arc<Core>>) -> Res<()> {
    *core.games.game.lock() = None;
    if let Some(wv) = app.get_webview(LABEL) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open the current game's site in the system browser (fixed URLs only).
#[tauri::command]
pub fn games_open_external(game: String) -> Res<()> {
    let g = GAMES.iter().find(|g| g.id == game).ok_or("unknown game")?;
    open_in_browser(g.url)
}

/// Open an http(s) URL in the system browser. Anything else is refused, so a
/// message link can never launch a local program or file.
pub fn open_in_browser(url: &str) -> Res<()> {
    let parsed: tauri::Url = url.parse().map_err(|_| "not a valid link")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("only http and https links can be opened".into());
    }
    let url = parsed.as_str();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).creation_flags(0x0800_0000).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> Res<()> {
    open_in_browser(&url)
}

fn urlencoding_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordle_pattern() {
        let t = "Wordle 1,234 3/6\n\n⬛🟨⬛⬛⬛\n🟩🟩⬛🟩⬛\n🟩🟩🟩🟩🟩";
        assert!(validate("wordle", t).is_some());
        assert!(validate("wordle", "Wordle 1.234 X/6*\n⬛⬛⬛⬛⬛").is_some());
        assert!(validate("wordle", "Wordle 1,234 7/6").is_none());
        assert!(validate("wordle", "Buy cheap stuff").is_none());
        assert!(validate("wordle", "wordle 12 3/6").is_none());
        assert!(validate("cryptic", "I solved today's Minute Cryptic in 2 hints").is_some());
        assert!(validate("cryptic", "random ad text").is_none());
        assert!(validate("krillion", "Krillion #12 — 3 tries").is_some());
        assert!(validate("nope", "Krillion").is_none());
    }

    #[test]
    fn decode() {
        assert_eq!(urlencoding_decode("Wordle%201%2C2%0A%F0%9F%9F%A9"), "Wordle 1,2\n🟩");
        assert_eq!(urlencoding_decode("100%"), "100%");
    }
}
