//! The core's tokio runtime. The core owns it, so it runs the same under any
//! host (the Tauri shell, a native WinUI shell through FFI, tests). A host that
//! has its own async runtime (Tauri) is pointed at this one with `handle()`.

use std::future::Future;
use std::sync::OnceLock;
use tokio::runtime::{Handle, Runtime};
use tokio::task::JoinHandle;

static RT: OnceLock<Runtime> = OnceLock::new();

pub fn handle() -> Handle {
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("hopon-core")
            .build()
            .expect("tokio runtime")
    })
    .handle()
    .clone()
}

pub fn spawn<F>(fut: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(fut)
}

pub fn block_on<F: Future>(fut: F) -> F::Output {
    handle().block_on(fut)
}
