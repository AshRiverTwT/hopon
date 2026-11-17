//! C ABI over `hopon-core` for the native shell (C# / WinUI 3 on Windows).
//!
//! Model: the shell starts the core once with a table of callbacks, subscribes
//! each window ("main", "overlay") to the event stream, and runs commands by
//! name. Everything is UTF-8 JSON, in the same shape the webview gets today
//! (`client/ui/src/types.ts` and `ipc.ts` document it).
//!
//! - Events: `{"t":"<kind>", ...}` objects, delivered to `on_event` with the
//!   sink id given to [`hopon_subscribe`].
//! - Commands: [`hopon_call`] queues one and returns at once; the result comes
//!   to `on_reply` with the same request id: `ok = 1` and the JSON result, or
//!   `ok = 0` and an error message (plain UTF-8, shown to the user as is).
//!
//! # Callback rules (read before implementing them)
//! - They run on the core's worker threads: marshal to the UI thread yourself
//!   (WinUI: `DispatcherQueue.TryEnqueue`). One exception: the first events of
//!   a subscription (prefs, session snapshot, anything buffered) are delivered
//!   synchronously inside `hopon_subscribe`, on the thread that called it.
//! - `main_hidden` is called for every event: return a flag the UI thread keeps
//!   up to date; don't query window state from it.
//! - Data pointers are valid only during the call: copy what you keep.
//! - Return quickly and do not call back into this library from inside a
//!   callback (events are delivered under the core's subscriber lock, so
//!   `hopon_subscribe`/`hopon_unsubscribe` from `on_event` would deadlock).
//!   Enqueue, return, and act from your own thread.
//!
//! Errors are returned as values, never by unwinding: release builds abort on
//! panic (see the workspace profile), so every input is validated here.

use hopon_core::core::Core;
use hopon_core::host::Host;
use hopon_core::ui::UiEvent;
use std::ffi::c_void;
use std::sync::{Arc, OnceLock};

/// Host callbacks. All are required (non-null).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HoponCallbacks {
    /// Passed back unchanged as the first argument of every callback.
    pub ctx: *mut c_void,
    /// One event (JSON) for the subscription `sink`.
    pub on_event: extern "C" fn(ctx: *mut c_void, sink: u32, json: *const u8, len: usize),
    /// The result of request `req`: `ok` 1 → JSON value, 0 → error message.
    pub on_reply: extern "C" fn(ctx: *mut c_void, req: u64, ok: u8, data: *const u8, len: usize),
    /// 1 if the main window is minimized or hidden to the tray.
    pub main_hidden: extern "C" fn(ctx: *mut c_void) -> u8,
    /// Flash the taskbar button if the main window isn't focused.
    pub request_attention: extern "C" fn(ctx: *mut c_void),
    /// Exit the app (an update was handed to the installer; `--perf-exit`).
    pub exit: extern "C" fn(ctx: *mut c_void, code: i32),
}

// The shell promises the callbacks are callable from any thread (see above).
unsafe impl Send for HoponCallbacks {}
unsafe impl Sync for HoponCallbacks {}

impl HoponCallbacks {
    // Methods, so closures capture the whole (Send) struct, not its raw `ctx`.
    fn event(&self, sink: u32, json: &[u8]) {
        (self.on_event)(self.ctx, sink, json.as_ptr(), json.len())
    }
    fn reply(&self, req: u64, ok: bool, data: &[u8]) {
        (self.on_reply)(self.ctx, req, ok as u8, data.as_ptr(), data.len())
    }
}

struct FfiHost(HoponCallbacks);

impl Host for FfiHost {
    fn main_hidden(&self) -> bool {
        (self.0.main_hidden)(self.0.ctx) != 0
    }
    fn request_attention(&self) {
        (self.0.request_attention)(self.0.ctx)
    }
    fn exit(&self, code: i32) {
        (self.0.exit)(self.0.ctx, code)
    }
}

struct State {
    core: Arc<Core>,
    cb: HoponCallbacks,
}

static STATE: OnceLock<State> = OnceLock::new();

/// Result codes.
pub const HOPON_OK: i32 = 0;
pub const HOPON_ALREADY_STARTED: i32 = 1;
pub const HOPON_NOT_STARTED: i32 = 2;
pub const HOPON_BAD_ARGUMENT: i32 = 3;
pub const HOPON_START_FAILED: i32 = 4;

/// Borrow `len` bytes at `ptr` as UTF-8 (`ptr` may be null when `len` is 0).
unsafe fn str_arg<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if len == 0 {
        return Some("");
    }
    if ptr.is_null() {
        return None;
    }
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).ok()
}

/// Version of this library (NUL-terminated, static). Must equal the shell's.
#[no_mangle]
pub extern "C" fn hopon_version() -> *const u8 {
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr()
}

/// Logs to stderr; `RUST_LOG` filters. A Windows GUI app has no stderr unless
/// started from a console, so this is for development. Optional; call at most
/// once, before `hopon_start`.
#[no_mangle]
pub extern "C" fn hopon_init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,livekit=warn,libwebrtc=warn".into()),
        )
        .try_init();
}

/// Write panics to `crash.log` in the data folder and show a message box.
#[no_mangle]
pub extern "C" fn hopon_install_crash_reporter() {
    hopon_core::guard::install_crash_reporter();
}

/// 1 if this is the only HopOn running; 0 if another one is (it was brought
/// to the front: exit quietly).
#[no_mangle]
pub extern "C" fn hopon_single_instance() -> u8 {
    hopon_core::guard::single_instance() as u8
}

/// Start the core and begin connecting. `data_dir` (UTF-8, not NUL-terminated):
/// where the cache and sign-in live; empty → the standard folder, shared with
/// the Tauri build (`%LOCALAPPDATA%\app.hopon.desktop`). Call once, early.
///
/// # Safety
/// `data_dir` must point to `data_dir_len` readable bytes (or be null with 0).
#[no_mangle]
pub unsafe extern "C" fn hopon_start(data_dir: *const u8, data_dir_len: usize, callbacks: HoponCallbacks) -> i32 {
    if STATE.get().is_some() {
        return HOPON_ALREADY_STARTED;
    }
    let Some(dir) = str_arg(data_dir, data_dir_len) else { return HOPON_BAD_ARGUMENT };
    let dir = if dir.is_empty() { hopon_core::guard::data_dir() } else { dir.into() };
    let core = match hopon_core::start(&dir) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("hopon_start: {e:#}");
            return HOPON_START_FAILED;
        }
    };
    let _ = core.host.set(Box::new(FfiHost(callbacks)));
    if STATE.set(State { core, cb: callbacks }).is_err() {
        return HOPON_ALREADY_STARTED;
    }
    HOPON_OK
}

/// Subscribe a window to events. `label`: "main" (gets everything, plus what
/// was buffered before it subscribed) or "overlay" (what the overlay shows).
/// Events arrive at `on_event` tagged with `sink`. Subscribing a label again
/// replaces its previous subscription. The first events (current prefs, the
/// session snapshot, and for "main" anything buffered) are delivered before
/// this returns, on the calling thread.
///
/// # Safety
/// `label` must point to `label_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn hopon_subscribe(sink: u32, label: *const u8, label_len: usize) -> i32 {
    let Some(st) = STATE.get() else { return HOPON_NOT_STARTED };
    let Some(label) = str_arg(label, label_len).filter(|l| !l.is_empty()) else { return HOPON_BAD_ARGUMENT };
    let cb = st.cb;
    st.core.attach_ui(
        label,
        Box::new(move |ev: UiEvent| match serde_json::to_vec(&ev) {
            Ok(json) => {
                cb.event(sink, &json);
                true
            }
            Err(e) => {
                tracing::error!("event not serializable: {e}");
                true
            }
        }),
    );
    HOPON_OK
}

/// Stop events for `label` (its window closed).
///
/// # Safety
/// `label` must point to `label_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn hopon_unsubscribe(label: *const u8, label_len: usize) -> i32 {
    let Some(st) = STATE.get() else { return HOPON_NOT_STARTED };
    let Some(label) = str_arg(label, label_len) else { return HOPON_BAD_ARGUMENT };
    st.core.detach_ui(label);
    HOPON_OK
}

/// Run command `name` with `args` (a JSON object, camelCase keys; empty = no
/// arguments) and, for `upload_file` / `set_avatar` / `set_banner`, the raw
/// bytes in `blob`. Returns at once (`HOPON_OK` = queued); the result goes to
/// `on_reply(req, ...)`. Inputs are copied before this returns.
///
/// # Safety
/// Each pointer must point to its length in readable bytes (or be null with 0).
#[no_mangle]
pub unsafe extern "C" fn hopon_call(
    req: u64,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    blob: *const u8,
    blob_len: usize,
) -> i32 {
    let Some(st) = STATE.get() else { return HOPON_NOT_STARTED };
    let Some(name) = str_arg(name, name_len).filter(|n| !n.is_empty()) else { return HOPON_BAD_ARGUMENT };
    let Some(args) = str_arg(args, args_len) else { return HOPON_BAD_ARGUMENT };
    let blob = match (blob.is_null(), blob_len) {
        (_, 0) => None,
        (true, _) => return HOPON_BAD_ARGUMENT,
        (false, n) => Some(std::slice::from_raw_parts(blob, n).to_vec()),
    };
    let name = name.to_owned();
    let args = args.to_owned();
    let core = st.core.clone();
    let cb = st.cb;
    hopon_core::rt::spawn(async move {
        let parsed = if args.trim().is_empty() {
            Ok(serde_json::Value::Null)
        } else {
            serde_json::from_str(&args).map_err(|e| format!("{name}: arguments are not JSON: {e}"))
        };
        let result = match parsed {
            Ok(v) => hopon_core::api::call(&core, &name, v, blob).await,
            Err(e) => Err(e),
        };
        match result {
            Ok(v) => cb.reply(req, true, &serde_json::to_vec(&v).unwrap_or_else(|_| b"null".to_vec())),
            Err(e) => cb.reply(req, false, e.as_bytes()),
        }
    });
    HOPON_OK
}

/// Pull the newest frame of a screen share you watch (`screen_watch`), as
/// BGRA (opaque) fitted inside `max_w` × `max_h`, written to `dst` with
/// stride width × 4. Synchronous and cheap when nothing changed: call it at
/// your display refresh.
///
/// Returns 1 and sets `out_w`/`out_h`/`out_seq` when a frame newer than
/// `last_seq` was written; 0 if there is nothing new (`out_w`/`out_h` then
/// hold the stream's own size, 0 × 0 before the first frame). A `dst` of
/// `max_w * max_h * 4` bytes always fits. Other values: `HOPON_*` errors.
///
/// # Safety
/// `user_id` must point to `user_id_len` readable bytes, `dst` to `dst_len`
/// writable bytes, and the `out_*` pointers to writable values.
#[no_mangle]
pub unsafe extern "C" fn hopon_screen_frame(
    user_id: *const u8,
    user_id_len: usize,
    last_seq: u64,
    dst: *mut u8,
    dst_len: usize,
    max_w: u32,
    max_h: u32,
    out_w: *mut u32,
    out_h: *mut u32,
    out_seq: *mut u64,
) -> i32 {
    let Some(st) = STATE.get() else { return HOPON_NOT_STARTED };
    let Some(user) = str_arg(user_id, user_id_len) else { return HOPON_BAD_ARGUMENT };
    if dst.is_null() || out_w.is_null() || out_h.is_null() || out_seq.is_null() {
        return HOPON_BAD_ARGUMENT;
    }
    let buf = std::slice::from_raw_parts_mut(dst, dst_len);
    match st.core.voice.screen.frame(user, last_seq, buf, max_w, max_h) {
        Some((w, h, seq)) => {
            *out_w = w;
            *out_h = h;
            *out_seq = seq;
            1
        }
        None => {
            let (w, h) = st.core.voice.screen.frame_size(user);
            *out_w = w;
            *out_h = h;
            0
        }
    }
}
